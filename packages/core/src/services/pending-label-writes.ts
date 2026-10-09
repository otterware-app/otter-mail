/**
 * Label changes the app has made locally that Gmail may not reflect yet.
 *
 * Archive, trash, read/unread and labelling write the local cache first and
 * reach Gmail a moment later. Anything read from Gmail in between (the unread
 * reconcile, live paging, a sync's metadata fetch) still shows the old labels,
 * and storing it as-is undid the change: an archived conversation popped back
 * into the Inbox. Every such read goes through `upsertMessages`, which re-applies
 * these pending changes on top. A change stays pending while its write is in
 * flight and for a grace period after (reads that started before it landed can
 * still arrive); a failed write drops it, so its local revert sticks.
 */

import type { GmailMessageSummary } from "../types.js";

/** How long a landed write keeps overriding what Gmail reports. */
const SETTLED_GRACE_MS = 30_000;

type PendingChange = { add: string[]; remove: string[]; until: number };

/** `${accountId}:${messageId}` → changes, oldest first (so undo-after-archive
    replays in order). */
const pending = new Map<string, PendingChange[]>();

const keyOf = (accountId: string, messageId: string) => `${accountId}:${messageId}`;

function live(key: string, now = Date.now()): PendingChange[] {
  const changes = pending.get(key)?.filter((c) => c.until > now) ?? [];
  if (changes.length === 0) pending.delete(key);
  else pending.set(key, changes);
  return changes;
}

/**
 * Records a label change as pending until its Gmail write settles. Call
 * `settled()` when Gmail confirmed it (it then lingers for the grace period)
 * or `dropped()` when the write failed.
 */
export function trackLabelWrite(
  accountId: string,
  messageIds: string[],
  add: string[],
  remove: string[],
): { settled: () => void; dropped: () => void } {
  const change: PendingChange = { add, remove, until: Number.POSITIVE_INFINITY };
  const keys = messageIds.map((id) => keyOf(accountId, id));
  for (const key of keys) pending.set(key, [...live(key), change]);
  return {
    settled: () => {
      change.until = Date.now() + SETTLED_GRACE_MS;
    },
    dropped: () => {
      for (const key of keys) {
        const rest = (pending.get(key) ?? []).filter((c) => c !== change);
        if (rest.length === 0) pending.delete(key);
        else pending.set(key, rest);
      }
    },
  };
}

/**
 * A label's id changed (Outlook's categories are named by their id): pending
 * changes carry the new one, so they don't bring the old one back.
 */
export function renamePendingLabel(accountId: string, from: string, to: string): void {
  const prefix = `${accountId}:`;
  const swap = (ids: string[]) => ids.map((id) => (id === from ? to : id));
  for (const [key, changes] of pending) {
    if (!key.startsWith(prefix)) continue;
    for (const change of changes) {
      change.add = swap(change.add);
      change.remove = swap(change.remove);
    }
  }
}

/** Whether any label write for the account is still pending. */
export function hasPendingLabelWrites(accountId: string): boolean {
  const prefix = `${accountId}:`;
  for (const key of pending.keys()) {
    if (key.startsWith(prefix) && live(key).length > 0) return true;
  }
  return false;
}

/** Messages read from Gmail, with this app's pending label changes re-applied. */
export function withPendingLabels<T extends GmailMessageSummary>(
  accountId: string,
  messages: T[],
): T[] {
  if (pending.size === 0) return messages;
  const now = Date.now();
  return messages.map((m) => {
    const changes = live(keyOf(accountId, m.id), now);
    if (changes.length === 0) return m;
    const labels = new Set(m.labelIds);
    for (const c of changes) {
      for (const l of c.remove) labels.delete(l);
      for (const l of c.add) labels.add(l);
    }
    const labelIds = [...labels];
    return { ...m, labelIds, unread: labels.has("UNREAD"), starred: labels.has("STARRED") };
  });
}
