/**
 * Listing and searching on the server: pages of message ids for a label
 * (lists page past the cache while the backfill fills it), and search with
 * Outlook's own engine (KQL), Gmail's common operators translated:
 * `from:`, `to:`, `cc:`, `subject:`, `has:attachment`, `after:`/`before:`,
 * `newer_than:`/`older_than:`, `in:` a folder. What KQL can't say (`is:unread`,
 * `is:starred`, a category) is checked on each result.
 */

import { categoryOf, folderOfLabel, labelsFor } from "./folders.js";
import { graph, type Page } from "./graph.js";
import type { ApiMessage } from "./messages.js";

const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A `$filter` condition for a label that isn't a folder (null: it is one, or unknown). */
function filterFor(labelId: string): string | null {
  if (labelId === "UNREAD") return "isRead eq false";
  if (labelId === "STARRED") return "flag/flagStatus eq 'flagged'";
  if (labelId === "IMPORTANT") return "importance eq 'high'";
  const category = categoryOf(labelId);
  return category !== null ? `categories/any(c:c eq ${quote(category)})` : null;
}

/** Where to list from: a folder's messages, or the whole mailbox's. */
async function scope(accountId: string, labelIds: string[]) {
  for (const labelId of labelIds) {
    const folder = await folderOfLabel(accountId, labelId);
    if (folder) return `/me/mailFolders/${encodeURIComponent(folder)}/messages`;
  }
  return "/me/messages";
}

export async function listIds(
  accountId: string,
  params: { labelIds?: string[]; pageToken?: string; maxResults?: number },
): Promise<{ ids: string[]; nextPageToken?: string }> {
  let url = params.pageToken;
  if (!url) {
    const labelIds = params.labelIds ?? [];
    const filters = labelIds.map(filterFor).filter((f): f is string => f !== null);
    const query = new URLSearchParams({
      $select: "id",
      $top: String(Math.min(params.maxResults ?? 100, 500)),
    });
    if (filters.length > 0) query.set("$filter", filters.join(" and "));
    else query.set("$orderby", "receivedDateTime desc");
    url = `${await scope(accountId, labelIds)}?${query.toString()}`;
  }
  const page = await graph<Page<{ id: string }>>(accountId, url);
  return {
    ids: (page.value ?? []).map((m) => m.id),
    nextPageToken: page["@odata.nextLink"],
  };
}

// ── Search ──────────────────────────────────────────────────────────────────

type Operator = { key: string; value: string; negated: boolean };

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
const AGE_DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };
const slug = (name: string) => name.toLowerCase().replace(/[\s/]+/g, "-");
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
/** KQL takes words and quoted phrases; quotes inside a value would end it. */
const term = (value: string) =>
  /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value.replace(/"/g, "");

/** Gmail's query, split into its operators and its free text. */
function parse(q: string): { ops: Operator[]; text: string } {
  const ops = [...q.matchAll(/(^|\s)(-?)([a-z_]+):("[^"]*"|\S+)/gi)].map((m) => {
    const op = {
      key: m[3].toLowerCase(),
      value: m[4].replace(/^"|"$/g, ""),
      negated: m[2] === "-",
    };
    // `is:read` is `-is:unread`.
    return op.key === "is" && op.value.toLowerCase() === "read"
      ? { ...op, value: "unread", negated: !op.negated }
      : op;
  });
  const text = q
    .replace(/(^|\s)-?[a-z_]+:("[^"]*"|\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { ops, text };
}

/** The KQL an operator stands for; null when KQL can't say it. */
function kql(op: Operator): string | null {
  const value = op.value;
  switch (op.key) {
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
      return `${op.key}:${term(value)}`;
    case "has":
      return value.toLowerCase() === "attachment" ? "hasattachments:true" : null;
    case "after":
    case "before": {
      const time = new Date(value.replace(/\//g, "-")).getTime();
      if (Number.isNaN(time)) return null;
      return `received${op.key === "after" ? ">=" : "<"}${day(time)}`;
    }
    case "newer_than":
    case "older_than": {
      const age = /^(\d+)([dwmy])$/i.exec(value);
      if (!age) return null;
      const cutoff = Date.now() - Number(age[1]) * AGE_DAYS[age[2].toLowerCase()] * DAY_MS;
      return `received${op.key === "newer_than" ? ">=" : "<"}${day(cutoff)}`;
    }
    default:
      return null;
  }
}

/** The label an `in:`, `is:` or `label:` operator names, if any. */
function labelOf(op: Operator, labels: { id: string; name: string }[]): string | null {
  const value = op.value.toLowerCase();
  if ((op.key === "in" || op.key === "is") && SYSTEM_LABELS[value]) return SYSTEM_LABELS[value];
  if (op.key !== "in" && op.key !== "label") return null;
  return (
    labels.find((l) => slug(l.name) === slug(value) || l.id.toLowerCase() === value)?.id ?? null
  );
}

export async function search(
  accountId: string,
  q: string,
  pageToken: string | undefined,
  maxResults: number,
  labels: { id: string; name: string }[],
): Promise<{
  refs: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}> {
  const { ops, text } = parse(q);
  // `in:` a folder is where to search; other labels are checked on each result.
  const wanted = ops
    .map((op) => ({ op, label: labelOf(op, labels) }))
    .filter((x): x is { op: Operator; label: string } => x.label !== null);
  let folder: string | null = null;
  for (const { op, label } of wanted) {
    if (op.negated) continue;
    folder = await folderOfLabel(accountId, label);
    if (folder) break;
  }

  let url = pageToken;
  if (!url) {
    const terms = [
      ...text.split(" ").filter(Boolean).map(term),
      ...ops.flatMap((op) => {
        const t = kql(op);
        return t ? [op.negated ? `NOT ${t}` : t] : [];
      }),
    ];
    const query = new URLSearchParams({
      $select: "id,conversationId,parentFolderId,isRead,flag,importance,categories",
      $top: String(maxResults),
    });
    const filters = wanted.flatMap(({ op, label }) => {
      const f = op.negated ? null : filterFor(label);
      return f ? [f] : [];
    });
    if (terms.length > 0) query.set("$search", `"${terms.join(" ").replace(/"/g, '\\"')}"`);
    // Graph can't search and filter at once: filter only when there's nothing to search.
    else if (filters.length > 0) query.set("$filter", filters.join(" and "));
    else query.set("$orderby", "receivedDateTime desc");
    url = `${folder ? `/me/mailFolders/${encodeURIComponent(folder)}/messages` : "/me/messages"}?${query.toString()}`;
  }

  const page = await graph<Page<ApiMessage>>(accountId, url);
  const refs = (page.value ?? [])
    .filter((message) => {
      const has = new Set(labelsFor(accountId, message));
      return wanted.every(({ op, label }) => {
        // `in:` a folder was searched in already.
        if (label === folder && !op.negated) return true;
        return has.has(label) !== op.negated;
      });
    })
    .map((message) => ({ id: message.id, threadId: message.conversationId || message.id }));
  const next = page["@odata.nextLink"];
  return {
    refs,
    nextPageToken: next,
    resultSizeEstimate: refs.length + (next ? maxResults : 0),
  };
}
