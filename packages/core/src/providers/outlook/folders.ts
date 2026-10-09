/**
 * Outlook's folders and categories as labels (docs/outlook.md).
 *
 * The well-known folders are Gmail's system labels: Inbox → INBOX, Sent
 * Items → SENT, Drafts → DRAFT, Deleted Items → TRASH, Junk Email → SPAM; the
 * Archive folder is no label at all (archived mail just lacks INBOX). Every
 * other folder is a user label, `folder:<id>`, named by its path. A message
 * sits in one folder: applying a folder label moves it.
 *
 * Categories are Outlook's labels: several per message, each with a color.
 * They're user labels too, `category:<name>`. Flags, read state and
 * importance stand for STARRED, UNREAD and IMPORTANT.
 */

import * as store from "../../services/mail-store.js";
import type { GmailLabel } from "../../types.js";
import { graph, graphAll, graphBatch, ok } from "./graph.js";

export const FOLDER_PREFIX = "folder:";
export const CATEGORY_PREFIX = "category:";

/** Well-known folders Otter Mail uses by name (Graph's names for them). */
const WELL_KNOWN = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "junkemail",
  "archive",
  "outbox",
  "conversationhistory",
  "syncissues",
  "scheduled",
] as const;
type WellKnown = (typeof WELL_KNOWN)[number];

const SYSTEM_LABEL: Partial<Record<WellKnown, string>> = {
  inbox: "INBOX",
  sentitems: "SENT",
  drafts: "DRAFT",
  deleteditems: "TRASH",
  junkemail: "SPAM",
};

/** Folders that hold no mail worth listing (mail on its way out, Skype logs, sync conflicts). */
const SKIPPED: WellKnown[] = ["outbox", "conversationhistory", "syncissues", "scheduled"];

/** The labels flags and properties stand for, besides the folder's own and categories. */
export const FLAG_LABELS = ["UNREAD", "STARRED", "IMPORTANT"];

export interface Folder {
  id: string;
  /** Its path, "/" between levels. */
  name: string;
  parentId: string | null;
  unread: number;
  total: number;
  /** The label its mail carries: a system label, `folder:<id>`, or none (the archive). */
  labelId: string | null;
}

export interface Category {
  name: string;
  /** Outlook's preset ("preset0" … "preset24"), or "none". */
  color: string;
}

export interface Mailbox {
  wellKnown: Partial<Record<WellKnown, string>>;
  /** Folders worth syncing, the inbox first and Junk and Deleted Items last. */
  folders: Folder[];
  categories: Category[];
}

const mailboxes = new Map<string, Mailbox>();
const key = (accountId: string) => `outlookMailbox:${accountId}`;

/** The account's folders and categories as last read (from the cache after a restart). */
export function mailboxOf(accountId: string): Mailbox | null {
  let mailbox = mailboxes.get(accountId) ?? null;
  if (!mailbox) {
    const saved = store.getKv(key(accountId));
    if (saved) {
      try {
        mailbox = JSON.parse(saved) as Mailbox;
        mailboxes.set(accountId, mailbox);
      } catch {
        // read again
      }
    }
  }
  return mailbox;
}

export function forgetFolders(accountId: string): void {
  mailboxes.delete(accountId);
}

type ApiFolder = {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
};

const FOLDER_FIELDS =
  "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount";

/** Reads the folder tree and categories from Graph (a few requests) and keeps them. */
export async function readMailbox(accountId: string): Promise<Mailbox> {
  const known = mailboxOf(accountId)?.wellKnown;
  const wellKnown: Mailbox["wellKnown"] = {};
  if (known?.inbox) Object.assign(wellKnown, known);
  else {
    const answers = await graphBatch(
      accountId,
      WELL_KNOWN.map((name) => ({ method: "GET", url: `/me/mailFolders/${name}?$select=id` })),
    );
    WELL_KNOWN.forEach((name, i) => {
      const id = ok(answers[i]) ? (answers[i]!.body as { id?: string }).id : undefined;
      if (id) wellKnown[name] = id;
    });
    if (!wellKnown.inbox) throw new Error("Outlook didn't say where this mailbox's inbox is.");
  }

  const roleOf = new Map<string, WellKnown>();
  for (const [name, id] of Object.entries(wellKnown)) roleOf.set(id, name as WellKnown);

  const folders: Folder[] = [];
  const visit = async (parent: string | null, parentPath: string, inherited: string | null) => {
    const children = await graphAll<ApiFolder>(
      accountId,
      parent
        ? `/me/mailFolders/${parent}/childFolders?$top=100&$select=${FOLDER_FIELDS}`
        : `/me/mailFolders?$top=100&$select=${FOLDER_FIELDS}`,
    );
    for (const child of children) {
      const role = roleOf.get(child.id);
      if (role && SKIPPED.includes(role)) continue;
      const path = parentPath ? `${parentPath}/${child.displayName}` : child.displayName;
      // Folders in Deleted Items and Junk Email are trash and junk too.
      const labelId =
        inherited ?? (role ? (SYSTEM_LABEL[role] ?? null) : `${FOLDER_PREFIX}${child.id}`);
      folders.push({
        id: child.id,
        name: path,
        parentId: parent,
        unread: child.unreadItemCount ?? 0,
        total: child.totalItemCount ?? 0,
        labelId,
      });
      if ((child.childFolderCount ?? 0) > 0) {
        const keep = labelId === "TRASH" || labelId === "SPAM" ? labelId : null;
        // System folders' children are named under the folder's own name ("Inbox/Clients").
        await visit(child.id, path, keep);
      }
    }
  };
  await visit(null, "", null);
  const order = (f: Folder) =>
    f.id === wellKnown.inbox ? 0 : f.labelId === "SPAM" ? 2 : f.labelId === "TRASH" ? 3 : 1;
  folders.sort((a, b) => order(a) - order(b));

  const categories =
    (
      await graph<{ value?: { displayName: string; color?: string }[] }>(
        accountId,
        "/me/outlook/masterCategories",
      ).catch(() => ({ value: [] }))
    ).value?.map((c) => ({ name: c.displayName, color: c.color ?? "none" })) ?? [];

  const mailbox: Mailbox = { wellKnown, folders, categories };
  mailboxes.set(accountId, mailbox);
  store.setKv(key(accountId), JSON.stringify(mailbox));
  return mailbox;
}

/** The mailbox's folders and categories: as kept, else read now. */
export async function ensureMailbox(accountId: string): Promise<Mailbox> {
  return mailboxOf(accountId) ?? readMailbox(accountId);
}

export function folderById(accountId: string, id: string): Folder | undefined {
  return mailboxOf(accountId)?.folders.find((f) => f.id === id);
}

/** The well-known folder's id (the inbox, the archive …). */
export async function wellKnownId(accountId: string, name: WellKnown): Promise<string> {
  const id = (await ensureMailbox(accountId)).wellKnown[name];
  // Mailboxes without an Archive folder yet: Graph makes it on first use.
  return id ?? name;
}

/** The label a folder's mail carries (null: archived, or a folder not worth listing). */
export function folderLabel(accountId: string, folderId: string | undefined): string | null {
  if (!folderId) return null;
  const mailbox = mailboxOf(accountId);
  const folder = mailbox?.folders.find((f) => f.id === folderId);
  if (folder) return folder.labelId;
  const role = Object.entries(mailbox?.wellKnown ?? {}).find(([, id]) => id === folderId)?.[0];
  if (role) return SYSTEM_LABEL[role as WellKnown] ?? null;
  // A folder made since the tree was read: the next read names it.
  return `${FOLDER_PREFIX}${folderId}`;
}

/** Whether mail in this folder is worth caching (not the outbox or the like). */
export function isSyncedFolder(accountId: string, folderId: string | undefined): boolean {
  const mailbox = mailboxOf(accountId);
  if (!folderId || !mailbox) return true;
  return !SKIPPED.some((name) => mailbox.wellKnown[name] === folderId);
}

/** The folder a label stands for, if it's one (INBOX → the inbox …). */
export async function folderOfLabel(accountId: string, labelId: string): Promise<string | null> {
  if (labelId.startsWith(FOLDER_PREFIX)) return labelId.slice(FOLDER_PREFIX.length);
  const role = (Object.entries(SYSTEM_LABEL) as [WellKnown, string][]).find(
    ([, label]) => label === labelId,
  )?.[0];
  return role ? wellKnownId(accountId, role) : null;
}

export const categoryLabel = (name: string) => `${CATEGORY_PREFIX}${name}`;
export const categoryOf = (labelId: string): string | null =>
  labelId.startsWith(CATEGORY_PREFIX) ? labelId.slice(CATEGORY_PREFIX.length) : null;

// ── Colors ──────────────────────────────────────────────────────────────────

/** Outlook's category presets, as Outlook on the web shows them. */
const PRESETS: Record<string, string> = {
  preset0: "#e74856",
  preset1: "#ff8c00",
  preset2: "#ab7b5d",
  preset3: "#fff100",
  preset4: "#47d041",
  preset5: "#30c6cc",
  preset6: "#73aa24",
  preset7: "#4cb4ff",
  preset8: "#8764b8",
  preset9: "#f495bf",
  preset10: "#4b7a9e",
  preset11: "#2d4250",
  preset12: "#a0aeb2",
  preset13: "#6b7b81",
  preset14: "#1f1f1f",
  preset15: "#a4262c",
  preset16: "#ca5010",
  preset17: "#8e562e",
  preset18: "#c19c00",
  preset19: "#0b6a0b",
  preset20: "#038387",
  preset21: "#5c7e10",
  preset22: "#004e8c",
  preset23: "#5c2e91",
  preset24: "#9b1c54",
};

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", "").padEnd(6, "0").slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Dark text on light colors, white on the rest. */
function textOn(hex: string): string {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1f1f1f" : "#ffffff";
}

export function presetColor(
  preset: string,
): { backgroundColor: string; textColor: string } | undefined {
  const hex = PRESETS[preset];
  return hex ? { backgroundColor: hex, textColor: textOn(hex) } : undefined;
}

/** The preset nearest a color picked in the app (Outlook only has its presets). */
export function nearestPreset(hex: string): string {
  const [r, g, b] = rgb(hex);
  let best = "preset7";
  let bestDistance = Infinity;
  for (const [preset, value] of Object.entries(PRESETS)) {
    const [r2, g2, b2] = rgb(value);
    const distance = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [preset, distance];
  }
  return best;
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** Every label, as the sidebar lists them: folders with Outlook's counts, categories with ours. */
export function labelsOf(accountId: string, mailbox: Mailbox): GmailLabel[] {
  const labels: GmailLabel[] = [];
  const seen = new Set<string>();
  for (const folder of mailbox.folders) {
    if (!folder.labelId) continue;
    const system = !folder.labelId.startsWith(FOLDER_PREFIX);
    // Subfolders of Deleted Items and Junk count toward theirs.
    const existing = labels.find((l) => l.id === folder.labelId);
    if (existing) {
      existing.unread = (existing.unread ?? 0) + folder.unread;
      existing.total = (existing.total ?? 0) + folder.total;
      continue;
    }
    seen.add(folder.labelId);
    labels.push({
      id: folder.labelId,
      name: system ? folder.labelId : folder.name,
      type: system ? "system" : "user",
      unread: folder.unread,
      total: folder.total,
    });
  }
  const local = (id: string) => ({
    unread: store.countUnreadForLabel(accountId, id),
    total: store.countMessagesForLabel(accountId, id),
  });
  for (const id of FLAG_LABELS) {
    labels.push({ id, name: id, type: "system", ...local(id) });
  }
  for (const category of mailbox.categories) {
    const id = categoryLabel(category.name);
    if (seen.has(id)) continue;
    seen.add(id);
    labels.push({
      id,
      name: category.name,
      type: "user",
      ...local(id),
      color: presetColor(category.color),
    });
  }
  return labels;
}

/** What labels a message from Graph carries. */
export function labelsFor(
  accountId: string,
  message: {
    parentFolderId?: string;
    isRead?: boolean;
    flag?: { flagStatus?: string } | null;
    importance?: string;
    categories?: string[];
  },
): string[] {
  const labels: string[] = [];
  const folder = folderLabel(accountId, message.parentFolderId);
  if (folder) labels.push(folder);
  if (message.isRead === false) labels.push("UNREAD");
  if (message.flag?.flagStatus === "flagged") labels.push("STARRED");
  if (message.importance === "high") labels.push("IMPORTANT");
  for (const category of message.categories ?? []) labels.push(categoryLabel(category));
  return labels;
}
