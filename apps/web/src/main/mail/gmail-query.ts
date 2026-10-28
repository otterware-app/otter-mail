/**
 * Gmail search queries as text, the way Gmail treats them: the search chips
 * and the advanced-search form only edit operators in the query string
 * (`from:`, `has:attachment`, `after:`…), and the string is what runs.
 */

export const SEARCH_MAILBOX = "__search__";

// ---------------------------------------------------------------------------
// The mailbox you search from, as Gmail operators (⌘F prefills it)
// ---------------------------------------------------------------------------

const SYSTEM_OPERATORS: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  STARRED: "is:starred",
  IMPORTANT: "is:important",
  UNREAD: "is:unread",
  SPAM: "in:spam",
  TRASH: "in:trash",
  CHAT: "in:chats",
  CATEGORY_PERSONAL: "category:primary",
  CATEGORY_SOCIAL: "category:social",
  CATEGORY_PROMOTIONS: "category:promotions",
  CATEGORY_UPDATES: "category:updates",
  CATEGORY_FORUMS: "category:forums",
};

/** A label as Gmail writes it in the search bar: `in:inbox`, `label:clients-acme`. */
export function labelSearchToken(labelId: string, labelName: string | null): string | null {
  const system = SYSTEM_OPERATORS[labelId];
  if (system) return system;
  if (!labelName) return null;
  // Gmail's own form: spaces and nesting slashes become dashes.
  return `label:${labelName.trim().replace(/[\s/]+/g, "-")}`;
}

/**
 * A mailbox view's rules as one query. Rules that differ per account are
 * OR-ed with Gmail's `{ }`; a rule taking all of an account's mail means the
 * view has no label restriction at all.
 */
export function viewSearchQuery(
  rules: { accountId: string; allOf: string[]; noneOf: string[] }[],
  nameOf: (accountId: string, labelId: string) => string | null,
): string {
  const clauses = rules.map((r) =>
    [
      ...r.allOf.map((id) => labelSearchToken(id, nameOf(r.accountId, id))),
      ...r.noneOf.map((id) => {
        const token = labelSearchToken(id, nameOf(r.accountId, id));
        return token ? `-${token}` : null;
      }),
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (clauses.length === 0 || clauses.some((c) => !c)) return "";
  const distinct = [...new Set(clauses)];
  if (distinct.length === 1) return distinct[0];
  return `{${distinct.map((c) => (c.includes(" ") ? `(${c})` : c)).join(" ")}}`;
}

/** One `key:value` operator; the value keeps its quotes/parens verbatim. */
type Operator = { key: string; value: string; negated: boolean; raw: string };

const OPERATOR_RE = /(^|\s)(-?)([a-z_]+):("[^"]*"|\([^)]*\)|\S+)/gi;

export function parseOperators(q: string): Operator[] {
  return [...q.matchAll(OPERATOR_RE)].map((m) => ({
    key: m[3].toLowerCase(),
    value: m[4],
    negated: m[2] === "-",
    raw: `${m[2]}${m[3]}:${m[4]}`,
  }));
}

/** The query without any operators (the free text Gmail matches everywhere). */
export function freeText(q: string): string {
  return q.replace(OPERATOR_RE, " ").replace(/\s+/g, " ").trim();
}

function tidy(q: string): string {
  return q.replace(/\s+/g, " ").trim();
}

/** Quote values with spaces, like Gmail writes them. */
function quote(value: string): string {
  const v = value.trim();
  return /\s/.test(v) && !/^["(]/.test(v) ? `"${v}"` : v;
}

/** Value of the first non-negated `key:` operator, unquoted. */
export function getOperator(q: string, key: string): string | null {
  const op = parseOperators(q).find((o) => o.key === key && !o.negated);
  return op ? op.value.replace(/^"(.*)"$/, "$1") : null;
}

/** Replaces every `key:` operator with `key:value` (or removes them for null). */
export function setOperator(q: string, key: string, value: string | null): string {
  let next = q;
  for (const op of parseOperators(q)) {
    if (op.key === key && !op.negated) next = next.replace(op.raw, " ");
  }
  return tidy(value === null || value.trim() === "" ? next : `${next} ${key}:${quote(value)}`);
}

/** Whether an exact token (`has:attachment`, `is:unread`) is in the query. */
export function hasToken(q: string, token: string): boolean {
  return parseOperators(q).some((o) => !o.negated && `${o.key}:${o.value}`.toLowerCase() === token);
}

export function toggleToken(q: string, token: string): string {
  if (!hasToken(q, token)) return tidy(`${q} ${token}`);
  let next = q;
  for (const op of parseOperators(q)) {
    if (!op.negated && `${op.key}:${op.value}`.toLowerCase() === token)
      next = next.replace(op.raw, " ");
  }
  return tidy(next);
}

// ---------------------------------------------------------------------------
// Dates ("Any time" chip, advanced search's "Date within")
// ---------------------------------------------------------------------------

export const TIME_PRESETS = [
  { label: "Older than a week", value: "older_than:7d" },
  { label: "Older than a month", value: "older_than:1m" },
  { label: "Older than 6 months", value: "older_than:6m" },
  { label: "Older than a year", value: "older_than:1y" },
  { label: "Newer than a week", value: "newer_than:7d" },
  { label: "Newer than a month", value: "newer_than:1m" },
] as const;

const DATE_KEYS = ["older_than", "newer_than", "after", "before", "older", "newer"];

export function clearDates(q: string): string {
  return DATE_KEYS.reduce((acc, key) => setOperator(acc, key, null), q);
}

/** Label for the "Any time" chip given the query's date operators. */
export function timeLabel(q: string): string | null {
  const preset = TIME_PRESETS.find((p) => hasToken(q, p.value));
  if (preset) return preset.label;
  const after = getOperator(q, "after");
  const before = getOperator(q, "before");
  if (after && before) return `${after} – ${before}`;
  if (after) return `After ${after}`;
  if (before) return `Before ${before}`;
  return null;
}

/** Gmail's yyyy/mm/dd. */
export function gmailDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

// ---------------------------------------------------------------------------
// Advanced search (Gmail's "Show search options" form)
// ---------------------------------------------------------------------------

export const DATE_WITHIN = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
  { label: "2 months", days: 60 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
] as const;

export const SEARCH_IN = [
  { label: "All Mail", value: "" },
  { label: "Inbox", value: "in:inbox" },
  { label: "Starred", value: "is:starred" },
  { label: "Sent Mail", value: "in:sent" },
  { label: "Drafts", value: "in:drafts" },
  { label: "Important", value: "is:important" },
  { label: "Unread Mail", value: "is:unread" },
  { label: "Read Mail", value: "is:read" },
  { label: "Spam", value: "in:spam" },
  { label: "Trash", value: "in:trash" },
  { label: "Mail & Spam & Trash", value: "in:anywhere" },
] as const;

export type AdvancedFields = {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  sizeOp: "larger" | "smaller";
  size: string;
  sizeUnit: "MB" | "KB" | "bytes";
  withinDays: number;
  withinDate: string; // yyyy-mm-dd, empty = off
  searchIn: string;
  hasAttachment: boolean;
  excludeChats: boolean;
};

export const EMPTY_ADVANCED: AdvancedFields = {
  from: "",
  to: "",
  subject: "",
  hasWords: "",
  doesntHave: "",
  sizeOp: "larger",
  size: "",
  sizeUnit: "MB",
  withinDays: 1,
  withinDate: "",
  searchIn: "",
  hasAttachment: false,
  excludeChats: false,
};

/** Pre-fills the form from a query (what Gmail does when you reopen it). */
export function advancedFromQuery(q: string): AdvancedFields {
  const larger = getOperator(q, "larger");
  const smaller = getOperator(q, "smaller");
  const sizeRaw = larger ?? smaller ?? "";
  const sizeMatch = sizeRaw.match(/^(\d+(?:\.\d+)?)([mk]?)$/i);
  const negated = parseOperators(q)
    .filter((o) => o.negated)
    .map((o) => o.raw.slice(1));
  const searchIn = SEARCH_IN.find((s) => s.value && hasToken(q, s.value))?.value ?? "";
  // Operators the form has no field for stay in "Has the words", like Gmail.
  const FIELDS = new Set(["from", "to", "subject", "larger", "smaller"]);
  const extra = parseOperators(q)
    .filter(
      (o) =>
        !o.negated &&
        !FIELDS.has(o.key) &&
        `${o.key}:${o.value}`.toLowerCase() !== "has:attachment" &&
        `${o.key}:${o.value}`.toLowerCase() !== searchIn,
    )
    .map((o) => o.raw);
  return {
    ...EMPTY_ADVANCED,
    from: getOperator(q, "from") ?? "",
    to: getOperator(q, "to") ?? "",
    subject: getOperator(q, "subject") ?? "",
    hasWords: [freeText(q), ...extra].filter(Boolean).join(" "),
    doesntHave: negated.filter((n) => !n.startsWith("in:chats")).join(" "),
    sizeOp: smaller && !larger ? "smaller" : "larger",
    size: sizeMatch?.[1] ?? "",
    sizeUnit: sizeMatch?.[2]?.toLowerCase() === "k" ? "KB" : sizeMatch?.[2] ? "MB" : "MB",
    searchIn,
    hasAttachment: hasToken(q, "has:attachment"),
    excludeChats: /(^|\s)-in:chats\b/i.test(q),
  };
}

/** Builds the query exactly like Gmail's advanced search does. */
export function queryFromAdvanced(f: AdvancedFields): string {
  const parts: string[] = [];
  if (f.from.trim()) parts.push(`from:${quote(f.from)}`);
  if (f.to.trim()) parts.push(`to:${quote(f.to)}`);
  if (f.subject.trim()) parts.push(`subject:${quote(f.subject)}`);
  if (f.hasWords.trim()) parts.push(f.hasWords.trim());
  for (const word of f.doesntHave.trim().split(/\s+/).filter(Boolean)) parts.push(`-${word}`);
  if (f.size.trim()) {
    const unit = f.sizeUnit === "MB" ? "M" : f.sizeUnit === "KB" ? "K" : "";
    parts.push(`${f.sizeOp}:${f.size.trim()}${unit}`);
  }
  if (f.withinDate) {
    const center = new Date(`${f.withinDate}T12:00:00`);
    const ms = f.withinDays * 86_400_000;
    parts.push(`after:${gmailDate(new Date(center.getTime() - ms))}`);
    parts.push(`before:${gmailDate(new Date(center.getTime() + ms))}`);
  }
  if (f.searchIn) parts.push(f.searchIn);
  if (f.hasAttachment) parts.push("has:attachment");
  if (f.excludeChats) parts.push("-in:chats");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Recent searches
// ---------------------------------------------------------------------------

const RECENT_KEY = "search:recent";
const RECENT_MAX = 8;

export function recentSearches(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): void {
  const next = [q, ...recentSearches().filter((s) => s !== q)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function forgetSearch(q: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches().filter((s) => s !== q)));
}
