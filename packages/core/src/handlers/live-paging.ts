/**
 * Keeps lists usable while an account's mail is still arriving: live paging
 * from the server during the first full sync (providers that list by label),
 * and pulling in unread mail the cache doesn't have yet.
 */

import { findProvider, isSignedIn, providerFor } from "../providers/index.js";
import * as mailStore from "../services/mail-store.js";
import type { MessageSummary } from "../types.js";
import { sleep } from "./ipc-budget.js";
import { hasPendingLabelWrites } from "../services/pending-label-writes.js";

// ── Live paging while an account's first full sync is still running ────────
// Lists read the local cache, which on a big mailbox fills in over a long
// time. When a page comes up short for an account that isn't fully synced,
// pull that label's next page straight from Gmail (per account+label cursor)
// so scrolling keeps going. Budgeted to stay well under the renderer's 5s IPC
// timeout; the renderer simply asks again for the rest.

type LiveCursor = { pageToken?: string; exhausted: boolean };
const liveCursors = new Map<string, LiveCursor>();
// Total list reply stays under ~3.5s (unread check ≤1s + fills ≤2.5s) — the
// renderer's IPC timeout is 5s, and a timed-out first page never renders.
const LIVE_BUDGET_MS = 2500;
const LIVE_PAGE_SIZE = 50;

const liveKey = (accountId: string, labelId: string | null) => `${accountId}:${labelId ?? "*"}`;

function needsLive(accountId: string, labelId: string | null): boolean {
  if (mailStore.getSyncState(accountId).fullSyncDone) return false;
  // Nothing to page from until the account signs in on this device.
  if (!isSignedIn(accountId) || !findProvider(accountId)?.listIds) return false;
  return !(liveCursors.get(liveKey(accountId, labelId))?.exhausted ?? false);
}

const inflightFills = new Map<string, Promise<void>>();

/** Drops a removed account's live-paging cursors. */
export function forgetLiveCursors(accountId: string): void {
  for (const key of liveCursors.keys()) {
    if (key.startsWith(`${accountId}:`)) liveCursors.delete(key);
  }
}

/** Fetches and caches the next live page of a label (null = all mail). One
    fetch per cursor at a time: callers that time out leave it running, and
    the next request joins it instead of starting another. */
function fillFromServer(accountId: string, labelId: string | null): Promise<void> {
  const key = liveKey(accountId, labelId);
  const running = inflightFills.get(key);
  if (running) return running;
  const fill = fillOnce(accountId, labelId).finally(() => inflightFills.delete(key));
  inflightFills.set(key, fill);
  return fill;
}

async function fillOnce(accountId: string, labelId: string | null): Promise<void> {
  const key = liveKey(accountId, labelId);
  const cursor = liveCursors.get(key) ?? { exhausted: false };
  if (cursor.exhausted) return;
  const provider = providerFor(accountId);
  const page = await provider.listIds!(accountId, {
    labelIds: labelId ? [labelId] : [],
    pageToken: cursor.pageToken,
    maxResults: LIVE_PAGE_SIZE,
  });
  const fresh = mailStore.filterUnknownIds(accountId, page.ids);
  if (fresh.length > 0)
    mailStore.upsertMessages(accountId, await provider.getSummaries(accountId, fresh));
  liveCursors.set(key, { pageToken: page.nextPageToken, exhausted: !page.nextPageToken });
  console.log("[gmail:livePage]", { labelId, listed: page.ids.length, fetched: fresh.length });
}

/**
 * Re-reads `read()` after live fills until the page is full, Gmail has no
 * more, or the time budget runs out. `more` = keep offering a next page.
 */
export async function pageWithLiveFill(
  sources: { accountId: string; labelId: string | null }[],
  maxResults: number,
  read: () => { messages: MessageSummary[]; hasMore: boolean },
): Promise<{ messages: MessageSummary[]; more: boolean }> {
  const started = Date.now();
  let page = read();
  const pending = () => sources.filter((src) => needsLive(src.accountId, src.labelId));
  while (!page.hasMore && page.messages.length < maxResults && pending().length > 0) {
    const left = LIVE_BUDGET_MS - (Date.now() - started);
    if (left <= 0) break;
    // Gmail can stall (rate-limit backoff waits up to 32s): answer with what's
    // cached when the budget runs out; the fill keeps going in the background.
    const fills = Promise.all(pending().map((src) => fillFromServer(src.accountId, src.labelId)));
    fills.catch((err) => console.log("[gmail:livePage] failed", { error: String(err) }));
    const done = await Promise.race([
      fills.then(
        () => true,
        () => false,
      ),
      sleep(left).then(() => false),
    ]);
    page = read();
    if (!done) break;
  }
  return { messages: page.messages, more: page.hasMore || pending().length > 0 };
}

const RECONCILE_COOLDOWN_MS = 60_000;
const lastUnreadReconcile = new Map<string, number>();

/** Fetches a label's unread messages live when the cache has fewer than the server counts. */
export async function reconcileUnread(accountId: string, labelId: string): Promise<void> {
  const provider = findProvider(accountId);
  if (!provider?.listIds) return;
  const expected = mailStore.getLabelUnread(accountId, labelId);
  if (expected === 0 || mailStore.countUnreadForLabel(accountId, labelId) >= expected) return;
  // Mid-triage the cache is ahead of the server's counter (mail just read or
  // archived here), so the gap is expected, not missing mail.
  if (hasPendingLabelWrites(accountId)) return;
  const key = `${accountId}:${labelId}`;
  if (Date.now() - (lastUnreadReconcile.get(key) ?? 0) < RECONCILE_COOLDOWN_MS) return;
  lastUnreadReconcile.set(key, Date.now());
  try {
    const { ids } = await provider.listIds(accountId, {
      labelIds: [labelId, "UNREAD"],
      maxResults: Math.min(expected, 100),
      spamTrash: false,
    });
    const live = ids.length > 0 ? await provider.getSummaries(accountId, ids) : [];
    mailStore.upsertMessages(accountId, live);
    console.log("[gmail:listMessages] reconciled unread", {
      labelId,
      expected,
      fetched: live.length,
    });
  } catch (err) {
    console.log("[gmail:listMessages] unread reconcile failed", { error: String(err) });
  }
}
