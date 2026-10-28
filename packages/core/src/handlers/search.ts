/**
 * Search, Gmail's way: every query runs through the server's own search
 * (Gmail's engine: all operators, all mail, attachments and recipients
 * included), so results are the truth rather than whatever this device
 * happens to have cached. Results are conversations, newest first, merged
 * across the accounts in scope; only matches missing from the cache are
 * fetched. Offline, it falls back to the local index and says so, as do
 * providers without server search.
 */

import { handle } from "../ipc.js";
import { logger } from "../logger.js";
import { providerFor } from "../providers/index.js";
import * as mailStore from "../services/mail-store.js";
import { runAsTask } from "./ipc-budget.js";
import type { MessageSummary } from "../types.js";

const PAGE_SIZE = 50;

/** Per-account Gmail page cursor; null once that account has no more results. */
type Cursors = Record<string, string | null>;

type SearchResult = {
  messages: MessageSummary[];
  /** Next page's cursors; undefined when every account is exhausted. */
  cursors?: Cursors;
  /** Gmail's estimate of total matches across the accounts. */
  estimate: number;
  /** Gmail was unreachable: these are local results only. */
  offline?: boolean;
};

/** One account's page: the server's matches, cached first, as conversation rows. */
async function searchAccount(
  accountId: string,
  q: string,
  cursor: string | undefined,
): Promise<{ rows: MessageSummary[]; next: string | null; estimate: number }> {
  const provider = providerFor(accountId);
  if (!provider.search) {
    const local = searchLocal(accountId, q);
    return { rows: local, next: null, estimate: local.length };
  }
  const page = await provider.search(accountId, q, cursor, PAGE_SIZE);
  const unknown = mailStore.filterUnknownIds(
    accountId,
    page.refs.map((r) => r.id),
  );
  if (unknown.length > 0) {
    mailStore.upsertMessages(accountId, await provider.getSummaries(accountId, unknown));
  }
  const threadIds = [...new Set(page.refs.map((r) => r.threadId))];
  const rows = mailStore.getThreadSummaries(accountId, threadIds).map((m) => ({ ...m, accountId }));
  return { rows, next: page.nextPageToken ?? null, estimate: page.resultSizeEstimate };
}

// ── Local search, for providers without their own (IMAP) ───────────────────

const SYSTEM_LABELS: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  drafts: "DRAFT",
  spam: "SPAM",
  junk: "SPAM",
  trash: "TRASH",
  starred: "STARRED",
  flagged: "STARRED",
  unread: "UNREAD",
  important: "IMPORTANT",
};
const DAY_MS = 86_400_000;
const AGE_MS: Record<string, number> = {
  d: DAY_MS,
  w: 7 * DAY_MS,
  m: 30 * DAY_MS,
  y: 365 * DAY_MS,
};
const slug = (name: string) => name.toLowerCase().replace(/[\s/]+/g, "-");

type Operator = { key: string; value: string; negated: boolean };

function operatorsOf(q: string): Operator[] {
  return [...q.matchAll(/(^|\s)(-?)([a-z_]+):("[^"]*"|\S+)/gi)].map((m) => ({
    key: m[3].toLowerCase(),
    value: m[4].replace(/^"|"$/g, "").toLowerCase(),
    negated: m[2] === "-",
  }));
}

/** The label `in:` or `label:` names (`in:inbox`, `label:projects-otter`), or null. */
function labelOf(accountId: string, op: Operator): string | null {
  if (op.key === "in" || op.key === "is") {
    if (SYSTEM_LABELS[op.value]) return SYSTEM_LABELS[op.value];
  }
  if (op.key !== "in" && op.key !== "label") return null;
  const label = mailStore
    .getLabels(accountId)
    .find((l) => slug(l.name) === slug(op.value) || l.id.toLowerCase() === op.value);
  return label?.id ?? null;
}

/** Whether a cached message matches one operator; ones this can't judge match. */
function matches(accountId: string, m: MessageSummary, op: Operator): boolean {
  const includes = (...texts: (string | undefined)[]) =>
    texts.some((t) => t?.toLowerCase().includes(op.value));
  switch (op.key) {
    case "in":
    case "label":
    case "is": {
      if (op.value === "anywhere") return true;
      if (op.value === "read") return !m.labelIds.includes("UNREAD");
      const label = labelOf(accountId, op);
      return label !== null && m.labelIds.includes(label);
    }
    case "from":
      return includes(m.fromName, m.fromEmail);
    case "to":
      return includes(m.to);
    case "subject":
      return includes(m.subject);
    case "has":
      return op.value !== "attachment" || m.hasAttachments;
    case "older_than":
    case "newer_than": {
      const age = /^(\d+)([dwmy])$/.exec(op.value);
      if (!age) return true;
      const cutoff = Date.now() - Number(age[1]) * AGE_MS[age[2]];
      return op.key === "older_than" ? m.date < cutoff : m.date > cutoff;
    }
    case "after":
    case "before": {
      const time = new Date(op.value.replace(/\//g, "-")).getTime();
      if (Number.isNaN(time)) return true;
      return op.key === "after" ? m.date >= time : m.date < time;
    }
    default:
      return true;
  }
}

/**
 * Search in the local index, with Gmail's common operators (`in:`, `from:`,
 * `is:unread`, `has:attachment`, `newer_than:`…) applied to what it finds, so
 * the search bar and its chips work the same on mailboxes without server search.
 */
function searchLocal(accountId: string, q: string): MessageSummary[] {
  const ops = operatorsOf(q);
  // The first label it names (`in:inbox`, `is:unread`) is where to look.
  const labelId = ops
    .filter((op) => !op.negated)
    .map((op) => labelOf(accountId, op))
    .find((id) => id !== null);
  // `from:` and `subject:` are in the index too, so they narrow it down.
  const text = [
    freeText(q),
    ...ops
      .filter((op) => !op.negated && (op.key === "from" || op.key === "subject"))
      .map((op) => op.value),
  ].join(" ");
  const attachments = ops.some((op) => op.key === "has" && op.value === "attachment");
  const found = mailStore.searchMessages(text, accountId, 0, 500, {
    labelId: labelId ?? undefined,
    hasAttachments: attachments || undefined,
  }).messages;
  return found
    .filter((m) => ops.every((op) => matches(accountId, m, op) !== op.negated))
    .slice(0, PAGE_SIZE);
}

/** Network failures (not Gmail errors) mean offline. */
function isOffline(error: unknown): boolean {
  const text = String(error);
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(text);
}

/** Free text of a Gmail query, for the offline fallback (operators dropped). */
function freeText(q: string): string {
  return q
    .replace(/(^|\s)-?[a-z_]+:("[^"]*"|\([^)]*\)|\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function searchMail(
  q: string,
  accountIds: string[],
  cursors?: Cursors,
): Promise<SearchResult> {
  const active = accountIds.filter((id) => !cursors || cursors[id] !== null);
  const settled = await Promise.allSettled(
    active.map((id) => searchAccount(id, q, cursors?.[id] ?? undefined)),
  );

  const failures = settled.filter((s) => s.status === "rejected");
  if (failures.length === settled.length && failures.length > 0) {
    const reason = (failures[0] as PromiseRejectedResult).reason;
    if (!isOffline(reason)) throw reason;
    logger.info("search", "offline, using the local index", { q });
    const text = freeText(q);
    const local = text
      ? mailStore.searchMessages(text, accountIds.length === 1 ? accountIds[0] : null, 0, PAGE_SIZE)
      : { messages: [] };
    return { messages: local.messages, estimate: local.messages.length, offline: true };
  }

  const next: Cursors = { ...cursors };
  let estimate = 0;
  const rows: MessageSummary[] = [];
  settled.forEach((s, i) => {
    const accountId = active[i];
    if (s.status === "fulfilled") {
      rows.push(...s.value.rows);
      next[accountId] = s.value.next;
      estimate += s.value.estimate;
    } else {
      logger.info("search", "account search failed", { accountId, error: String(s.reason) });
      next[accountId] = null;
    }
  });
  for (const id of accountIds) if (!(id in next)) next[id] = null;
  rows.sort((a, b) => b.date - a.date);
  const more = Object.values(next).some((c) => c !== null);
  return { messages: rows, cursors: more ? next : undefined, estimate };
}

export function registerSearchHandlers(): void {
  // gmail:search — Gmail's own search. Runs as a task: a cold query can fetch
  // up to 50 uncached matches per account, past the 5s IPC budget.
  handle("gmail:search", async (params: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const q = typeof p?.q === "string" ? p.q.trim() : "";
    const accountIds = Array.isArray(p?.accountIds)
      ? p.accountIds.filter((id): id is string => typeof id === "string")
      : [];
    const cursors =
      p?.cursors && typeof p.cursors === "object" ? (p.cursors as Cursors) : undefined;
    const taskId = typeof p?.taskId === "string" ? p.taskId : undefined;
    if (!q || accountIds.length === 0) return { messages: [], estimate: 0 };
    logger.info("search", "gmail search", { accounts: accountIds.length, paged: Boolean(cursors) });
    return runAsTask(taskId, () => searchMail(q, accountIds, cursors));
  });
}
