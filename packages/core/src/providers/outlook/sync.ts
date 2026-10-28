/**
 * Outlook's part of sync (the engine around it is services/mail-sync.ts),
 * with Graph's delta queries, one per folder.
 *
 * A folder's first delta lists every message in it, page by page: that's the
 * backfill, in its own lane, the inbox first and resumable (the next page's
 * link is kept). Once a folder's listing ends, Graph hands a delta link, and
 * every sync run asks it what changed since: new mail, read and flag changes,
 * categories, and messages that left the folder. Immutable ids keep a moved
 * message's id, so a message that left one folder is looked up to see where
 * it went (or whether it's gone).
 *
 * A brand-new mailbox shows the newest page of its inbox first, before the
 * backfill gets to it.
 */

import { OTHER_LABEL_ID } from "@otter-mail/contracts";

import { logger } from "../../logger.js";
import * as store from "../../services/mail-store.js";
import type { GmailMessageSummary } from "../../types.js";
import type { SyncContext } from "../provider.js";
import {
  FOLDER_PREFIX,
  isSyncedFolder,
  labelsOf,
  mailboxOf,
  readMailbox,
  type Folder,
  type Mailbox,
} from "./folders.js";
import { GraphError, graph, graphAll, type Page } from "./graph.js";
import {
  getApiMessages,
  getSummaries,
  SUMMARY_FIELDS,
  toSummary,
  type ApiMessage,
} from "./messages.js";

/** Messages a delta page carries. */
const PAGE_SIZE = 100;

/**
 * Each folder's delta: the next page's link while listing, then the delta
 * link; and the label the folder's cached mail carries.
 */
type FolderDelta = { link: string; done: boolean; label?: string | null };
type DeltaState = Record<string, FolderDelta>;

const deltaKey = (accountId: string) => `outlookDelta:${accountId}`;
const peekedKey = (accountId: string) => `outlookPeeked:${accountId}`;

function readDelta(accountId: string): DeltaState {
  try {
    return JSON.parse(store.getKv(deltaKey(accountId)) || "{}") as DeltaState;
  } catch {
    return {};
  }
}

function writeDelta(accountId: string, state: DeltaState): void {
  store.setKv(deltaKey(accountId), JSON.stringify(state));
}

function setFolderDelta(accountId: string, folderId: string, delta: FolderDelta | null): void {
  const state = readDelta(accountId);
  if (delta) state[folderId] = delta;
  else delete state[folderId];
  writeDelta(accountId, state);
}

const firstDelta = (folderId: string) =>
  `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta?$select=${SUMMARY_FIELDS}`;

export function forgetOutlookSync(accountId: string): void {
  folderRefresh.delete(accountId);
}

// ── Folders ─────────────────────────────────────────────────────────────────
// The folder tree (names, Outlook's counts) and categories take a few
// requests: re-read when mail changed (at most every 30 seconds) and every 2
// minutes, so folders and categories made elsewhere show up soon.

const FOLDERS_MIN_GAP_MS = 30_000;
const FOLDERS_MAX_AGE_MS = 2 * 60_000;
const folderRefresh = new Map<string, { at: number; dirty: boolean }>();

async function refreshFolders(
  accountId: string,
  mailChanged: boolean,
  ctx: SyncContext,
): Promise<Mailbox> {
  const before = mailboxOf(accountId);
  let state = folderRefresh.get(accountId);
  if (!state) folderRefresh.set(accountId, (state = { at: 0, dirty: true }));
  if (mailChanged) state.dirty = true;
  const age = Date.now() - state.at;
  if (before && age < FOLDERS_MAX_AGE_MS && !(state.dirty && age > FOLDERS_MIN_GAP_MS)) {
    return before;
  }
  const mailbox = await readMailbox(accountId);
  ctx.assertActive();
  state.at = Date.now();
  state.dirty = false;
  followFolderChanges(accountId, before, mailbox);
  store.upsertLabels(accountId, labelsOf(accountId, mailbox));
  ctx.bumpRevision();
  return mailbox;
}

/** Folders deleted for good take their cached mail with them. */
function followFolderChanges(accountId: string, before: Mailbox | null, after: Mailbox): void {
  if (!before) return;
  const now = new Set(after.folders.map((f) => f.id));
  const delta = readDelta(accountId);
  for (const folder of before.folders) {
    if (now.has(folder.id)) continue;
    delete delta[folder.id];
    if (folder.labelId?.startsWith(FOLDER_PREFIX)) {
      const ids = store.getMessageIdsForLabel(accountId, folder.labelId);
      store.applyHistoryChanges(
        accountId,
        ids.map((id) => ({ kind: "deleted", id })),
      );
    }
  }
  writeDelta(accountId, delta);
}

/**
 * A folder whose label changed (moved into Deleted Items, say, or the
 * Archive, which had none before ARCHIVE) moves its cached mail to the new
 * label. The cache can't tell which mail had none: Outlook lists the folder.
 */
async function relabelFolders(accountId: string, mailbox: Mailbox, ctx: SyncContext) {
  for (const folder of mailbox.folders) {
    const state = readDelta(accountId)[folder.id];
    if (!state) continue;
    // Listed before folders kept their label: only the Archive's has changed since.
    const had =
      state.label !== undefined
        ? state.label
        : folder.id === mailbox.wellKnown.archive
          ? null
          : folder.labelId;
    if (had !== folder.labelId) {
      const ids = await graphAll<{ id: string }>(
        accountId,
        `/me/mailFolders/${encodeURIComponent(folder.id)}/messages?$select=id&$top=500`,
      );
      ctx.assertActive();
      store.applyHistoryChanges(
        accountId,
        ids.flatMap(({ id }) => [
          ...(had ? [{ kind: "labelsRemoved" as const, id, labelIds: [had] }] : []),
          ...(folder.labelId
            ? [{ kind: "labelsAdded" as const, id, labelIds: [folder.labelId] }]
            : []),
        ]),
      );
      ctx.bumpRevision();
    }
    if (state.label !== folder.labelId) {
      setFolderDelta(accountId, folder.id, { ...state, label: folder.labelId });
    }
  }
}

/**
 * The inbox's mail Focused Inbox sorted as Other gets OTHER, once: it came
 * after mail cached before (later syncs bring it with the mail).
 */
async function labelOtherMail(accountId: string, mailbox: Mailbox, ctx: SyncContext) {
  const key = `outlookOther:${accountId}`;
  if (store.getKv(key) === "1") return;
  const filter = encodeURIComponent("inferenceClassification eq 'other'");
  const other = await graphAll<{ id: string }>(
    accountId,
    `/me/mailFolders/${encodeURIComponent(mailbox.wellKnown.inbox!)}/messages?$filter=${filter}&$select=id&$top=500`,
  );
  ctx.assertActive();
  store.applyHistoryChanges(
    accountId,
    other.map(({ id }) => ({ kind: "labelsAdded" as const, id, labelIds: [OTHER_LABEL_ID] })),
  );
  store.setKv(key, "1");
  if (other.length > 0) ctx.bumpRevision();
}

// ── Sync ────────────────────────────────────────────────────────────────────

export async function syncOutlook(accountId: string, ctx: SyncContext): Promise<void> {
  ctx.update({ phase: mailboxOf(accountId) ? "incremental" : "labels" });
  const mailbox = await refreshFolders(accountId, false, ctx);
  await relabelFolders(accountId, mailbox, ctx);
  await labelOtherMail(accountId, mailbox, ctx);
  if (store.getKv(peekedKey(accountId)) !== "1") await peekInbox(accountId, mailbox, ctx);

  ctx.update({ phase: "incremental", synced: 0 });
  const delta = readDelta(accountId);
  const added: GmailMessageSummary[] = [];
  let changed = false;
  for (const folder of mailbox.folders) {
    const state = delta[folder.id];
    if (!state?.done) continue;
    const result = await followDelta(accountId, folder, state.link, ctx);
    added.push(...result.added);
    changed ||= result.changed;
  }
  if (changed) {
    ctx.bumpRevision();
    // Counts and categories moved with the mail.
    await refreshFolders(accountId, true, ctx);
  }
  await ctx.newMail(added.filter((m) => m.labelIds.includes("INBOX")));
}

/** The newest page of the inbox, so a new mailbox shows mail before its backfill gets there. */
async function peekInbox(accountId: string, mailbox: Mailbox, ctx: SyncContext): Promise<void> {
  const inbox = mailbox.wellKnown.inbox!;
  const page = await graph<Page<ApiMessage>>(
    accountId,
    `/me/mailFolders/${encodeURIComponent(inbox)}/messages?$top=50&$orderby=receivedDateTime desc&$select=${SUMMARY_FIELDS}`,
  );
  ctx.assertActive();
  store.upsertMessages(
    accountId,
    (page.value ?? []).map((m) => toSummary(accountId, m)),
  );
  store.recountLabels(accountId, ["INBOX", "UNREAD", "STARRED", "IMPORTANT"]);
  store.setKv(peekedKey(accountId), "1");
  ctx.bumpRevision();
}

/**
 * Replays a folder's delta from its link. Every page is read before anything
 * is written, so a failure midway leaves the link and the cache as they were
 * and the next run asks again.
 */
async function followDelta(
  accountId: string,
  folder: Folder,
  link: string,
  ctx: SyncContext,
): Promise<{ added: GmailMessageSummary[]; changed: boolean }> {
  const present: ApiMessage[] = [];
  const removed: string[] = [];
  let next: string | undefined = link;
  let deltaLink = link;
  try {
    while (next) {
      const page: Page<ApiMessage> = await graph<Page<ApiMessage>>(accountId, next, {
        prefer: [`odata.maxpagesize=${PAGE_SIZE}`],
      });
      for (const message of page.value ?? []) {
        if (message["@removed"]) removed.push(message.id);
        else present.push(message);
      }
      next = page["@odata.nextLink"];
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
    }
  } catch (err) {
    // The delta expired (or Graph lost track): list the folder again.
    if (err instanceof GraphError && (err.status === 410 || /syncState|resync/i.test(err.code))) {
      logger.info("outlook-sync", `delta expired for a folder of ${accountId}; listing it again`);
      setFolderDelta(accountId, folder.id, null);
      return { added: [], changed: false };
    }
    throw err;
  }

  ctx.assertActive();
  // Read/flag changes can carry only part of a message. Resolve the current
  // summaries in batches before replacing any cached headers or labels.
  const summaries = await getSummaries(accountId, [...new Set(present.map((m) => m.id))]);
  ctx.assertActive();
  const fresh = new Set(
    store.filterUnknownIds(
      accountId,
      summaries.map((m) => m.id),
    ),
  );
  // Counts change for the labels messages had as well as for the ones they have now.
  const touched = new Set<string>();
  for (const m of summaries) {
    for (const l of store.getMessageLabelIds(accountId, m.id) ?? []) touched.add(l);
  }
  store.upsertMessages(accountId, summaries);
  for (const m of summaries) for (const l of m.labelIds) touched.add(l);

  // What left the folder: moved (immutable ids keep it), or deleted.
  const gone = removed.filter((id) => !present.some((m) => m.id === id));
  if (gone.length > 0) {
    const found = new Map((await getApiMessages(accountId, gone)).map((m) => [m.id, m]));
    ctx.assertActive();
    const ops: store.HistoryOp[] = [];
    const moved: GmailMessageSummary[] = [];
    for (const id of gone) {
      const message = found.get(id);
      // Deleted, or somewhere not synced (the Outbox): out of the cache.
      if (!message || !isSyncedFolder(accountId, message.parentFolderId)) {
        ops.push({ kind: "deleted", id });
      } else moved.push(toSummary(accountId, message));
    }
    for (const id of gone) {
      for (const l of store.getMessageLabelIds(accountId, id) ?? []) touched.add(l);
    }
    store.applyHistoryChanges(accountId, ops);
    store.upsertMessages(accountId, moved);
    for (const m of moved) for (const l of m.labelIds) touched.add(l);
  }
  store.recountLabels(accountId, [...touched]);
  setFolderDelta(accountId, folder.id, {
    ...readDelta(accountId)[folder.id],
    link: deltaLink,
    done: true,
  });
  ctx.update({ synced: summaries.length });
  return {
    added: summaries.filter((m) => fresh.has(m.id) && m.unread),
    changed: summaries.length > 0 || gone.length > 0,
  };
}

// ── Backfill ────────────────────────────────────────────────────────────────

export function needsBackfill(accountId: string): boolean {
  const mailbox = mailboxOf(accountId);
  if (!mailbox) return false;
  const delta = readDelta(accountId);
  return mailbox.folders.some((f) => !delta[f.id]?.done);
}

/** Lists every folder not listed yet (the inbox first), resuming where a run stopped. */
export async function backfillOutlook(accountId: string, ctx: SyncContext): Promise<void> {
  const mailbox = mailboxOf(accountId);
  if (!mailbox) return;
  const total = mailbox.folders.reduce((sum, f) => sum + f.total, 0);
  let count = store.countAllMessages(accountId);
  ctx.update({ phase: "full", synced: count, total: total || null });
  for (const folder of mailbox.folders) {
    const state = readDelta(accountId)[folder.id];
    if (state?.done) continue;
    let next: string | undefined = state?.link ?? firstDelta(folder.id);
    while (next) {
      const page: Page<ApiMessage> = await graph<Page<ApiMessage>>(accountId, next, {
        prefer: [`odata.maxpagesize=${PAGE_SIZE}`],
      });
      ctx.assertActive();
      const summaries = (page.value ?? [])
        .filter((m) => !m["@removed"] && isSyncedFolder(accountId, m.parentFolderId))
        .map((m) => toSummary(accountId, m));
      // Mail the delta's syncs wrote meanwhile is newer than this listing.
      const unknown = new Set(
        store.filterUnknownIds(
          accountId,
          summaries.map((m) => m.id),
        ),
      );
      store.upsertMessages(
        accountId,
        summaries.filter((m) => unknown.has(m.id)),
      );
      count += unknown.size;
      next = page["@odata.nextLink"];
      setFolderDelta(accountId, folder.id, {
        // Listed from the start, its mail has the folder's label now.
        ...(readDelta(accountId)[folder.id] ?? { label: folder.labelId }),
        link: next ?? page["@odata.deltaLink"] ?? firstDelta(folder.id),
        done: !next,
      });
      ctx.update({ synced: count });
      if (unknown.size > 0) ctx.bumpRevision();
    }
  }
  ctx.assertActive();
  store.recountLabels(
    accountId,
    labelsOf(accountId, mailbox).map((l) => l.id),
  );
  store.upsertLabels(accountId, labelsOf(accountId, mailbox));
  store.setSyncState(accountId, { fullSyncDone: true });
  ctx.bumpRevision();
  logger.info("outlook-sync", `listed every folder of ${accountId}`);
}
