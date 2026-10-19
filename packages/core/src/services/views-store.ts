/**
 * views-store.ts
 *
 * Persists Combined-mailbox views to userData/views.json so the main and
 * settings windows share one source of truth. The built-in "Inbox" and
 * "Sent" views always exist and lead the list; their null rules mean
 * "every account's INBOX/SENT", resolved dynamically by the renderer.
 */

import { readJson, writeJson } from "../json-file.js";
import type { MailView, ViewRule } from "../types.js";

export const INBOX_VIEW_ID = "__inbox__";
export const STARRED_VIEW_ID = "__starred__";
export const SENT_VIEW_ID = "__sent__";
export const DRAFTS_VIEW_ID = "__drafts__";
export const IMPORTANT_VIEW_ID = "__important__";
export const ALL_MAIL_VIEW_ID = "__allmail__";
export const JUNK_VIEW_ID = "__junk__";
export const TRASH_VIEW_ID = "__trash__";

const DEFAULT_VIEWS: MailView[] = [
  { id: INBOX_VIEW_ID, name: "Inbox", kind: "inbox", rules: null },
  { id: STARRED_VIEW_ID, name: "Starred", kind: "starred", rules: null },
  { id: SENT_VIEW_ID, name: "Sent", kind: "sent", rules: null },
  { id: DRAFTS_VIEW_ID, name: "Drafts", kind: "drafts", rules: null },
  { id: IMPORTANT_VIEW_ID, name: "Important", kind: "important", rules: null },
  { id: ALL_MAIL_VIEW_ID, name: "All Mail", kind: "allmail", rules: null },
  { id: JUNK_VIEW_ID, name: "Junk", kind: "junk", rules: null },
  { id: TRASH_VIEW_ID, name: "Trash", kind: "trash", rules: null },
];

const BUILTIN_IDS = new Set(DEFAULT_VIEWS.map((v) => v.id));
const BUILTIN_NAMES: Record<string, string> = {
  inbox: "Inbox",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  important: "Important",
  allmail: "All Mail",
  junk: "Junk",
  trash: "Trash",
};

const COMBINED_MAILBOX = "__combined__";

function withDefaults(views: MailView[]): MailView[] {
  const builtins = DEFAULT_VIEWS.map(
    (fallback) => views.find((v) => v.id === fallback.id) ?? fallback,
  );
  // Custom views are owned by one mailbox; pre-ownership views were combined.
  const custom = views
    .filter((v) => !BUILTIN_IDS.has(v.id))
    .map((v) => ({ ...v, mailbox: v.mailbox ?? COMBINED_MAILBOX }));
  return [...builtins, ...custom];
}

async function readViews(): Promise<MailView[]> {
  const parsed = await readJson<unknown>("views.json");
  return withDefaults(Array.isArray(parsed) ? (parsed as MailView[]) : []);
}

export async function writeViews(views: MailView[]): Promise<void> {
  await writeJson("views.json", withDefaults(views));
}

export async function listViews(): Promise<MailView[]> {
  return readViews();
}

function genId(): string {
  return `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveView(input: {
  id?: string;
  name: string;
  rules: ViewRule[];
  mailbox?: string;
  /** Left as they are when absent. */
  icon?: string | null;
  color?: string | null;
}): Promise<MailView> {
  const views = await readViews();
  if (input.id) {
    const index = views.findIndex((v) => v.id === input.id);
    if (index >= 0) {
      views[index] = {
        ...views[index],
        name: input.name,
        rules: input.rules,
        ...(input.icon !== undefined ? { icon: input.icon } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      };
      await writeViews(views);
      return views[index];
    }
  }
  const view: MailView = {
    id: genId(),
    name: input.name,
    kind: "custom",
    rules: input.rules,
    icon: input.icon ?? null,
    color: input.color ?? null,
    mailbox: input.mailbox ?? COMBINED_MAILBOX,
  };
  views.push(view);
  await writeViews(views);
  return view;
}

export async function deleteView(id: string): Promise<void> {
  // Built-in views can't be deleted (reset instead).
  if (BUILTIN_IDS.has(id)) return;
  const views = await readViews();
  await writeViews(views.filter((v) => v.id !== id));
}

export async function resetView(id: string): Promise<void> {
  const views = await readViews();
  await writeViews(
    views.map((v) =>
      v.id === id && v.kind !== "custom"
        ? { ...v, name: BUILTIN_NAMES[v.kind] ?? v.name, rules: null }
        : v,
    ),
  );
}
