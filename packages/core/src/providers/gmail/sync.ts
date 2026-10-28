/**
 * Gmail's part of sync (the engine around it is services/mail-sync.ts).
 *
 * A sync run replays Gmail's history feed, a cheap delta, and keeps labels
 * and draft ids current: it's short, so new mail shows up on every push and
 * tick. What takes long runs as a backfill in its own lane beside it (the
 * engine's): listing the whole mailbox the first time, comparing it with
 * Gmail's listings after the history feed expired, and Spam and Trash after
 * a first listing through the API.
 *
 * The feed starts where a backfill does (its seed), so syncs keep bringing
 * new mail while it runs. Once it's done, the next run replays the feed from
 * that seed: what changed meanwhile lands on top of the older copies it
 * wrote (the feed's changes can be applied twice).
 *
 * On the Mac the first sync goes over IMAP (imap-fill.ts): every list row in
 * seconds, off the API's quota. Elsewhere, or when IMAP isn't to be had, it
 * lists the mailbox through the API, the inbox first; where bodies are kept
 * for offline reading, messages are fetched whole there: one request gives
 * the list row and the body, instead of one each.
 */

import { logger } from "../../logger.js";
import { platform } from "../../platform.js";
import * as store from "../../services/mail-store.js";
import type { MessageSummary } from "../../types.js";
import { SyncCancelled, type SyncContext } from "../provider.js";
import {
  describeError,
  fetchMessagesForIds,
  fetchMetadataForIds,
  getProfile,
  isHistoryExpiredError,
  listDraftIds,
  listHistory,
  listLabelNames,
  listLabels,
  listMessageIdsPage,
} from "./api.js";
import { fillOverImap } from "./imap-fill.js";

// Kept in kv, so a backfill survives quitting and picks up where it stopped.
/** The history id a backfill began at: the feed replays from it once it's done. */
const seedKey = (accountId: string) => `fullSyncSeed:${accountId}`;
/** The first listing's page cursor. */
const cursorKey = (accountId: string) => `fullSyncCursor:${accountId}`;
/** "1" once the history feed expired: the cache is compared with Gmail's listings. */
const refreshKey = (accountId: string) => `fullSyncRefresh:${accountId}`;
/** A finished backfill's seed, until a run has replayed the feed from it. */
const replayKey = (accountId: string) => `replayFrom:${accountId}`;
const spamTrashKey = (accountId: string) => `spamTrashBackfilled:${accountId}`;

export async function syncGmail(accountId: string, ctx: SyncContext): Promise<void> {
  ctx.update({ phase: "incremental" });
  let historyId = store.getSyncState(accountId).historyId;
  if (!historyId) {
    // A new mailbox. Labels first — the sidebar and message chips depend on
    // them; then the feed starts now, and a backfill lists what came before.
    ctx.update({ phase: "labels" });
    if (await refreshLabels(accountId, true, ctx)) ctx.bumpRevision();
    historyId = await startFeed(accountId, ctx);
  }

  const delta = await incrementalSync(accountId, historyId, ctx);
  if (await refreshLabels(accountId, delta.changed, ctx)) ctx.bumpRevision();
  await ctx.newMail(delta.added);

  // Local-first drafts: know every draft's id, so opening one needs no
  // Gmail round trip.
  await learnDraftIds(accountId, delta.changed, ctx);
}

export function needsBackfill(accountId: string): boolean {
  return (
    !store.getSyncState(accountId).fullSyncDone ||
    store.getKv(refreshKey(accountId)) === "1" ||
    store.getKv(spamTrashKey(accountId)) !== "1"
  );
}

/** The long work needsBackfill reports, in the engine's backfill lane. */
export async function backfillGmail(accountId: string, ctx: SyncContext): Promise<void> {
  // The feed starts first (syncGmail), so nothing is missed meanwhile.
  if (!store.getSyncState(accountId).historyId) return;
  if (store.getKv(refreshKey(accountId)) === "1") await refreshMailbox(accountId, ctx);
  else if (!store.getSyncState(accountId).fullSyncDone) await fillMailbox(accountId, ctx);
  if (store.getKv(spamTrashKey(accountId)) !== "1") await backfillSpamTrash(accountId, ctx);
}

/** Starts the history feed now and returns its history id. */
async function startFeed(accountId: string, ctx: SyncContext): Promise<string> {
  const seed = (await getProfile(accountId)).historyId;
  if (!seed) throw new Error("Gmail didn't say where the mailbox's history starts.");
  ctx.assertActive();
  store.setKv(seedKey(accountId), seed);
  store.setSyncState(accountId, { historyId: seed });
  return seed;
}

/** A backfill is done: the next sync replays the feed from its seed. */
function finishBackfill(accountId: string): void {
  const seed = store.getKv(seedKey(accountId));
  store.setSyncState(accountId, { fullSyncDone: true });
  if (seed) store.setKv(replayKey(accountId), seed);
  store.setKv(seedKey(accountId), "");
  store.setKv(cursorKey(accountId), "");
  store.setKv(refreshKey(accountId), "");
}

/**
 * Fetches messages and caches them: whole where bodies are kept for offline
 * reading (one full fetch costs less than a summary now and a body later),
 * else the summary.
 * With `skipCached`, rows cached meanwhile are left alone: a backfill's copy
 * is older than the feed's. Returns what was fetched.
 */
async function fetchAndStore(
  accountId: string,
  ids: string[],
  ctx: SyncContext,
  skipCached = false,
): Promise<MessageSummary[]> {
  const uncached = <T extends MessageSummary>(fetched: T[]): T[] => {
    if (!skipCached) return fetched;
    const unknown = new Set(
      store.filterUnknownIds(
        accountId,
        fetched.map((m) => m.id),
      ),
    );
    return fetched.filter((m) => unknown.has(m.id));
  };
  if (platform().offlineDownloads) {
    const details = await fetchMessagesForIds(accountId, ids);
    ctx.assertActive();
    store.upsertMessageDetails(accountId, uncached(details));
    return details;
  }
  const summaries = await fetchMetadataForIds(accountId, ids);
  ctx.assertActive();
  store.upsertMessages(accountId, uncached(summaries));
  return summaries;
}

/** Drops a removed account's in-memory sync state. */
export function forgetGmailSync(accountId: string): void {
  labelRefresh.delete(accountId);
  draftCheckAt.delete(accountId);
}

// ── Labels ───────────────────────────────────────────────────────────────
// labels.get per label (names, colors, Gmail's counts) is ~30 requests per
// account — too much for every 30s tick. Each tick does one labels.list to
// catch labels created/renamed/deleted elsewhere; the per-label detail is
// re-read when mail changed (at most once a minute) and every 10 minutes.
// Between detail reads, applyHistoryChanges keeps counts current locally.

const LABEL_DETAIL_MIN_GAP_MS = 60_000;
const LABEL_DETAIL_MAX_AGE_MS = 10 * 60_000;
const labelRefresh = new Map<string, { refreshedAt: number; dirty: boolean }>();

/** Refreshes the cached labels when due. Returns whether they were rewritten. */
async function refreshLabels(
  accountId: string,
  mailChanged: boolean,
  ctx: SyncContext,
): Promise<boolean> {
  let state = labelRefresh.get(accountId);
  if (!state) {
    state = { refreshedAt: 0, dirty: true };
    labelRefresh.set(accountId, state);
  }
  if (mailChanged) state.dirty = true;
  const age = Date.now() - state.refreshedAt;
  let due = age > LABEL_DETAIL_MAX_AGE_MS || (state.dirty && age > LABEL_DETAIL_MIN_GAP_MS);
  if (!due) {
    const names = await listLabelNames(accountId);
    const cached = new Map(store.getLabels(accountId).map((l) => [l.id, l.name]));
    due = names.length !== cached.size || names.some((l) => cached.get(l.id) !== l.name);
  }
  if (!due) return false;
  const labels = await listLabels(accountId);
  ctx.assertActive();
  store.upsertLabels(accountId, labels);
  state.refreshedAt = Date.now();
  state.dirty = false;
  return true;
}

const META_CHUNK = 100;

/**
 * The first sync of a mailbox. On the Mac, over IMAP (every row in seconds),
 * then the category labels IMAP doesn't carry.
 *
 * Otherwise through the API: the newest page of the inbox, then the whole
 * mailbox newest first (Spam and Trash after it: backfillSpamTrash), caching
 * what isn't cached yet, 100 messages at a time so lists fill in steadily.
 * Resumable: the page cursor is kept after every page, so a failure (rate
 * limits, sleep, quit) continues where it stopped instead of starting over.
 */
async function fillMailbox(accountId: string, ctx: SyncContext): Promise<void> {
  if (platform().kind === "desktop") {
    try {
      await fillOverImap(accountId, ctx);
      await fillCategories(accountId, ctx);
      ctx.assertActive();
      finishBackfill(accountId);
      store.setKv(spamTrashKey(accountId), "1");
      return;
    } catch (err) {
      if (err instanceof SyncCancelled) throw err;
      logger.info("mail-sync", `filling ${accountId} through the API: ${describeError(err)}`);
    }
  }

  let total: number | null = null;
  try {
    total = (await getProfile(accountId)).messagesTotal || null;
  } catch {
    // keep going without a total
  }

  let pageToken = store.getKv(cursorKey(accountId)) || undefined;
  let synced = store.countAllMessages(accountId);
  ctx.update({ phase: "full", synced, total });
  if (pageToken) logger.info("mail-sync", `full sync resuming for ${accountId} at ${synced}`);

  // What the user looks at first: the newest page of the inbox.
  const inbox = await listMessageIdsPage(accountId, {
    labelIds: ["INBOX"],
    maxResults: 500,
    spamTrash: false,
  });
  const inboxFresh = store.filterUnknownIds(accountId, inbox.ids);
  for (let i = 0; i < inboxFresh.length; i += META_CHUNK) {
    synced += (await fetchAndStore(accountId, inboxFresh.slice(i, i + META_CHUNK), ctx, true))
      .length;
    ctx.update({ synced });
    ctx.bumpRevision();
  }

  for (;;) {
    let page: Awaited<ReturnType<typeof listMessageIdsPage>>;
    try {
      page = await listMessageIdsPage(accountId, { pageToken, maxResults: 500, spamTrash: false });
    } catch (err) {
      // A stale saved cursor: start the listing over (cached ids are skipped).
      if (pageToken && err instanceof Error && err.message.includes("Gmail API error: 400")) {
        store.setKv(cursorKey(accountId), "");
        pageToken = undefined;
        continue;
      }
      throw err;
    }

    if (total === null && page.resultSizeEstimate) ctx.update({ total: page.resultSizeEstimate });

    const fresh = store.filterUnknownIds(accountId, page.ids);
    for (let i = 0; i < fresh.length; i += META_CHUNK) {
      synced += (await fetchAndStore(accountId, fresh.slice(i, i + META_CHUNK), ctx, true)).length;
      ctx.update({ synced });
      ctx.bumpRevision();
    }

    pageToken = page.nextPageToken;
    store.setKv(cursorKey(accountId), pageToken ?? "");
    if (!pageToken) break;
  }

  ctx.assertActive();
  finishBackfill(accountId);
}

/** The category labels (Promotions, Social, …) IMAP doesn't carry, from API listings. */
async function fillCategories(accountId: string, ctx: SyncContext): Promise<void> {
  for (const label of store.getLabels(accountId)) {
    if (!label.id.startsWith("CATEGORY_")) continue;
    const ids = await listAllIds(accountId, label.id);
    ctx.assertActive();
    store.applyHistoryChanges(
      accountId,
      ids.map((id) => ({ kind: "labelsAdded", id, labelIds: [label.id] })),
    );
  }
  ctx.bumpRevision();
}

/**
 * After the history feed expired, Gmail can't say what changed while we were
 * away, so the cache is compared with the mailbox by listing ids (every
 * message's, then each label's) rather than re-reading every message: a page
 * of 500 ids costs what one message does. Cached mail gets its labels as
 * listed, mail Gmail no longer has is dropped, and what the cache lacks is
 * fetched.
 */
async function refreshMailbox(accountId: string, ctx: SyncContext): Promise<void> {
  logger.info("mail-sync", `comparing ${accountId} with Gmail's listings`);
  ctx.update({ phase: "full", synced: 0, total: null });
  // What the cache held before listing; rows written after are the feed's,
  // newer than the listing.
  const cached = store.getAllMessageLabels(accountId);
  const all = await listAllIds(accountId);
  ctx.update({ total: all.length });
  const listed = new Set(all);
  const members = new Map<string, Set<string>>();
  for (const label of store.getLabels(accountId)) {
    members.set(label.id, new Set(await listAllIds(accountId, label.id)));
  }

  ctx.assertActive();
  const ops: store.HistoryOp[] = [];
  for (const [id, labelIds] of cached) {
    if (!listed.has(id)) {
      ops.push({ kind: "deleted", id });
      continue;
    }
    const has = new Set(labelIds);
    const add = [...members].filter(([l, ids]) => ids.has(id) && !has.has(l)).map(([l]) => l);
    // Labels that weren't listed (Gmail's hidden ones) stay as they were.
    const remove = labelIds.filter((l) => members.get(l)?.has(id) === false);
    if (add.length > 0) ops.push({ kind: "labelsAdded", id, labelIds: add });
    if (remove.length > 0) ops.push({ kind: "labelsRemoved", id, labelIds: remove });
  }
  store.applyHistoryChanges(accountId, ops);
  if (ops.length > 0) ctx.bumpRevision();
  logger.info("mail-sync", `${ops.length} changes found comparing ${accountId}`);

  // What the cache lacks: mail that arrived while away (or never got cached).
  const missing = all.filter((id) => !cached.has(id));
  let synced = all.length - missing.length;
  ctx.update({ synced });
  for (let i = 0; i < missing.length; i += META_CHUNK) {
    synced += (await fetchAndStore(accountId, missing.slice(i, i + META_CHUNK), ctx, true)).length;
    ctx.update({ synced });
    ctx.bumpRevision();
  }

  ctx.assertActive();
  finishBackfill(accountId);
}

/** Every message id Gmail lists, newest first; with `labelId`, those carrying it. */
async function listAllIds(accountId: string, labelId?: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listMessageIdsPage(accountId, {
      pageToken,
      labelIds: labelId ? [labelId] : undefined,
    });
    ids.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Draft ids are re-checked when mail changed, else at most this often. */
const DRAFT_CHECK_MAX_AGE_MS = 10 * 60_000;
const draftCheckAt = new Map<string, number>();

/**
 * One cheap drafts.list: records each cached draft's id (opening a draft then
 * needs no Gmail lookup) and removes stale local draft rows — every draft
 * edit mints a new message id, so older copies (and drafts sent or deleted
 * elsewhere) would otherwise linger in Drafts and its count. Runs when the
 * history feed reported changes (drafts show up there) or every 10 minutes.
 */
async function learnDraftIds(
  accountId: string,
  mailChanged: boolean,
  ctx: SyncContext,
): Promise<void> {
  if (!mailChanged && Date.now() - (draftCheckAt.get(accountId) ?? 0) < DRAFT_CHECK_MAX_AGE_MS) {
    return;
  }
  const local = store.getMessageIdsForLabel(accountId, "DRAFT");
  if (local.length === 0) return;
  try {
    const listedAt = Date.now();
    const drafts = await listDraftIds(accountId);
    ctx.assertActive();
    draftCheckAt.set(accountId, listedAt);
    for (const d of drafts) store.setDraftId(accountId, d.messageId, d.draftId);
    // Only prune against a complete list (listDraftIds stops at 500).
    if (drafts.length < 500) {
      // Rows saved around the listing (a composer autosaving right now) may be
      // newer than it — leave anything from the last minute alone.
      const current = new Set(drafts.map((d) => d.messageId));
      const stale = store
        .getMessageDates(accountId, local)
        .filter((m) => !current.has(m.id) && m.date < listedAt - 60_000)
        .map((m) => m.id);
      for (const id of stale) store.deleteMessage(accountId, id);
      if (stale.length > 0) {
        logger.info("mail-sync", `removed ${stale.length} stale draft rows`);
        ctx.bumpRevision();
      }
    }
  } catch (err) {
    if (err instanceof SyncCancelled) throw err;
    logger.info("mail-sync", `draft id refresh skipped: ${describeError(err)}`);
  }
}

async function backfillSpamTrash(accountId: string, ctx: SyncContext): Promise<void> {
  for (const labelId of ["SPAM", "TRASH"]) {
    let pageToken: string | undefined;
    do {
      const page = await listMessageIdsPage(accountId, { pageToken, labelIds: [labelId] });
      const fresh = store.filterUnknownIds(accountId, page.ids);
      if (fresh.length > 0) {
        await fetchAndStore(accountId, fresh, ctx, true);
        ctx.bumpRevision();
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  store.setKv(spamTrashKey(accountId), "1");
  logger.info("mail-sync", `spam/trash backfill done for ${accountId}`);
}

/**
 * Replays the history feed since `historyId` (or since the seed of a backfill
 * that just finished). All pages are read before anything is written, so a
 * failure mid-feed leaves the cursor and cache untouched and the next run
 * replays the same delta. Returns the newly added messages and whether
 * anything changed.
 */
async function incrementalSync(
  accountId: string,
  historyId: string,
  ctx: SyncContext,
): Promise<{ added: MessageSummary[]; changed: boolean }> {
  ctx.update({ phase: "incremental", synced: 0 });

  const replay = store.getKv(replayKey(accountId)) || null;
  const startHistoryId = replay ?? historyId;
  const addedIds = new Set<string>();
  const ops: store.HistoryOp[] = [];
  let latestHistoryId = startHistoryId;
  let pageToken: string | undefined;

  try {
    do {
      const page = await listHistory(accountId, startHistoryId, pageToken);
      if (page.historyId) latestHistoryId = page.historyId;

      for (const entry of page.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          addedIds.add(added.message.id);
        }
        for (const deleted of entry.messagesDeleted ?? []) {
          ops.push({ kind: "deleted", id: deleted.message.id });
          addedIds.delete(deleted.message.id);
        }
        for (const change of entry.labelsAdded ?? []) {
          ops.push({ kind: "labelsAdded", id: change.message.id, labelIds: change.labelIds });
        }
        for (const change of entry.labelsRemoved ?? []) {
          ops.push({ kind: "labelsRemoved", id: change.message.id, labelIds: change.labelIds });
        }
      }

      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (err) {
    // Gmail purges history older than ~1 week: what changed meanwhile can't be
    // replayed. Start the feed over from now, and let a backfill compare the
    // cache with the mailbox.
    if (isHistoryExpiredError(err)) {
      await restartFeed(accountId, ctx);
      return { added: [], changed: false };
    }
    throw err;
  }

  ctx.assertActive();
  const { unknownIds } = store.applyHistoryChanges(accountId, ops);

  // New mail, plus mail the feed changed that the cache doesn't have (an
  // earlier run missed it, or a backfill hasn't got to it): both fetched with
  // current labels. A replay only needs what isn't cached; the rest just got
  // its changes.
  let ids = [...new Set([...addedIds, ...unknownIds])];
  if (replay) ids = store.filterUnknownIds(accountId, ids);
  let added: MessageSummary[] = [];
  if (ids.length > 0) {
    const fetched = await fetchAndStore(accountId, ids, ctx);
    store.recountLabels(
      accountId,
      fetched.flatMap((m) => m.labelIds),
    );
    added = fetched.filter((m) => addedIds.has(m.id));
    ctx.update({ synced: fetched.length });
  }

  const changed = ops.length > 0 || ids.length > 0;
  if (changed) ctx.bumpRevision();
  store.setSyncState(accountId, { historyId: latestHistoryId });
  if (replay && store.getKv(replayKey(accountId)) === replay) store.setKv(replayKey(accountId), "");
  return { added, changed };
}

/** The history feed expired: restart it from now and have a backfill compare the cache. */
async function restartFeed(accountId: string, ctx: SyncContext): Promise<void> {
  logger.info("mail-sync", `history expired for ${accountId}; refreshing the mailbox`);
  const { historyId } = await getProfile(accountId);
  if (!historyId) throw new Error("Gmail didn't say where the mailbox's history starts.");
  ctx.assertActive();
  store.setKv(seedKey(accountId), historyId);
  store.setKv(replayKey(accountId), "");
  store.setKv(refreshKey(accountId), "1");
  store.setSyncState(accountId, { historyId });
}
