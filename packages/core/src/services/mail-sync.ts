/**
 * mail-sync.ts
 *
 * Background sync engine that keeps the local SQLite cache (mail-store) in
 * step with each account's mail. What a sync run does is the provider's
 * (providers/: Gmail's full sync and history deltas); this engine decides
 * when runs happen and keeps their status.
 *
 * Three independent lanes per account, most urgent first:
 *  - sync: the provider's run (Gmail: the history delta, labels, draft ids).
 *    Always short, so new mail shows up on every push and tick.
 *  - backfill: long work on the whole mailbox (Gmail: the first sync, the
 *    refresh after its history feed expired), beside the sync lane so it
 *    never holds up new mail. The account reads as syncing while it runs.
 *  - downloads: full bodies for offline reading, newest first, once there's
 *    no backfill left. It can take a long time on a big mailbox and never
 *    holds up the others or the "Syncing…" status.
 *
 * Syncs run when the mailbox reports a change (Gmail pushes through the
 * relay, realtime.ts), on a timer, and when the user asks. The timer is only
 * a fallback for accounts that get pushes. Sync is fire-and-forget; the
 * renderer polls getSyncStatus() to show progress and refreshes its views
 * when `revision` says the cache changed.
 */

import { logger } from "../logger.js";
import { broadcast } from "../ipc.js";
import { mapPool } from "../pool.js";
import { findProvider, isSignedIn, providerFor, signedOutMessage } from "../providers/index.js";
import { SyncCancelled, type MailProvider } from "../providers/provider.js";
import { getAttachmentData, hasCachedAttachment } from "./attachment-cache.js";
import { listAccounts } from "./account-store.js";
import { platform } from "../platform.js";
import * as store from "./mail-store.js";
import { notifyNewMail, updateDockBadge } from "./notifier.js";
import type { GmailMessageDetail, SyncStatus } from "../types.js";

const statuses = new Map<string, SyncStatus>();
const running = new Set<string>();
const backfilling = new Set<string>();

function ensureStatus(accountId: string): SyncStatus {
  const existing = statuses.get(accountId);
  if (existing) return existing;
  const state = store.getSyncState(accountId);
  const status: SyncStatus = {
    accountId,
    syncing: false,
    phase: "idle",
    synced: 0,
    total: null,
    lastSyncAt: state.lastSyncAt,
    fullSyncDone: state.fullSyncDone,
    error: null,
    signInNeeded: false,
    download: null,
    revision: 0,
  };
  statuses.set(accountId, status);
  return status;
}

function update(accountId: string, patch: Partial<SyncStatus>): void {
  Object.assign(ensureStatus(accountId), patch);
}

/** The cache changed in a way lists show: the renderer refetches on a new revision. */
function bumpRevision(accountId: string): void {
  const status = ensureStatus(accountId);
  status.revision += 1;
}

export function getSyncStatus(accountId: string): SyncStatus {
  const status = ensureStatus(accountId);
  return { ...status, download: status.download ? { ...status.download } : null };
}

const lastFinishedAt = new Map<string, number>();
// Read-path triggers (list handlers refetching) must not restart a sync right
// after one finished: completion invalidates the renderer's queries, whose
// refetch hits those handlers again — without a cooldown that loops forever.
const READ_TRIGGER_COOLDOWN_MS = 20_000;

// ── Failure backoff ──────────────────────────────────────────────────────
// A failing account (offline, revoked sign-in, Gmail rate limits) is retried
// on a growing delay instead of on every timer tick and list refetch. Asking
// explicitly (Sync button, menu, switching to the account) always runs.

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
type Failures = Map<string, { count: number; retryAt: number }>;
const failures: Failures = new Map();
/** Backfills that failed: retried after a sync on the same growing delay. */
const backfillFailures: Failures = new Map();
/** A sync was requested while one ran: run once more when it ends (explicitly, or as a push, which respects backoff). */
const rerun = new Map<string, "explicit" | "push">();

function recordFailure(accountId: string, map = failures): void {
  const count = (map.get(accountId)?.count ?? 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS);
  map.set(accountId, { count, retryAt: Date.now() + delay });
}

// ── Push ─────────────────────────────────────────────────────────────────
// Accounts whose changes are pushed (Gmail's, through the relay; the Otter
// account keeps this current) sync on each push; the timer only checks on
// them every few minutes, in case a push got lost.

const PUSHED_POLL_MS = 5 * 60_000;
let pushedAccounts: ReadonlySet<string> = new Set();

export function setPushedAccounts(accountIds: Iterable<string>): void {
  pushedAccounts = new Set(accountIds);
}

// ── Watches ──────────────────────────────────────────────────────────────
// Providers that watch the mailbox from the device (IMAP IDLE) instead of
// through the relay: started with the account's first sync, stopped when
// it's removed or turned off; after sleep each checks its own connection.
// Once a watch reports, the account counts as pushed.

const watches = new Map<string, () => void>();
const watched = new Set<string>();

function startWatch(accountId: string): void {
  const watch = findProvider(accountId)?.watch;
  if (!watch || watches.has(accountId)) return;
  watches.set(
    accountId,
    watch(accountId, () => {
      watched.add(accountId);
      syncAccount(accountId, { force: true, trigger: "push" });
    }),
  );
}

function stopWatch(accountId: string): void {
  watches.get(accountId)?.();
  watches.delete(accountId);
  watched.delete(accountId);
}

const isPushed = (accountId: string) => pushedAccounts.has(accountId) || watched.has(accountId);

/**
 * Kick off a background sync for one account (no-op if one is already running).
 * `force` skips the post-sync cooldown (launch, timer, push, user); non-forced
 * calls are read-path triggers. `trigger: "timer" | "push"` still respects
 * failure backoff, which only an explicit request (`force` without a trigger)
 * skips. A push or explicit request arriving mid-run runs once more after it.
 */
/**
 * Mailboxes turned off in Settings → Mailboxes (the renderer's synced UI
 * preference `mail:mailboxes`, which names them by address, as account ids
 * do): left unsynced, so they cost no mail traffic and raise no
 * notifications. Turning one back on syncs it at once.
 */
let turnedOff = new Set<string>();

export const turnedOffMailboxes = (): ReadonlySet<string> => turnedOff;

export function followMailboxArrangement(value: string | undefined): void {
  let off: string[] = [];
  try {
    const parsed = (JSON.parse(value ?? "{}") as { off?: unknown }).off;
    if (Array.isArray(parsed)) off = parsed.filter((e): e is string => typeof e === "string");
  } catch {
    // Unreadable: treat every mailbox as on.
  }
  const was = turnedOff;
  turnedOff = new Set(off);
  for (const id of turnedOff) stopWatch(id);
  for (const id of was) if (!turnedOff.has(id)) syncAccount(id, { force: true });
  updateDockBadge();
}

export function syncAccount(
  accountId: string,
  opts?: { force?: boolean; trigger?: "timer" | "push" },
): void {
  const explicit = opts?.force === true && opts.trigger === undefined;
  if (running.has(accountId)) {
    if (explicit) rerun.set(accountId, "explicit");
    else if (opts?.trigger === "push" && !rerun.has(accountId)) rerun.set(accountId, "push");
    return;
  }
  // Re-added after removal: the old run has ended (not running), start fresh.
  removed.delete(accountId);
  if (turnedOff.has(accountId)) return;
  // Nothing to sync with until the account signs in again (Settings → Accounts).
  if (!isSignedIn(accountId)) {
    stopWatch(accountId);
    update(accountId, { syncing: false, error: signedOutMessage(accountId), signInNeeded: true });
    return;
  }
  startWatch(accountId);
  if (!explicit && Date.now() < (failures.get(accountId)?.retryAt ?? 0)) return;
  if (
    opts?.trigger === "timer" &&
    isPushed(accountId) &&
    Date.now() - (lastFinishedAt.get(accountId) ?? 0) < PUSHED_POLL_MS
  ) {
    return;
  }
  if (
    !opts?.force &&
    Date.now() - (lastFinishedAt.get(accountId) ?? 0) < READ_TRIGGER_COOLDOWN_MS
  ) {
    return;
  }
  running.add(accountId);
  // Wake the renderer's idle status polls so even short syncs show up.
  broadcast("gmail:sync-started");
  void runSync(accountId).finally(() => {
    running.delete(accountId);
    lastFinishedAt.set(accountId, Date.now());
    const again = rerun.get(accountId);
    rerun.delete(accountId);
    if (again && !removed.has(accountId)) {
      syncAccount(accountId, again === "push" ? { force: true, trigger: "push" } : { force: true });
    }
  });
}

/** Sync every connected account — launch, menu, and the auto timer force it. */
export async function syncAllAccounts(opts?: {
  force?: boolean;
  trigger?: "timer" | "push";
}): Promise<void> {
  try {
    const accounts = await listAccounts();
    for (const account of accounts) syncAccount(account.id, opts);
  } catch (err) {
    logger.error("mail-sync", `syncAllAccounts failed: ${String(err)}`);
  }
}

let autoSyncTimer: ReturnType<typeof setInterval> | null = null;

/** (Re)start the periodic pull-sync timer; 0 disables it. */
export function configureAutoSync(intervalSeconds: number): void {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }
  if (intervalSeconds > 0) {
    autoSyncTimer = setInterval(
      () => void syncAllAccounts({ force: true, trigger: "timer" }),
      intervalSeconds * 1000,
    );
  }
  logger.info(
    "mail-sync",
    `auto-sync ${intervalSeconds > 0 ? `every ${intervalSeconds}s` : "disabled"}`,
  );
}

// ── Account removal ───────────────────────────────────────────────────────
// A sync already in flight for a removed account must not write its mail
// back into the cache: every write point checks `assertActive`, which aborts
// the run with a SyncCancelled.

const removed = new Set<string>();

function assertActive(accountId: string): void {
  if (removed.has(accountId)) throw new SyncCancelled(accountId);
}

/** Stops syncing a removed account and drops its in-memory sync state. */
export function forgetAccount(accountId: string): void {
  removed.add(accountId);
  stopWatch(accountId);
  statuses.delete(accountId);
  lastFinishedAt.delete(accountId);
  failures.delete(accountId);
  backfillFailures.delete(accountId);
  rerun.delete(accountId);
}

/** A short, readable reason for the status line. */
function describeSyncError(accountId: string, err: unknown): string {
  const provider = findProvider(accountId);
  if (provider) return provider.describeError(err);
  const text = String(err);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/** Whether only signing in again (or the password, for IMAP) gets this account syncing again. */
function needsSignIn(accountId: string, provider: MailProvider, err: unknown): boolean {
  return !isSignedIn(accountId) || provider.errorKind(err) === "auth";
}

/** A sync run is background work: it only spends quota the user isn't using. */
function runSync(accountId: string): Promise<void> {
  const provider = providerFor(accountId);
  return provider.background("sync", () => runSyncNow(accountId, provider));
}

/**
 * Syncing while the sync or the backfill lane runs, showing the backfill's
 * progress over the sync's (its runs are brief next to it).
 */
function laneStatus(
  accountId: string,
  syncRunning = running.has(accountId),
): Pick<SyncStatus, "syncing" | "phase"> {
  if (backfilling.has(accountId)) return { syncing: true, phase: "full" };
  return syncRunning
    ? { syncing: true, phase: ensureStatus(accountId).phase }
    : { syncing: false, phase: "idle" };
}

async function runSyncNow(accountId: string, provider: MailProvider): Promise<void> {
  const { lastSyncAt } = store.getSyncState(accountId);
  // Stamped as the run's START: mail arriving while the run is busy is newer
  // than this and still gets notified next time.
  const startedAt = Date.now();
  // A backfill's progress stays on show while the sync lane runs beside it.
  const shown = (patch: Partial<SyncStatus>) => {
    if (!backfilling.has(accountId)) return patch;
    const { phase: _phase, synced: _synced, total: _total, ...rest } = patch;
    return rest;
  };
  update(accountId, shown({ syncing: true, error: null, synced: 0, total: null }));

  let synced = false;
  try {
    await provider.sync(accountId, {
      update: (patch) => update(accountId, shown(patch)),
      bumpRevision: () => bumpRevision(accountId),
      assertActive: () => assertActive(accountId),
      newMail: (messages) => notifyNewMail(accountId, messages, lastSyncAt),
    });

    assertActive(accountId);
    store.setSyncState(accountId, { lastSyncAt: startedAt });
    failures.delete(accountId);
    synced = true;
    update(accountId, {
      ...laneStatus(accountId, false),
      signInNeeded: false,
      lastSyncAt: startedAt,
      fullSyncDone: store.getSyncState(accountId).fullSyncDone,
    });
  } catch (err) {
    if (err instanceof SyncCancelled) {
      logger.info("mail-sync", err.message);
      return;
    }
    recordFailure(accountId);
    logger.error("mail-sync", `sync failed for ${accountId}: ${describeSyncError(accountId, err)}`);
    update(accountId, {
      ...laneStatus(accountId, false),
      error: describeSyncError(accountId, err),
      signInNeeded: needsSignIn(accountId, provider, err),
    });
    // The server refused the sign-in (the provider set it aside): nothing more
    // to try, IDLE included, until the user signs in again.
    if (!isSignedIn(accountId)) stopWatch(accountId);
  }

  updateDockBadge();
  if (!isSignedIn(accountId)) return;
  // Long work on the whole mailbox runs beside the sync lane once the feed is
  // current; offline bodies download after it, in their own lane.
  if (provider.needsBackfill?.(accountId)) {
    if (synced) startBackfill(accountId, provider);
  } else {
    startDownloads(accountId, provider);
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────
// The provider's long work (Gmail: the first sync of the whole mailbox, the
// refresh after its history feed expired), in its own lane and quota tier:
// the sync lane keeps running beside it, so new mail still comes in. Stopped
// work (quit, rate limits, sleep) picks up where it was after the next sync.

function startBackfill(accountId: string, provider: MailProvider): void {
  if (backfilling.has(accountId) || removed.has(accountId) || !provider.backfill) return;
  if (Date.now() < (backfillFailures.get(accountId)?.retryAt ?? 0)) return;
  backfilling.add(accountId);
  update(accountId, { ...laneStatus(accountId), synced: 0, total: null });
  broadcast("gmail:sync-started");
  const backfill = provider.backfill.bind(provider);
  void provider
    .background("backfill", () =>
      backfill(accountId, {
        update: (patch) => update(accountId, patch),
        bumpRevision: () => bumpRevision(accountId),
        assertActive: () => assertActive(accountId),
        // Nothing a backfill finds is new mail.
        newMail: async () => {},
      }),
    )
    .then(
      () => {
        backfillFailures.delete(accountId);
        backfilling.delete(accountId);
        update(accountId, {
          ...laneStatus(accountId),
          error: null,
          fullSyncDone: store.getSyncState(accountId).fullSyncDone,
        });
        bumpRevision(accountId);
        // Catch up on what changed meanwhile; that run starts the downloads.
        syncAccount(accountId, { force: true });
      },
      (err: unknown) => {
        backfilling.delete(accountId);
        if (err instanceof SyncCancelled) {
          logger.info("mail-sync", err.message);
          return;
        }
        recordFailure(accountId, backfillFailures);
        const reason = describeSyncError(accountId, err);
        logger.error("mail-sync", `backfill failed for ${accountId}: ${reason}`);
        update(accountId, {
          ...laneStatus(accountId),
          error: reason,
          signInNeeded: needsSignIn(accountId, provider, err),
        });
      },
    );
}

const PREFETCH_MAX_FILE_BYTES = 15 * 1024 * 1024;

/**
 * Cache the attachment bytes of every draft (drafts are few and editing one
 * re-uploads its files, so they must be in memory before the composer can
 * save). Other mail keeps fetching attachments lazily — getAttachmentData
 * write-through means anything opened once is cached from then on.
 */
async function prefetchDraftAttachments(accountId: string, provider: MailProvider): Promise<void> {
  for (const id of store.getMessageIdsForLabel(accountId, "DRAFT")) {
    assertActive(accountId);
    try {
      let detail = store.getMessageDetail(accountId, id);
      if (!detail) {
        detail = await provider.getMessage(accountId, id);
        assertActive(accountId);
        store.upsertMessageDetail(accountId, detail);
      }
      for (const att of detail.attachments) {
        if (att.size > PREFETCH_MAX_FILE_BYTES) continue;
        if (await hasCachedAttachment(accountId, id, att.id)) continue;
        await getAttachmentData(accountId, id, att.id);
      }
    } catch (err) {
      if (err instanceof SyncCancelled) throw err;
      logger.info(
        "mail-sync",
        `draft attachment prefetch skipped ${id}: ${describeSyncError(accountId, err)}`,
      );
    }
  }
}

// ── Offline downloads ────────────────────────────────────────────────────
// Full bodies for every message, newest first, so the whole mailbox reads
// offline. Runs as prefetch work (after the user and sync in the quota
// queue), in its own lane: a big backlog takes a while and must not keep the
// account "syncing" or delay new mail. A pass stops when the server pushes
// back (rate limit, offline) and the next sync starts a new one.

const downloading = new Set<string>();
const DOWNLOAD_CHUNK = 60;
const DOWNLOAD_CONCURRENCY = 6;

function startDownloads(accountId: string, provider: MailProvider): void {
  if (downloading.has(accountId) || removed.has(accountId)) return;
  downloading.add(accountId);
  void provider
    .background("prefetch", () => downloadBodies(accountId, provider))
    .catch((err: unknown) => {
      if (err instanceof SyncCancelled) return;
      logger.info(
        "mail-sync",
        `offline download paused for ${accountId}: ${describeSyncError(accountId, err)}`,
      );
    })
    .finally(() => {
      downloading.delete(accountId);
      if (statuses.has(accountId)) update(accountId, { download: null });
    });
}

async function downloadBodies(accountId: string, provider: MailProvider): Promise<void> {
  // A browser's storage is too small (and too easily evicted) for every body.
  const total = platform().offlineDownloads ? store.countUndownloaded(accountId) : 0;
  if (total > 0) {
    let done = 0;
    const attempted = new Set<string>();
    /** Messages whose thread failed to come whole: each goes on its own. */
    const singly = new Set<string>();
    update(accountId, { download: { done, total } });
    for (;;) {
      assertActive(accountId);
      if (provider.isCoolingDown?.(accountId)) break;
      const batch = store
        .getUndownloadedMessages(accountId, DOWNLOAD_CHUNK)
        .filter((m) => !attempted.has(m.id));
      if (batch.length === 0) break;
      // Two or more messages of a thread come in one request where the
      // provider can (Gmail's threads.get costs what two messages do).
      const threads = new Map<string, string[]>();
      for (const m of batch) {
        const key = provider.getThread && !singly.has(m.id) ? m.threadId : m.id;
        threads.set(key, [...(threads.get(key) ?? []), m.id]);
      }
      const jobs: { threadId: string | null; ids: string[] }[] = [...threads].map(
        ([threadId, ids]) => ({ threadId: ids.length > 1 ? threadId : null, ids }),
      );
      let pushedBack = false;
      // Written together once the chunk is in: one transaction, not sixty.
      const details: GmailMessageDetail[] = [];
      await mapPool(jobs, DOWNLOAD_CONCURRENCY, async ({ threadId, ids }) => {
        if (pushedBack || removed.has(accountId)) return;
        for (const id of ids) attempted.add(id);
        const id = ids[0]!;
        try {
          if (threadId) details.push(...(await provider.getThread!(accountId, threadId)));
          else details.push(await provider.getMessage(accountId, id));
        } catch (err) {
          if (err instanceof SyncCancelled) throw err;
          const kind = provider.errorKind(err);
          if (
            kind === "rateLimit" ||
            kind === "network" ||
            kind === "auth" ||
            !isSignedIn(accountId)
          ) {
            // Not the message's fault: leave it queued and end this pass.
            for (const each of ids) attempted.delete(each);
            pushedBack = true;
          } else if (threadId) {
            // Next time each message goes on its own, with its own outcome.
            for (const each of ids) {
              attempted.delete(each);
              singly.add(each);
            }
            return;
          } else if (kind === "notFound") {
            // Deleted on the server since it was listed (sync may have dropped it already).
            if (store.deleteMessage(accountId, id)) bumpRevision(accountId);
          } else {
            logger.info(
              "mail-sync",
              `body fetch failed for ${id}: ${describeSyncError(accountId, err)}`,
            );
            store.markBodyFetchFailed(accountId, id);
          }
        }
        done += ids.length;
        update(accountId, { download: { done: Math.min(done, total), total } });
      });
      assertActive(accountId);
      // Not mail the feed deleted meanwhile.
      const gone = new Set(
        store.filterUnknownIds(
          accountId,
          details.map((m) => m.id),
        ),
      );
      store.upsertMessageDetails(
        accountId,
        details.filter((m) => !gone.has(m.id)),
      );
      if (pushedBack) break;
    }
  }

  // Drafts' attachment bytes must be in memory before the composer can save.
  await prefetchDraftAttachments(accountId, provider);
}
