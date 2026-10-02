/**
 * gmail.ts — IPC handler registration for the mail client (`gmail:*`
 * channels, whichever provider an account uses).
 *
 * All channels proxy to services (account-store, mail-store, mail-sync) and
 * the account's provider (providers/). Handlers are thin; business logic
 * lives in services.
 */

import {
  scheduleSend,
  snoozeThread,
  listSchedules,
  cancelSchedule,
  removeAccountSchedules,
  futureTime,
} from "../services/mail-schedule.js";

import { GMAIL_CAPABILITIES, IMAP_CAPABILITIES } from "@otter-mail/contracts";

import { fromBase64 } from "../bytes.js";
import { SignInCancelledError } from "../google.js";
import { broadcast, handle, registeredHandlers } from "../ipc.js";
import { platform } from "../platform.js";
import { findProvider, isSignedIn, providerFor } from "../providers/index.js";
import {
  getAccount,
  listAccounts,
  providerKindOf,
  removeAccount as storeRemoveAccount,
  updateAccount as storeUpdateAccount,
} from "../services/account-store.js";
import {
  getAttachmentBytes,
  getAttachmentData,
  saveAttachment,
} from "../services/attachment-cache.js";
import { proxyRemoteImage } from "../services/image-proxy.js";
import { deleteImapPassword } from "../services/imap-passwords.js";
import { MAX_ATTACHMENT_TOTAL_BYTES, pickComposeAttachments } from "../services/outgoing.js";
import * as mailStore from "../services/mail-store.js";
import { IPC_WRITE_BUDGET_MS, atMost, runAsTask, settleGmailWrite, sleep } from "./ipc-budget.js";
import { forgetLiveCursors, pageWithLiveFill, reconcileUnread } from "./live-paging.js";
import { trackLabelWrite } from "../services/pending-label-writes.js";
import {
  draftSessionId,
  mirrorDraft,
  queueDraftSave,
  rememberSessionDraft,
  sessionDraftId,
  takeSessionDraft,
} from "./draft-sessions.js";
import * as mailSync from "../services/mail-sync.js";
import { accountAdded, accountEdited, accountRemoved } from "../services/linked-accounts.js";
import { getSenderAvatar } from "../services/avatar-store.js";
import { updateDockBadge } from "../services/notifier.js";
import { getSettings, updateSettings, type AppSettings } from "../services/settings-store.js";
import { preferenceChanged } from "../services/preferences.js";
import { refreshProfiles } from "../services/google-profile.js";
import { refreshSignatures, saveSignature } from "../services/signatures.js";
import * as viewsStore from "../services/views-store.js";
import { ALL_MAIL_LABEL_ID } from "../types.js";
import type { ComposeAttachment, MailView, ViewRule } from "../types.js";

const LOCAL_PAGE_SIZE = 50;

/** Removes an account from this device: its sync, sign-in, and cached mail. */
export async function removeLocalAccount(accountId: string): Promise<void> {
  removeAccountSchedules(accountId);
  mailSync.forgetAccount(accountId);
  forgetLiveCursors(accountId);
  await findProvider(accountId)?.removeAccount(accountId);
  if (providerKindOf(accountId) === "imap") await deleteImapPassword(accountId);
  await storeRemoveAccount(accountId);
  mailStore.removeAccountData(accountId);
  updateDockBadge();
}

/** Re-reads every label from the server (names, colors, counts) into the cache. */
async function refreshLabels(accountId: string): Promise<void> {
  mailStore.upsertLabels(accountId, await providerFor(accountId).listLabels(accountId));
}

/** Re-reads Gmail's labels for messages after a trash/untrash (Gmail may
 *  also drop INBOX etc.) and recounts the labels involved. */
async function refreshMetadata(accountId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const before = new Set(ids.flatMap((id) => mailStore.getMessageLabelIds(accountId, id) ?? []));
  const fresh = await providerFor(accountId).getSummaries(accountId, ids);
  mailStore.upsertMessages(accountId, fresh);
  for (const m of fresh) for (const l of m.labelIds) before.add(l);
  mailStore.recountLabels(accountId, [...before]);
  updateDockBadge();
}

/** Applies a label change to the local cache and returns an exact undo: only
 *  labels that actually changed on each message are restored, so undoing
 *  "remove INBOX" never adds INBOX to a thread's sent replies. */
function applyLocalLabelChange(
  accountId: string,
  messageIds: string[],
  add: string[],
  remove: string[],
): () => void {
  const undo = messageIds.flatMap((id) => {
    const prior = mailStore.getMessageLabelIds(accountId, id);
    if (!prior) return [];
    const reAdd = remove.filter((l) => prior.includes(l));
    const reRemove = add.filter((l) => !prior.includes(l));
    mailStore.applyLabelChange(accountId, id, add, remove);
    return [{ id, reAdd, reRemove }];
  });
  updateDockBadge();
  return () => {
    for (const u of undo) mailStore.applyLabelChange(accountId, u.id, u.reAdd, u.reRemove);
    updateDockBadge();
  };
}

/** Each message's latest Gmail write (settled either way), for the next one to wait on. */
const lastWrites = new Map<string, Promise<void>>();

/**
 * Runs `write` once the earlier writes to any of these messages are done, so
 * Gmail gets them in the order the user made them: trash then undo must not
 * land as untrash then trash (the mail would stay trashed, and "Undone" lie).
 */
function afterEarlierWrites(
  accountId: string,
  messageIds: string[],
  write: () => Promise<unknown>,
): Promise<unknown> {
  const keys = messageIds.map((id) => `${accountId}:${id}`);
  const earlier = keys.flatMap((key) => lastWrites.get(key) ?? []);
  const running = Promise.all(earlier).then(write);
  const done = running.then(
    () => {},
    () => {},
  );
  for (const key of keys) lastWrites.set(key, done);
  void done.then(() => {
    for (const key of keys) if (lastWrites.get(key) === done) lastWrites.delete(key);
  });
  return running;
}

/** Mirrors a label change locally, then settles its Gmail write within the IPC
 *  budget. While the write is pending, reads from Gmail keep the change (see
 *  pending-label-writes); if it fails, the local change is reverted. Writes to
 *  the same messages reach Gmail in order. */
function settleLabelWrite(
  channel: string,
  accountId: string,
  messageIds: string[],
  add: string[],
  remove: string[],
  write: () => Promise<unknown>,
): Promise<{ ok: true; pending?: boolean }> {
  const revert = applyLocalLabelChange(accountId, messageIds, add, remove);
  const tracked = trackLabelWrite(accountId, messageIds, add, remove);
  const running = afterEarlierWrites(accountId, messageIds, write);
  running.then(tracked.settled, tracked.dropped);
  return settleGmailWrite(channel, running, revert);
}

function parseRules(raw: unknown): ViewRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r?.accountId === "string")
    .map((r) => ({
      accountId: r.accountId as string,
      allOf: Array.isArray(r.allOf)
        ? r.allOf.filter((x): x is string => typeof x === "string")
        : [],
      noneOf: Array.isArray(r.noneOf)
        ? r.noneOf.filter((x): x is string => typeof x === "string")
        : [],
    }));
}

// ── Type guards ───────────────────────────────────────────────────────────────

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid parameter: "${name}" must be a non-empty string.`);
  }
  return value;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function parseAttachments(raw: unknown): ComposeAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .map((a) => a as Record<string, unknown>)
    .filter(
      (a) =>
        typeof a?.name === "string" &&
        typeof a?.mimeType === "string" &&
        typeof a?.base64 === "string",
    )
    .map((a) => ({
      name: a.name as string,
      mimeType: a.mimeType as string,
      size: typeof a.size === "number" ? a.size : Math.floor(((a.base64 as string).length * 3) / 4),
      base64: a.base64 as string,
    }));
  return list.length > 0 ? list : undefined;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerGmailHandlers(): void {
  handle("gmail:listSchedules", () => listSchedules());
  handle("gmail:scheduleMessage", (params: unknown) => {
    const p = params as Record<string, unknown>;
    futureTime(p?.scheduledAt);
    return runAsTask(asString(p?.taskId), async () =>
      registeredHandlers().get("gmail:sendMessage")!(params),
    );
  });
  handle("gmail:cancelSchedule", (params: unknown) => {
    const p = params as Record<string, unknown>;
    return runAsTask(asString(p?.taskId), () => cancelSchedule(assertString(p?.id, "id")));
  });
  handle("gmail:snoozeThread", (params: unknown) => {
    const p = params as Record<string, unknown>;
    return runAsTask(asString(p?.taskId), () =>
      snoozeThread(
        assertString(p?.accountId, "accountId"),
        assertString(p?.threadId, "threadId"),
        futureTime(p?.dueAt),
      ),
    );
  });
  // gmail:listAccounts
  handle("gmail:listAccounts", async () => {
    console.log("[gmail:listAccounts]", {});
    try {
      const accounts = await listAccounts();
      return accounts.map((account) => ({
        ...account,
        capabilities: account.provider === "imap" ? IMAP_CAPABILITIES : GMAIL_CAPABILITIES,
        ...(isSignedIn(account) ? {} : { signedOut: true }),
      }));
    } catch (err) {
      console.log("[gmail:listAccounts] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:addAccount — opens browser OAuth flow; `email` signs an existing account back in
  handle("gmail:addAccount", async (params: unknown) => {
    const email = asString((params as Record<string, unknown> | undefined)?.email);
    console.log("[gmail:addAccount]", { email });
    try {
      const account = await platform().google.addAccount(email);
      mailSync.syncAccount(account.id, { force: true });
      void accountAdded(account);
      void refreshSignatures();
      // The browser sign-in outlasts the renderer's IPC timeout, so the caller
      // usually never sees this return — tell every window to reload accounts.
      broadcast("gmail:accounts-changed");
      return account;
    } catch (err) {
      // The user cancelled: not an error to show. The renderer gets null.
      if (err instanceof SignInCancelledError) return null;
      console.log("[gmail:addAccount] error", { error: String(err) });
      throw err;
    }
  });

  // Settings → Accounts opening: signatures, and names and pictures, from Google.
  handle("gmail:refreshSignatures", async () => {
    void refreshSignatures();
    void refreshProfiles();
  });

  handle("gmail:cancelAddAccount", async () => {
    platform().google.cancelSignIn();
  });

  // gmail:removeAccount
  handle("gmail:removeAccount", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:removeAccount]", { accountId: p?.accountId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const account = await getAccount(accountId);
      await removeLocalAccount(accountId);
      if (account) void accountRemoved(account.email);
      return { ok: true as const };
    } catch (err) {
      console.log("[gmail:removeAccount] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:updateAccount — persists a user-set display name / color for an account,
  // then notifies every window so the sidebar/message list pick up the change live.
  handle("gmail:updateAccount", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:updateAccount]", { accountId: p?.accountId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const displayName = asString(p?.displayName);
      const color = asString(p?.color);
      const signature = asString(p?.signature);
      let updated = await storeUpdateAccount(accountId, { displayName, color });
      if (signature !== undefined) updated = await saveSignature(updated, signature);
      broadcast("gmail:accounts-changed");
      if (displayName !== undefined || color !== undefined) {
        void accountEdited(updated, ["displayName", "color"]);
      }
      updateDockBadge();
      return updated;
    } catch (err) {
      console.log("[gmail:updateAccount] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:listLabels — served from the local cache; sync refreshes in background
  handle("gmail:listLabels", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:listLabels]", { accountId: p?.accountId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      mailSync.syncAccount(accountId);
      const local = mailStore.getLabels(accountId);
      if (local.length > 0) return local;
      // Cold cache: fetch once live so the sidebar isn't empty on first launch.
      const labels = await providerFor(accountId).listLabels(accountId);
      mailStore.upsertLabels(accountId, labels);
      return labels;
    } catch (err) {
      console.log("[gmail:listLabels] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:createLabel
  handle("gmail:createLabel", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:createLabel]", { accountId: p?.accountId, name: p?.name });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const name = assertString(p?.name, "name");
      // Gmail assigns the id, so this one waits; mirror it so the renderer's
      // refetch (served from the cache) keeps showing the new label.
      const label = await providerFor(accountId).createLabel(accountId, name);
      mailStore.putLabel(accountId, label);
      return label;
    } catch (err) {
      console.log("[gmail:createLabel] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:updateLabel — rename (cascades to nested labels) and/or recolor
  handle("gmail:updateLabel", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:updateLabel]", {
      accountId: p?.accountId,
      labelId: p?.labelId,
      name: p?.name,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const labelId = assertString(p?.labelId, "labelId");
      const name = asString(p?.name);
      const colorRaw = p?.color as Record<string, unknown> | undefined;
      const color = colorRaw
        ? {
            backgroundColor: assertString(colorRaw.backgroundColor, "color.backgroundColor"),
            textColor: assertString(colorRaw.textColor, "color.textColor"),
          }
        : undefined;
      // Mirror first, answer inside the IPC budget; the full label refresh
      // (one request per label) runs after Gmail confirms.
      const revert = mailStore.editLabelLocally(accountId, labelId, { name, color });
      return await settleGmailWrite(
        "gmail:updateLabel",
        providerFor(accountId)
          .updateLabel(accountId, { labelId, name, color })
          .then(() => refreshLabels(accountId)),
        revert,
      );
    } catch (err) {
      console.log("[gmail:updateLabel] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:deleteLabel — removes the label everywhere (sub-labels survive)
  handle("gmail:deleteLabel", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:deleteLabel]", { accountId: p?.accountId, labelId: p?.labelId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const labelId = assertString(p?.labelId, "labelId");
      const revert = mailStore.removeLabelLocally(accountId, labelId);
      return await settleGmailWrite(
        "gmail:deleteLabel",
        providerFor(accountId)
          .deleteLabel(accountId, labelId)
          .then(() => refreshLabels(accountId)),
        revert,
      );
    } catch (err) {
      console.log("[gmail:deleteLabel] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:listMessages", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:listMessages]", {
      accountId: p?.accountId,
      labelIds: p?.labelIds,
      pageToken: p?.pageToken,
      maxResults: p?.maxResults,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const labelIds = asStringArray(p?.labelIds);
      const pageToken = asString(p?.pageToken);
      const maxResults = asNumber(p?.maxResults) ?? LOCAL_PAGE_SIZE;

      const labelId = labelIds?.[0] ?? "INBOX";
      const offset = pageToken ? Number.parseInt(pageToken, 10) || 0 : 0;

      // Gmail's counter says there's unread mail we don't have yet (e.g. the
      // first full sync is still running): pull it in so the list and its
      // Unread filter show what the badge counts.
      if (offset === 0) await atMost(reconcileUnread(accountId, labelId), 1000);

      mailSync.syncAccount(accountId);

      // All Mail has no Gmail label: live-fill it from the unfiltered listing.
      const liveLabelId = labelId === ALL_MAIL_LABEL_ID ? null : labelId;
      const page = await pageWithLiveFill([{ accountId, labelId: liveLabelId }], maxResults, () =>
        mailStore.getThreadsPage(accountId, labelId, offset, maxResults),
      );
      return {
        messages: page.messages,
        // Continue after the rows actually returned: short pages grow as the
        // cache fills, and a fixed stride would skip what arrived in between.
        nextPageToken: page.more ? String(offset + page.messages.length) : undefined,
      };
    } catch (err) {
      console.log("[gmail:listMessages] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:searchMessages — instant local full-text search (FTS5 over the mail
  // cache). accountId omitted = search every account; message-level rows.
  // labelId/rules restrict to the current view; starred/important/
  // hasAttachments/withinDays are structured filters that also work with an
  // empty q.
  handle("gmail:searchMessages", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:searchMessages]", {
      q: p?.q,
      accountId: p?.accountId,
      labelId: p?.labelId,
      ruleCount: Array.isArray(p?.rules) ? p.rules.length : undefined,
      starred: p?.starred,
      important: p?.important,
      hasAttachments: p?.hasAttachments,
      withinDays: p?.withinDays,
      pageToken: p?.pageToken,
    });
    try {
      const q = asString(p?.q) ?? "";
      const accountId = asString(p?.accountId) ?? null;
      const labelId = asString(p?.labelId);
      const rules = p?.rules === undefined ? undefined : parseRules(p.rules);
      const pageToken = asString(p?.pageToken);
      const maxResults = asNumber(p?.maxResults) ?? LOCAL_PAGE_SIZE;
      const offset = pageToken ? Number.parseInt(pageToken, 10) || 0 : 0;

      const page = mailStore.searchMessages(q, accountId, offset, maxResults, {
        labelId,
        rules,
        starred: p?.starred === true || undefined,
        important: p?.important === true || undefined,
        hasAttachments: p?.hasAttachments === true || undefined,
        withinDays: asNumber(p?.withinDays),
      });
      return {
        messages: page.messages,
        nextPageToken: page.hasMore ? String(offset + maxResults) : undefined,
      };
    } catch (err) {
      console.log("[gmail:searchMessages] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:listCombinedMessages — cross-account query for the "Combined" mailbox.
  // `rules` are per-account: a message matches a rule when it has every label in
  // allOf (empty = any mail from the account) and none in noneOf; rules union.
  // Reads the local store and refreshes all accounts in the background.
  handle("gmail:listCombinedMessages", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:listCombinedMessages]", {
      ruleCount: Array.isArray(p?.rules) ? p.rules.length : 0,
      pageToken: p?.pageToken,
    });
    try {
      const rules = parseRules(p?.rules);
      const pageToken = asString(p?.pageToken);
      const maxResults = asNumber(p?.maxResults) ?? LOCAL_PAGE_SIZE;
      const offset = pageToken ? Number.parseInt(pageToken, 10) || 0 : 0;

      void mailSync.syncAllAccounts();

      const sources = rules.map((r) => ({ accountId: r.accountId, labelId: r.allOf[0] ?? null }));
      const page = await pageWithLiveFill(sources, maxResults, () =>
        mailStore.getCombinedThreadsByRules(rules, offset, maxResults),
      );
      return {
        messages: page.messages,
        nextPageToken: page.more ? String(offset + page.messages.length) : undefined,
      };
    } catch (err) {
      console.log("[gmail:listCombinedMessages] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:countCombinedMessages — total/unread counts for a rule set (local store)
  handle("gmail:countCombinedMessages", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      return mailStore.countCombinedByRules(parseRules(p?.rules));
    } catch (err) {
      console.log("[gmail:countCombinedMessages] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:listViews / saveView / deleteView / resetView — Combined-view store
  // (userData/views.json); mutations broadcast gmail:views-changed so every
  // window's view queries refresh.
  handle("gmail:listViews", async () => {
    try {
      return await viewsStore.listViews();
    } catch (err) {
      console.log("[gmail:listViews] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:saveView", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:saveView]", { id: p?.id, name: p?.name });
    try {
      const name = assertString(p?.name, "name");
      const id = typeof p?.id === "string" ? p.id : undefined;
      const view = await viewsStore.saveView({
        id,
        name,
        rules: parseRules(p?.rules),
        mailbox: asString(p?.mailbox),
        icon: p?.icon === null ? null : asString(p?.icon),
        color: p?.color === null ? null : asString(p?.color),
      });
      broadcast("gmail:views-changed");
      preferenceChanged("views");
      return view;
    } catch (err) {
      console.log("[gmail:saveView] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:deleteView", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:deleteView]", { viewId: p?.viewId });
    try {
      await viewsStore.deleteView(assertString(p?.viewId, "viewId"));
      broadcast("gmail:views-changed");
      preferenceChanged("views");
      return { ok: true };
    } catch (err) {
      console.log("[gmail:deleteView] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:resetView", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:resetView]", { viewId: p?.viewId });
    try {
      await viewsStore.resetView(assertString(p?.viewId, "viewId"));
      broadcast("gmail:views-changed");
      preferenceChanged("views");
      return { ok: true };
    } catch (err) {
      console.log("[gmail:resetView] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:importViews — one-time migration of the renderer's legacy
  // localStorage view store; no-op once views.json exists.
  handle("gmail:importViews", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const raw = Array.isArray(p?.views) ? p.views : [];
      const views = raw
        .map((v) => v as Record<string, unknown>)
        .filter(
          (v) =>
            typeof v?.id === "string" &&
            typeof v?.name === "string" &&
            (v.kind === "inbox" ||
              v.kind === "starred" ||
              v.kind === "sent" ||
              v.kind === "drafts" ||
              v.kind === "important" ||
              v.kind === "junk" ||
              v.kind === "trash" ||
              v.kind === "custom"),
        )
        .map((v): MailView => ({
          id: v.id as string,
          name: v.name as string,
          kind: v.kind as MailView["kind"],
          rules: v.rules === null ? null : parseRules(v.rules),
        }));
      await viewsStore.importViews(views);
      broadcast("gmail:views-changed");
      preferenceChanged("views");
      return await viewsStore.listViews();
    } catch (err) {
      console.log("[gmail:importViews] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getMessage
  handle("gmail:getMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:getMessage]", { accountId: p?.accountId, messageId: p?.messageId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      // Return the cached body if we already fetched it; otherwise fetch full
      // once and persist so re-opens are instant and work offline.
      const cached = mailStore.getMessageDetail(accountId, messageId);
      if (cached) return cached;
      const detail = await providerFor(accountId).getMessage(accountId, messageId);
      mailStore.upsertMessageDetail(accountId, detail);
      return detail;
    } catch (err) {
      console.log("[gmail:getMessage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:modifyMessage
  handle("gmail:modifyMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:modifyMessage]", {
      accountId: p?.accountId,
      messageId: p?.messageId,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      const addLabelIds = asStringArray(p?.addLabelIds);
      const removeLabelIds = asStringArray(p?.removeLabelIds);
      return await settleLabelWrite(
        "gmail:modifyMessage",
        accountId,
        [messageId],
        addLabelIds ?? [],
        removeLabelIds ?? [],
        () =>
          providerFor(accountId).modifyMessage(accountId, messageId, {
            addLabelIds,
            removeLabelIds,
          }),
      );
    } catch (err) {
      console.log("[gmail:modifyMessage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:trashMessage
  handle("gmail:trashMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:trashMessage]", { accountId: p?.accountId, messageId: p?.messageId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      // Mirror locally first (lists drop it now, counts update) and answer
      // inside the IPC budget; Gmail + the metadata refresh finish after.
      return await settleLabelWrite(
        "gmail:trashMessage",
        accountId,
        [messageId],
        ["TRASH"],
        [],
        () =>
          providerFor(accountId)
            .trashMessage(accountId, messageId)
            .then(() => refreshMetadata(accountId, [messageId])),
      );
    } catch (err) {
      console.log("[gmail:trashMessage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getThread — all locally-cached messages of a thread, oldest first
  handle("gmail:getThread", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:getThread]", { accountId: p?.accountId, threadId: p?.threadId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const threadId = assertString(p?.threadId, "threadId");
      return mailStore.getThreadMessages(accountId, threadId);
    } catch (err) {
      console.log("[gmail:getThread] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:modifyThread — one Gmail call for the whole conversation, mirrored locally
  handle("gmail:modifyThread", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:modifyThread]", { accountId: p?.accountId, threadId: p?.threadId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const threadId = assertString(p?.threadId, "threadId");
      const addLabelIds = asStringArray(p?.addLabelIds);
      const removeLabelIds = asStringArray(p?.removeLabelIds);
      return await settleLabelWrite(
        "gmail:modifyThread",
        accountId,
        mailStore.getThreadMessages(accountId, threadId).map((m) => m.id),
        addLabelIds ?? [],
        removeLabelIds ?? [],
        () =>
          providerFor(accountId).modifyThread(accountId, threadId, {
            addLabelIds,
            removeLabelIds,
          }),
      );
    } catch (err) {
      console.log("[gmail:modifyThread] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:trashThread
  handle("gmail:trashThread", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:trashThread]", { accountId: p?.accountId, threadId: p?.threadId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const threadId = assertString(p?.threadId, "threadId");
      // Keep the rows (the Trash view reads them from the cache), mirrored as
      // trashed right away; Gmail + the metadata refresh finish after.
      const ids = mailStore.getThreadMessages(accountId, threadId).map((m) => m.id);
      return await settleLabelWrite("gmail:trashThread", accountId, ids, ["TRASH"], [], () =>
        providerFor(accountId)
          .trashThread(accountId, threadId)
          .then(() => refreshMetadata(accountId, ids)),
      );
    } catch (err) {
      console.log("[gmail:trashThread] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:untrashThread / gmail:untrashMessage — undo for trash: Gmail restores
  // the previous labels; the fresh metadata re-seeds the locally-deleted rows.
  handle("gmail:untrashThread", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:untrashThread]", { accountId: p?.accountId, threadId: p?.threadId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const threadId = assertString(p?.threadId, "threadId");
      const ids = mailStore.getThreadMessages(accountId, threadId).map((m) => m.id);
      return await settleLabelWrite("gmail:untrashThread", accountId, ids, [], ["TRASH"], () =>
        providerFor(accountId)
          .untrashThread(accountId, threadId)
          .then((fresh) => {
            mailStore.upsertMessages(accountId, fresh);
            mailStore.recountLabels(accountId, [
              ...new Set(fresh.flatMap((m) => m.labelIds)),
              "TRASH",
            ]);
            updateDockBadge();
          }),
      );
    } catch (err) {
      console.log("[gmail:untrashThread] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:untrashMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:untrashMessage]", { accountId: p?.accountId, messageId: p?.messageId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      return await settleLabelWrite(
        "gmail:untrashMessage",
        accountId,
        [messageId],
        [],
        ["TRASH"],
        () =>
          providerFor(accountId)
            .untrashMessage(accountId, messageId)
            .then((fresh) => {
              mailStore.upsertMessages(accountId, fresh);
              mailStore.recountLabels(accountId, [
                ...new Set(fresh.flatMap((m) => m.labelIds)),
                "TRASH",
              ]);
              updateDockBadge();
            }),
      );
    } catch (err) {
      console.log("[gmail:untrashMessage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:deleteThreadsForever — permanent delete; the UI only offers it on
  // Trash/Spam conversations. Threads resolve to message ids locally so the
  // whole batch goes out as one messages.batchDelete call.
  handle("gmail:deleteThreadsForever", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    const threadIds = asStringArray(p?.threadIds) ?? [];
    console.log("[gmail:deleteThreadsForever]", {
      accountId: p?.accountId,
      count: threadIds.length,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      // Only messages actually in Trash/Spam: a conversation is listed there if
      // ANY message is, and its other messages (a new Inbox reply, your Sent
      // replies) must survive — like Gmail's own "Delete forever".
      const messageIds: string[] = [];
      for (const threadId of threadIds) {
        for (const m of mailStore.getThreadMessages(accountId, threadId)) {
          if (m.labelIds.includes("TRASH") || m.labelIds.includes("SPAM")) messageIds.push(m.id);
        }
      }
      if (messageIds.length > 0) await providerFor(accountId).deleteForever(accountId, messageIds);
      for (const id of messageIds) mailStore.deleteMessage(accountId, id);
      updateDockBadge();
      return { ok: true as const };
    } catch (err) {
      console.log("[gmail:deleteThreadsForever] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:emptyFolder — Empty Junk / Empty Trash: permanently deletes every
  // message in SPAM or TRASH, on the server (the cache may not have them all)
  // and anything only cached. Big folders outlast the IPC timeout,
  // so it reports back as a task.
  handle("gmail:emptyFolder", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:emptyFolder]", { accountId: p?.accountId, labelId: p?.labelId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const labelId = assertString(p?.labelId, "labelId");
      if (labelId !== "SPAM" && labelId !== "TRASH") {
        throw new Error("Only Junk and Trash can be emptied.");
      }
      return await runAsTask(asString(p?.taskId), async () => {
        const messageIds = await providerFor(accountId).emptyFolder(
          accountId,
          labelId,
          mailStore.getMessageIdsForLabel(accountId, labelId),
        );
        for (const id of messageIds) mailStore.deleteMessage(accountId, id);
        mailStore.recountLabels(accountId, [labelId]);
        updateDockBadge();
        console.log("[gmail:emptyFolder] done", { labelId, deleted: messageIds.length });
        return { deleted: messageIds.length };
      });
    } catch (err) {
      console.log("[gmail:emptyFolder] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:saveDraft — composer autosave; creates or updates a Gmail draft.
  // Saves for one composer (its `sessionKey`) run in order and reuse the draft
  // id of the previous save — so a first save that outlasted the renderer's IPC
  // timeout (its reply, with the new id, never arrived) can't make the next
  // save create a second draft.
  handle("gmail:saveDraft", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:saveDraft]", {
      accountId: p?.accountId,
      draftId: p?.draftId ?? "(new)",
      threadId: p?.threadId,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const sessionKey = asString(p?.sessionKey);
      const content = {
        to: asString(p?.to) ?? "",
        cc: asString(p?.cc),
        bcc: asString(p?.bcc),
        subject: asString(p?.subject) ?? "",
        body: asString(p?.body) ?? "",
        bodyHtml: asString(p?.bodyHtml),
        attachments: parseAttachments(p?.attachments),
      };
      const expectMessageId = asString(p?.expectMessageId);
      const save = async () => {
        const draftId =
          asString(p?.draftId) ?? sessionDraftId(draftSessionId(accountId, sessionKey));
        // Someone else (Hermes, Gmail web, a phone) may have edited this draft
        // since the composer last saw it: never overwrite that silently.
        if (draftId && expectMessageId) {
          const current = await providerFor(accountId).getDraftVersion(accountId, draftId);
          if (current === null) return { gone: true as const, draftId };
          if (current !== expectMessageId) {
            return { conflict: true as const, draftId, messageId: current };
          }
        }
        const res = await providerFor(accountId).saveDraft(accountId, {
          ...content,
          draftId,
          threadId: asString(p?.threadId),
        });
        rememberSessionDraft(draftSessionId(accountId, sessionKey), res.draftId);
        await mirrorDraft(accountId, res, content);
        return { draftId: res.draftId, messageId: res.messageId, threadId: res.threadId };
      };
      return await queueDraftSave(draftSessionId(accountId, sessionKey), save);
    } catch (err) {
      console.log("[gmail:saveDraft] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getDraftVersion — which message backs a draft right now (null = the
  // draft is gone). Open composers poll this to notice edits made elsewhere.
  handle("gmail:getDraftVersion", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const draftId = assertString(p?.draftId, "draftId");
      return { messageId: await providerFor(accountId).getDraftVersion(accountId, draftId) };
    } catch (err) {
      console.log("[gmail:getDraftVersion] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:loadDraftVersion — a draft's content at a given version, mirrored
  // into the cache (the lists show the new version too).
  handle("gmail:loadDraftVersion", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:loadDraftVersion]", { draftId: p?.draftId, messageId: p?.messageId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const draftId = assertString(p?.draftId, "draftId");
      const messageId = assertString(p?.messageId, "messageId");
      const detail = await providerFor(accountId).getMessage(accountId, messageId);
      mailStore.upsertMessageDetail(accountId, detail);
      mailStore.setDraftId(accountId, messageId, draftId);
      if (detail.threadId)
        mailStore.deleteOtherDraftsInThread(accountId, detail.threadId, messageId);
      return detail;
    } catch (err) {
      console.log("[gmail:loadDraftVersion] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getDraftForMessage — resolve the draft id owning a message row
  handle("gmail:getDraftForMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      const threadId = asString(p?.threadId);
      // Local first (recorded on save and by sync); a server lookup as fallback.
      const known = mailStore.getDraftId(accountId, messageId, threadId);
      if (known) return { draftId: known };
      const draftId = await providerFor(accountId).findDraftId(accountId, messageId, threadId);
      if (draftId) mailStore.setDraftId(accountId, messageId, draftId);
      console.log("[gmail:getDraftForMessage]", { accountId, messageId, found: draftId != null });
      return { draftId };
    } catch (err) {
      console.log("[gmail:getDraftForMessage] error", { error: String(err) });
      throw err;
    }
  });

  handle("gmail:deleteDraft", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:deleteDraft]", { accountId: p?.accountId, draftId: p?.draftId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      // By id, or by composer session (its first save's reply may never have
      // reached the renderer). Waits for that session's queued saves first.
      const sessionKey = asString(p?.sessionKey);
      const sessionDraft = await takeSessionDraft(draftSessionId(accountId, sessionKey));
      const draftId = asString(p?.draftId) ?? sessionDraft;
      if (!draftId) return { ok: true as const };
      const res = await providerFor(accountId).deleteDraft(accountId, draftId);
      if (res.messageId) mailStore.deleteMessage(accountId, res.messageId);
      return { ok: true as const };
    } catch (err) {
      console.log("[gmail:deleteDraft] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:sendMessage — threading (threadId + In-Reply-To/References resolved
  // from replyToMessageId) and multipart attachments are optional.
  handle("gmail:sendMessage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:sendMessage]", {
      accountId: p?.accountId,
      to: p?.to,
      subject: p?.subject,
      threadId: p?.threadId,
      attachments: Array.isArray(p?.attachments) ? p.attachments.length : 0,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const to = assertString(p?.to, "to");
      const subject = assertString(p?.subject, "subject");
      // An empty body is fine (subject-only, or just attachments).
      const body = asString(p?.body) ?? "";
      const threadId = asString(p?.threadId);
      const replyToMessageId = asString(p?.replyToMessageId);
      const attachments = parseAttachments(p?.attachments);

      const totalBytes = (attachments ?? []).reduce(
        (sum, a) => sum + Math.floor((a.base64.length * 3) / 4),
        0,
      );
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        throw new Error("Attachments can total at most 25 MB.");
      }

      let inReplyTo: string | undefined;
      let references: string | undefined;
      if (replyToMessageId) {
        let headers = mailStore.getStoredReplyHeaders(accountId, replyToMessageId);
        if (!headers.messageIdHeader) {
          try {
            headers = await providerFor(accountId).getReplyHeaders(accountId, replyToMessageId);
            mailStore.setReplyHeaders(
              accountId,
              replyToMessageId,
              headers.messageIdHeader,
              headers.referencesHeader,
            );
          } catch (headerErr) {
            // Still threads via threadId; the reply just loses the References chain.
            console.log("[gmail:sendMessage] reply-header fetch failed", {
              error: String(headerErr),
            });
          }
        }
        if (headers.messageIdHeader) {
          inReplyTo = headers.messageIdHeader;
          references = headers.referencesHeader
            ? `${headers.referencesHeader} ${headers.messageIdHeader}`
            : headers.messageIdHeader;
        }
      }

      const message = {
        to,
        cc: asString(p?.cc),
        bcc: asString(p?.bcc),
        subject,
        body,
        bodyHtml: asString(p?.bodyHtml),
        threadId,
        attachments,
      };
      if (p?.scheduledAt !== undefined) {
        if (!(await getAccount(accountId))) throw new Error("Mailbox no longer exists.");
        scheduleSend(accountId, { ...message, inReplyTo, references }, futureTime(p.scheduledAt));
        return { ok: true as const };
      }
      const provider = providerFor(accountId);
      const send = provider
        .send(accountId, { ...message, inReplyTo, references })
        .then(async (result) => {
          // Mirror the sent message so it shows in Sent and its conversation
          // before the next sync. Best effort: the mail has already gone out.
          if (!result.messageId) return;
          try {
            mailStore.upsertMessages(
              accountId,
              await provider.getSummaries(accountId, [result.messageId]),
            );
          } catch (mirrorErr) {
            console.log("[gmail:sendMessage] sent; local mirror failed", {
              error: String(mirrorErr),
            });
          }
        });
      // Uploads (attachments, rate limits) can outlast the renderer's 5s IPC
      // timeout, which used to report a false failure and invite a duplicate
      // send. Past the budget the composer closes as sent; if the send then
      // fails, the message goes back to Drafts so nothing is lost.
      // `settled` never rejects, so a failure after the deadline can't become
      // an unhandled rejection.
      const settled = send.then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      const outcome = await Promise.race([settled, sleep(IPC_WRITE_BUDGET_MS).then(() => null)]);
      if (outcome?.error) throw outcome.error; // failed in time: the composer keeps its draft
      if (outcome === null) {
        void settled.then(async ({ error }) => {
          if (!error) return;
          console.log("[gmail:sendMessage] background send failed", { error: String(error) });
          let savedToDrafts = false;
          try {
            await provider.saveDraft(accountId, message);
            savedToDrafts = true;
          } catch (draftErr) {
            console.log("[gmail:sendMessage] could not save a draft copy", {
              error: String(draftErr),
            });
          }
          broadcast("gmail:send-failed", { subject, savedToDrafts });
        });
      }
      return { ok: true as const, pending: outcome === null };
    } catch (err) {
      console.log("[gmail:sendMessage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:pickAttachments — backend open-file dialog, returns file contents
  handle("gmail:pickAttachments", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:pickAttachments]", { existingBytes: p?.existingBytes });
    try {
      const existingBytes = asNumber(p?.existingBytes) ?? 0;
      return await runAsTask(asString(p?.taskId), () => pickComposeAttachments(existingBytes));
    } catch (err) {
      console.log("[gmail:pickAttachments] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getAttachmentData — attachment bytes as base64 (no save dialog)
  handle("gmail:getAttachmentData", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:getAttachmentData]", {
      accountId: p?.accountId,
      messageId: p?.messageId,
      attachmentId: p?.attachmentId,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      const attachmentId = assertString(p?.attachmentId, "attachmentId");
      return await runAsTask(asString(p?.taskId), () =>
        getAttachmentData(accountId, messageId, attachmentId),
      );
    } catch (err) {
      console.log("[gmail:getAttachmentData] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:openAttachment — save to the temp cache and open with the default app
  handle("gmail:openAttachment", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:openAttachment]", {
      accountId: p?.accountId,
      messageId: p?.messageId,
      filename: p?.filename,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      const attachmentId = assertString(p?.attachmentId, "attachmentId");
      const filename = assertString(p?.filename, "filename");
      return await runAsTask(asString(p?.taskId), async () => {
        const bytes = await getAttachmentBytes(accountId, messageId, attachmentId);
        await platform().userFiles.open(filename, bytes);
        return { ok: true };
      });
    } catch (err) {
      console.log("[gmail:openAttachment] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:openComposeAttachment — write in-memory compose bytes to temp and open
  handle("gmail:openComposeAttachment", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:openComposeAttachment]", { name: p?.name });
    try {
      const name = assertString(p?.name, "name");
      const base64 = assertString(p?.base64, "base64");
      await platform().userFiles.open(name, fromBase64(base64));
      return { ok: true };
    } catch (err) {
      console.log("[gmail:openComposeAttachment] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:proxyImage — fetch a remote email image server-side (bypasses the
  // iframe's Cross-Origin-Resource-Policy block) and return it as a data URL
  handle("gmail:proxyImage", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const url = assertString(p?.url, "url");
      return await proxyRemoteImage(url);
    } catch (err) {
      console.log("[gmail:proxyImage] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:suggestContacts — recipient autocomplete from the local cache
  handle("gmail:suggestContacts", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const q = assertString(p?.q, "q");
      const limit = Math.min(Math.max(asNumber(p?.limit) ?? 8, 1), 20);
      return mailStore.suggestContacts(q, limit);
    } catch (err) {
      console.log("[gmail:suggestContacts] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getAttachment
  handle("gmail:getAttachment", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:getAttachment]", {
      accountId: p?.accountId,
      messageId: p?.messageId,
      attachmentId: p?.attachmentId,
      filename: p?.filename,
    });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const messageId = assertString(p?.messageId, "messageId");
      const attachmentId = assertString(p?.attachmentId, "attachmentId");
      const filename = assertString(p?.filename, "filename");
      return await runAsTask(asString(p?.taskId), () =>
        saveAttachment(accountId, messageId, attachmentId, filename),
      );
    } catch (err) {
      console.log("[gmail:getAttachment] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:syncAccount — kick off a background sync, return current status
  handle("gmail:syncAccount", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:syncAccount]", { accountId: p?.accountId });
    try {
      const accountId = assertString(p?.accountId, "accountId");
      mailSync.syncAccount(accountId, { force: true });
      return mailSync.getSyncStatus(accountId);
    } catch (err) {
      console.log("[gmail:syncAccount] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getSenderAvatar — cached sender photo (People API / Gravatar / domain logo)
  handle("gmail:getSenderAvatar", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const accountId = assertString(p?.accountId, "accountId");
      const email = assertString(p?.email, "email");
      const dataUrl = await getSenderAvatar(accountId, email);
      return { dataUrl };
    } catch (err) {
      console.log("[gmail:getSenderAvatar] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getSyncStatus — poll background sync progress for an account
  handle("gmail:getSyncStatus", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    try {
      const accountId = assertString(p?.accountId, "accountId");
      return mailSync.getSyncStatus(accountId);
    } catch (err) {
      console.log("[gmail:getSyncStatus] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:getSyncSettings — read the periodic pull-sync configuration
  handle("gmail:getSyncSettings", async () => {
    try {
      return await getSettings();
    } catch (err) {
      console.log("[gmail:getSyncSettings] error", { error: String(err) });
      throw err;
    }
  });

  // gmail:setSyncSettings — persist any provided settings; restarts the sync
  // timer when the interval changed.
  handle("gmail:setSyncSettings", async (params: unknown) => {
    const p = params as Record<string, unknown>;
    console.log("[gmail:setSyncSettings]", {
      syncIntervalSeconds: p?.syncIntervalSeconds,
      notificationsMode: p?.notificationsMode,
    });
    try {
      const patch: Partial<AppSettings> = {};
      if (p?.syncIntervalSeconds !== undefined) {
        const raw = p.syncIntervalSeconds;
        if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
          throw new Error(
            'Invalid parameter: "syncIntervalSeconds" must be a non-negative number.',
          );
        }
        patch.syncIntervalSeconds = Math.min(Math.round(raw), 24 * 60 * 60);
      }
      if (p?.notificationsMode !== undefined) {
        const mode = p.notificationsMode;
        if (mode !== "off" && mode !== "inbox" && mode !== "all") {
          throw new Error(
            'Invalid parameter: "notificationsMode" must be "off", "inbox", or "all".',
          );
        }
        patch.notificationsMode = mode;
      }
      if (p?.launchAtLogin !== undefined) {
        if (typeof p.launchAtLogin !== "boolean") {
          throw new Error('Invalid parameter: "launchAtLogin" must be a boolean.');
        }
        patch.launchAtLogin = p.launchAtLogin;
      }
      if (p?.trayEnabled !== undefined) {
        if (typeof p.trayEnabled !== "boolean") {
          throw new Error('Invalid parameter: "trayEnabled" must be a boolean.');
        }
        patch.trayEnabled = p.trayEnabled;
      }
      if (p?.dockBadgeEnabled !== undefined) {
        if (typeof p.dockBadgeEnabled !== "boolean") {
          throw new Error('Invalid parameter: "dockBadgeEnabled" must be a boolean.');
        }
        patch.dockBadgeEnabled = p.dockBadgeEnabled;
      }
      const settings = await updateSettings(patch);
      if (patch.syncIntervalSeconds !== undefined) {
        mailSync.configureAutoSync(settings.syncIntervalSeconds);
      }
      return settings;
    } catch (err) {
      console.log("[gmail:setSyncSettings] error", { error: String(err) });
      throw err;
    }
  });
}
