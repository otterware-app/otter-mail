/**
 * Reading mail from the server: summaries, whole messages, attachments and
 * headers, each by message id (`<uidvalidity>:<uid>:<path>`).
 */

import { parseMessage, type FetchQuery, type FetchedMessage } from "../../protocols/index.js";
import type { MessageDetail, MessageSummary } from "../../types.js";
import { FolderGone, inFolder } from "./connection.js";
import { byFolder, foldersOf, parseMessageId, type Folder } from "./folders.js";
import { DETAIL_QUERY, SUMMARY_QUERY, toDetail, toSummary } from "./messages.js";

/** A message that's no longer where its id says (moved or deleted elsewhere). */
export class MessageGone extends Error {
  constructor(id: string) {
    super(`Message ${id} is no longer on the server.`);
    this.name = "MessageGone";
  }
}

/** Where messages went when this device moved them: old id → new id. */
const movedTo = new Map<string, string>();

export function rememberMove(fromId: string, toId: string): void {
  movedTo.set(fromId, toId);
}

/** The message's id now, following moves made here since its id was handed out. */
export function currentId(id: string): string {
  let current = id;
  for (let hops = 0; movedTo.has(current) && hops < 10; hops++) current = movedTo.get(current)!;
  return current;
}

/** One message's FETCH, with its folder; MessageGone when it isn't there. */
async function fetchOne(
  accountId: string,
  id: string,
  query: FetchQuery,
): Promise<{ folder: Folder; message: FetchedMessage; uidValidity: number }> {
  const ref = parseMessageId(currentId(id));
  try {
    return await inFolder(accountId, ref.path, async (client, mailbox) => {
      const folder = (await foldersOf(accountId, client)).get(ref.path);
      if (mailbox.uidValidity !== ref.uidValidity || !folder) throw new MessageGone(id);
      const [message] = await client.fetch([ref.uid], query);
      if (!message) throw new MessageGone(id);
      return { folder, message, uidValidity: mailbox.uidValidity };
    });
  } catch (err) {
    throw err instanceof FolderGone ? new MessageGone(id) : err;
  }
}

export async function getSummaries(accountId: string, ids: string[]): Promise<MessageSummary[]> {
  const summaries: MessageSummary[] = [];
  for (const [path, refs] of byFolder(ids.map(currentId))) {
    await inFolder(accountId, path, async (client, mailbox) => {
      const folder = (await foldersOf(accountId, client)).get(path);
      const uids = refs.filter((r) => r.uidValidity === mailbox.uidValidity).map((r) => r.uid);
      if (!folder || uids.length === 0) return;
      for (const message of await client.fetch(uids, SUMMARY_QUERY)) {
        summaries.push(await toSummary(folder, mailbox.uidValidity, message));
      }
    }).catch((err: unknown) => {
      if (!(err instanceof FolderGone)) throw err;
    });
  }
  return summaries;
}

export async function getMessage(accountId: string, id: string): Promise<MessageDetail> {
  const { folder, message, uidValidity } = await fetchOne(accountId, id, DETAIL_QUERY);
  return toDetail(folder, uidValidity, message);
}

export async function fetchAttachment(
  accountId: string,
  id: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const { message } = await fetchOne(accountId, id, { source: true });
  const parsed = await parseMessage(message.source ?? new Uint8Array());
  const attachment = parsed.attachments[Number(attachmentId)];
  if (!attachment) throw new MessageGone(`${id} attachment ${attachmentId}`);
  return attachment.bytes;
}

export async function getReplyHeaders(
  accountId: string,
  id: string,
): Promise<{ messageIdHeader: string | null; referencesHeader: string | null }> {
  const { message } = await fetchOne(accountId, id, { envelope: true, headers: ["References"] });
  return {
    messageIdHeader: message.envelope?.messageId ?? null,
    referencesHeader: message.headers?.references || null,
  };
}

export async function getUnsubscribeHeaders(
  accountId: string,
  id: string,
): Promise<{ listUnsubscribe: string; oneClick: boolean }> {
  const { message } = await fetchOne(accountId, id, {
    headers: ["List-Unsubscribe", "List-Unsubscribe-Post"],
  });
  return {
    listUnsubscribe: message.headers?.["list-unsubscribe"] ?? "",
    oneClick: /one-click/i.test(message.headers?.["list-unsubscribe-post"] ?? ""),
  };
}
