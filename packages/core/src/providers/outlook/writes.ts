/**
 * Changing Outlook mail through labels (docs/outlook.md): UNREAD, STARRED and
 * IMPORTANT set the read state, the flag and the importance; categories are
 * set on the message; a folder label (INBOX, SPAM, TRASH, `folder:<id>`)
 * moves it, and taking one away moves it to the Archive (out of Junk or
 * Deleted Items: back to the inbox). Labels themselves are categories (made,
 * renamed, recolored, deleted) or folders (renamed, deleted).
 */

import * as store from "../../services/mail-store.js";
import { renamePendingLabel } from "../../services/pending-label-writes.js";
import type { GmailLabel, GmailMessageSummary } from "../../types.js";
import type { LabelChange } from "../provider.js";
import {
  categoryLabel,
  categoryOf,
  ensureMailbox,
  folderLabel,
  folderOfLabel,
  FOLDER_PREFIX,
  nearestPreset,
  presetColor,
  readMailbox,
  wellKnownId,
} from "./folders.js";
import { batchError, graph, graphAll, graphBatch, ok, type BatchRequest } from "./graph.js";
import { getApiMessages, messagePath, toSummary, type ApiMessage } from "./messages.js";

const STATE_FIELDS = "id,parentFolderId,categories,isRead,flag,importance,isDraft,from";

/** Runs a batch of writes; a message already gone (404) is fine, any other failure isn't. */
async function run(accountId: string, requests: BatchRequest[]): Promise<void> {
  for (const answer of await graphBatch(accountId, requests)) {
    if (answer && !ok(answer) && answer.status !== 404) throw batchError(answer);
  }
}

/** Where a label change sends a message, if anywhere. */
async function destination(
  accountId: string,
  message: ApiMessage,
  change: LabelChange,
  wholeThread: boolean,
): Promise<string | null> {
  const add = change.addLabelIds ?? [];
  const remove = change.removeLabelIds ?? [];
  const current = folderLabel(accountId, message.parentFolderId);
  // A thread's sent mail and drafts stay where they are, except when it's trashed.
  const ownMail =
    current === "SENT" ||
    current === "DRAFT" ||
    message.isDraft === true ||
    message.from?.emailAddress?.address?.toLowerCase() === accountId;
  const target =
    add.find((l) => l === "TRASH") ??
    add.find((l) => l === "SPAM") ??
    add.find((l) => l.startsWith(FOLDER_PREFIX)) ??
    add.find((l) => l === "INBOX");
  if (target) {
    if (target === current) return null;
    if (wholeThread && ownMail && target !== "TRASH") return null;
    // Back to the inbox: only what's archived (or junk, or trash), not mail in other folders.
    if (target === "INBOX" && wholeThread && current?.startsWith(FOLDER_PREFIX)) return null;
    return folderOfLabel(accountId, target);
  }
  if (current && remove.includes(current)) {
    if (current === "SPAM" || current === "TRASH") {
      return wellKnownId(accountId, ownMail ? "sentitems" : "inbox");
    }
    if (current === "INBOX" || current.startsWith(FOLDER_PREFIX)) {
      return wellKnownId(accountId, "archive");
    }
  }
  return null;
}

/** The property changes a label change makes to a message (null: none). */
function patchFor(message: ApiMessage, change: LabelChange): Record<string, unknown> | null {
  const add = new Set(change.addLabelIds ?? []);
  const remove = new Set(change.removeLabelIds ?? []);
  const patch: Record<string, unknown> = {};
  if (add.has("UNREAD") && message.isRead !== false) patch.isRead = false;
  if (remove.has("UNREAD") && message.isRead === false) patch.isRead = true;
  const flagged = message.flag?.flagStatus === "flagged";
  if (add.has("STARRED") && !flagged) patch.flag = { flagStatus: "flagged" };
  if (remove.has("STARRED") && flagged) patch.flag = { flagStatus: "notFlagged" };
  if (add.has("IMPORTANT") && message.importance !== "high") patch.importance = "high";
  if (remove.has("IMPORTANT") && message.importance === "high") patch.importance = "normal";
  const categories = new Set(message.categories ?? []);
  let edited = false;
  for (const id of add) {
    const name = categoryOf(id);
    if (name && !categories.has(name)) {
      categories.add(name);
      edited = true;
    }
  }
  for (const id of remove) {
    const name = categoryOf(id);
    if (name && categories.delete(name)) edited = true;
  }
  if (edited) patch.categories = [...categories];
  return Object.keys(patch).length > 0 ? patch : null;
}

async function apply(
  accountId: string,
  messages: ApiMessage[],
  change: LabelChange,
  wholeThread: boolean,
): Promise<void> {
  // Properties first: a move answers before Graph has finished with the message.
  const patches: BatchRequest[] = [];
  const moves: BatchRequest[] = [];
  for (const message of messages) {
    const patch = patchFor(message, change);
    if (patch) patches.push({ method: "PATCH", url: messagePath(message.id), body: patch });
    const to = await destination(accountId, message, change, wholeThread);
    if (to) {
      moves.push({
        method: "POST",
        url: `${messagePath(message.id)}/move`,
        body: { destinationId: to },
      });
    }
  }
  await run(accountId, patches);
  await run(accountId, moves);
}

/** The messages of a conversation, with what label changes need to know. */
async function threadMessages(accountId: string, threadId: string): Promise<ApiMessage[]> {
  const filter = encodeURIComponent(`conversationId eq '${threadId.replace(/'/g, "''")}'`);
  return graphAll<ApiMessage>(
    accountId,
    `/me/messages?$filter=${filter}&$select=${STATE_FIELDS}&$top=100`,
  );
}

export async function modifyMessage(
  accountId: string,
  messageId: string,
  change: LabelChange,
): Promise<void> {
  const messages = await getApiMessages(accountId, [messageId], STATE_FIELDS);
  await apply(accountId, messages, change, false);
}

export async function modifyThread(
  accountId: string,
  threadId: string,
  change: LabelChange,
): Promise<void> {
  await apply(accountId, await threadMessages(accountId, threadId), change, true);
}

export const trashMessage = (accountId: string, messageId: string) =>
  modifyMessage(accountId, messageId, { addLabelIds: ["TRASH"] });

export const trashThread = (accountId: string, threadId: string) =>
  modifyThread(accountId, threadId, { addLabelIds: ["TRASH"] });

/** Back from Deleted Items: received mail to the inbox, your own to Sent Items. */
async function untrash(accountId: string, messages: ApiMessage[]): Promise<GmailMessageSummary[]> {
  const trashed = messages.filter((m) => folderLabel(accountId, m.parentFolderId) === "TRASH");
  await apply(accountId, trashed, { removeLabelIds: ["TRASH"] }, false);
  const ids = trashed.map((m) => m.id);
  return (await getApiMessages(accountId, ids)).map((m) => toSummary(accountId, m));
}

export async function untrashMessage(accountId: string, messageId: string) {
  return untrash(accountId, await getApiMessages(accountId, [messageId], STATE_FIELDS));
}

export async function untrashThread(accountId: string, threadId: string) {
  return untrash(accountId, await threadMessages(accountId, threadId));
}

/** PERMANENT: past Deleted Items and its recovery. */
export async function deleteForever(accountId: string, messageIds: string[]): Promise<void> {
  await run(
    accountId,
    messageIds.map((id) => ({ method: "POST", url: `${messagePath(id)}/permanentDelete` })),
  );
}

/** PERMANENTLY empties Junk Email or Deleted Items (and the folders in it). */
export async function emptyFolder(
  accountId: string,
  labelId: "SPAM" | "TRASH",
  cachedIds: string[],
): Promise<string[]> {
  const mailbox = await readMailbox(accountId);
  const folders = mailbox.folders.filter((f) => f.labelId === labelId);
  const ids = new Set(cachedIds);
  for (const folder of folders) {
    const listed = await graphAll<{ id: string }>(
      accountId,
      `/me/mailFolders/${encodeURIComponent(folder.id)}/messages?$select=id&$top=500`,
    );
    for (const message of listed) ids.add(message.id);
  }
  await deleteForever(accountId, [...ids]);
  const root = mailbox.wellKnown[labelId === "TRASH" ? "deleteditems" : "junkemail"];
  await run(
    accountId,
    folders
      .filter((f) => f.parentId === root)
      .map((f) => ({
        method: "POST",
        url: `/me/mailFolders/${encodeURIComponent(f.id)}/permanentDelete`,
      })),
  );
  return [...ids];
}

// ── Labels ──────────────────────────────────────────────────────────────────

type MasterCategory = { id: string; displayName: string; color?: string };

async function masterCategories(accountId: string): Promise<MasterCategory[]> {
  return (
    (await graph<{ value?: MasterCategory[] }>(accountId, "/me/outlook/masterCategories")).value ??
    []
  );
}

/** A new label is a category (Outlook's colored labels). */
export async function createLabel(accountId: string, name: string): Promise<GmailLabel> {
  const created = await graph<MasterCategory>(accountId, "/me/outlook/masterCategories", {
    method: "POST",
    body: { displayName: name, color: "preset7" },
  });
  await readMailbox(accountId);
  return {
    id: categoryLabel(created.displayName),
    name: created.displayName,
    type: "user",
    unread: 0,
    total: 0,
    color: presetColor(created.color ?? "preset7"),
  };
}

/** Every message carrying a category, with its categories. */
async function messagesInCategory(accountId: string, name: string) {
  const filter = encodeURIComponent(`categories/any(c:c eq '${name.replace(/'/g, "''")}')`);
  return graphAll<{ id: string; categories?: string[] }>(
    accountId,
    `/me/messages?$filter=${filter}&$select=id,categories&$top=100`,
  );
}

/** The cache's messages (and the app's pending writes) follow a category to its new name: its id. */
function renameCachedLabel(accountId: string, from: string, to: string): void {
  for (const id of store.getMessageIdsForLabel(accountId, from)) {
    store.applyLabelChange(accountId, id, [to], [from]);
  }
  renamePendingLabel(accountId, from, to);
}

/** Swaps (or with `to` null, takes away) a category on every message carrying it. */
async function retag(accountId: string, from: string, to: string | null): Promise<void> {
  const messages = await messagesInCategory(accountId, from);
  await run(
    accountId,
    messages.map((m) => {
      const categories = (m.categories ?? []).filter((c) => c !== from);
      if (to && !categories.includes(to)) categories.push(to);
      return { method: "PATCH", url: messagePath(m.id), body: { categories } };
    }),
  );
}

/**
 * Renames and/or recolors a label. Outlook can't rename a category, so a
 * renamed one is made anew and moved onto its messages (nested ones too,
 * "Old/child" → "New/child"). A folder is renamed, or moved under another.
 */
export async function updateLabel(
  accountId: string,
  params: {
    labelId: string;
    name?: string;
    color?: { backgroundColor: string; textColor: string };
  },
): Promise<void> {
  const category = categoryOf(params.labelId);
  if (category !== null) {
    const all = await masterCategories(accountId);
    const own = all.find((c) => c.displayName === category);
    if (!own) throw new Error(`The category ${category} isn't in Outlook anymore.`);
    const color = params.color ? nearestPreset(params.color.backgroundColor) : own.color;
    if (params.name && params.name !== category) {
      const nested = all.filter((c) => c.displayName.startsWith(`${category}/`));
      for (const old of [own, ...nested]) {
        const name = params.name + old.displayName.slice(category.length);
        if (!all.some((c) => c.displayName === name)) {
          await graph(accountId, "/me/outlook/masterCategories", {
            method: "POST",
            body: { displayName: name, color: old === own ? color : old.color },
          });
        }
        await retag(accountId, old.displayName, name);
        renameCachedLabel(accountId, categoryLabel(old.displayName), categoryLabel(name));
        await graph(accountId, `/me/outlook/masterCategories/${encodeURIComponent(old.id)}`, {
          method: "DELETE",
        });
      }
    } else if (color !== own.color) {
      await graph(accountId, `/me/outlook/masterCategories/${encodeURIComponent(own.id)}`, {
        method: "PATCH",
        body: { color },
      });
    }
    await readMailbox(accountId);
    return;
  }

  if (!params.labelId.startsWith(FOLDER_PREFIX))
    throw new Error("Outlook's own folders can't be renamed.");
  if (!params.name) return;
  const mailbox = await ensureMailbox(accountId);
  const folderId = params.labelId.slice(FOLDER_PREFIX.length);
  const folder = mailbox.folders.find((f) => f.id === folderId);
  if (!folder) throw new Error("That folder isn't in Outlook anymore.");
  const cut = params.name.lastIndexOf("/");
  const parentPath = cut < 0 ? "" : params.name.slice(0, cut);
  const leaf = params.name.slice(cut + 1);
  const currentParent = folder.name.includes("/")
    ? folder.name.slice(0, folder.name.lastIndexOf("/"))
    : "";
  const path = `/me/mailFolders/${encodeURIComponent(folderId)}`;
  if (parentPath !== currentParent) {
    const parent = parentPath
      ? mailbox.folders.find((f) => f.name === parentPath)?.id
      : "msgfolderroot";
    if (!parent) throw new Error(`There's no folder ${parentPath} to move it into.`);
    await graph(accountId, `${path}/move`, { method: "POST", body: { destinationId: parent } });
  }
  if (leaf !== folder.name.slice(folder.name.lastIndexOf("/") + 1)) {
    await graph(accountId, path, { method: "PATCH", body: { displayName: leaf } });
  }
  await readMailbox(accountId);
}

/**
 * Deletes a label: a category comes off every message and out of the list;
 * a folder goes to Deleted Items with its mail, as in Outlook.
 */
export async function deleteLabel(accountId: string, labelId: string): Promise<void> {
  const category = categoryOf(labelId);
  if (category !== null) {
    await retag(accountId, category, null);
    const own = (await masterCategories(accountId)).find((c) => c.displayName === category);
    if (own) {
      await graph(accountId, `/me/outlook/masterCategories/${encodeURIComponent(own.id)}`, {
        method: "DELETE",
      });
    }
  } else if (labelId.startsWith(FOLDER_PREFIX)) {
    await graph(
      accountId,
      `/me/mailFolders/${encodeURIComponent(labelId.slice(FOLDER_PREFIX.length))}`,
      {
        method: "DELETE",
      },
    );
  } else {
    throw new Error("Outlook's own folders can't be deleted.");
  }
  await readMailbox(accountId);
}
