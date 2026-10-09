/**
 * Outlook messages in the cache's shape: summaries from Graph's message
 * properties, whole messages from their MIME source (`/$value`), parsed with
 * postal-mime as IMAP's are, so bodies, inline images, attachments and
 * headers read the same whatever the provider.
 */

import { parseMessage } from "../../protocols/index.js";
import type { GmailMessageDetail, GmailMessageSummary } from "../../types.js";
import { formatAddresses, snippetOf } from "../imap/messages.js";
import { labelsFor } from "./folders.js";
import { graph, graphBatch, graphBytes, isNotFound, ok, batchError } from "./graph.js";

/** What a list row needs, asked of Graph. */
export const SUMMARY_FIELDS = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "from",
  "sender",
  "toRecipients",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "isDraft",
  "flag",
  "importance",
  "categories",
  "hasAttachments",
  "parentFolderId",
  "internetMessageId",
].join(",");

type Recipient = { emailAddress?: { name?: string; address?: string } };

export type ApiMessage = {
  id: string;
  conversationId?: string;
  subject?: string | null;
  bodyPreview?: string;
  from?: Recipient | null;
  sender?: Recipient | null;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string } | null;
  importance?: string;
  categories?: string[];
  hasAttachments?: boolean;
  parentFolderId?: string;
  internetMessageId?: string | null;
  internetMessageHeaders?: { name: string; value: string }[];
  /** Delta's mark for a message gone from the folder. */
  "@removed"?: { reason?: string };
};

const addresses = (recipients: Recipient[] | undefined) =>
  formatAddresses(
    (recipients ?? [])
      .filter((r) => r.emailAddress?.address)
      .map((r) => ({ name: r.emailAddress?.name ?? "", address: r.emailAddress!.address! })),
  );

export function toSummary(accountId: string, message: ApiMessage): GmailMessageSummary {
  const from = (message.from ?? message.sender)?.emailAddress;
  const labelIds = labelsFor(accountId, message);
  // Drafts and sent mail are dated when written; received mail when it arrived.
  const when = message.isDraft
    ? (message.sentDateTime ?? message.receivedDateTime)
    : message.receivedDateTime;
  return {
    id: message.id,
    threadId: message.conversationId || message.id,
    fromName: from?.name && from.name !== from.address ? from.name : "",
    // Your own mail can name you by Exchange's internal address (/O=…/CN=…) for a while.
    fromEmail: from?.address?.includes("@")
      ? from.address
      : message.isDraft || from?.address
        ? accountId
        : "",
    to: addresses(message.toRecipients),
    subject: message.subject ?? "",
    snippet: (message.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    date: when ? Date.parse(when) : 0,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    labelIds,
    hasAttachments: message.hasAttachments === true,
    messageIdHeader: message.internetMessageId ?? undefined,
  };
}

export const messagePath = (id: string) => `/me/messages/${encodeURIComponent(id)}`;

/** Messages' properties, 20 to a request; ids gone from Outlook are left out. */
export async function getApiMessages(
  accountId: string,
  ids: string[],
  fields = SUMMARY_FIELDS,
): Promise<ApiMessage[]> {
  const answers = await graphBatch(
    accountId,
    ids.map((id) => ({ method: "GET", url: `${messagePath(id)}?$select=${fields}` })),
  );
  const messages: ApiMessage[] = [];
  for (const answer of answers) {
    if (ok(answer)) messages.push(answer.body as ApiMessage);
    else if (answer && answer.status !== 404) throw batchError(answer);
  }
  return messages;
}

export async function getSummaries(
  accountId: string,
  ids: string[],
): Promise<GmailMessageSummary[]> {
  return (await getApiMessages(accountId, ids)).map((m) => toSummary(accountId, m));
}

/** Whole messages, by MIME source; the cache keeps no copy of it, so attachments re-read it. */
async function source(accountId: string, id: string) {
  return parseMessage(await graphBytes(accountId, `${messagePath(id)}/$value`));
}

export async function getMessage(accountId: string, id: string): Promise<GmailMessageDetail> {
  const [message, parsed] = await Promise.all([
    graph<ApiMessage>(
      accountId,
      `${messagePath(id)}?$select=${SUMMARY_FIELDS},ccRecipients,bccRecipients`,
    ),
    source(accountId, id),
  ]);
  const summary = toSummary(accountId, message);
  // Attachment ids are indexes into postal-mime's list, as for IMAP.
  const attachments = parsed.attachments.map((a, i) => ({
    id: String(i),
    filename: a.filename ?? `attachment-${i + 1}`,
    mimeType: a.mimeType,
    size: a.bytes.length,
    contentId: a.contentId ?? undefined,
  }));
  return {
    ...summary,
    snippet: summary.snippet || snippetOf(parsed),
    cc: addresses(message.ccRecipients) || undefined,
    bcc: addresses(message.bccRecipients) || undefined,
    bodyHtml: parsed.html,
    bodyText: parsed.text,
    // Graph's own answer: an invitation's .ics isn't an attachment to show.
    hasAttachments: summary.hasAttachments,
    attachments,
  };
}

export class MessageGone extends Error {
  constructor(id: string) {
    super(`Message ${id} is no longer in this mailbox.`);
    this.name = "MessageGone";
  }
}

export async function fetchAttachment(
  accountId: string,
  id: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const attachment = (await source(accountId, id)).attachments[Number(attachmentId)];
  if (!attachment) throw new MessageGone(`${id} attachment ${attachmentId}`);
  return attachment.bytes;
}

/** A received message's own headers (Graph has none for drafts and sent mail). */
async function headersOf(accountId: string, id: string) {
  try {
    const message = await graph<ApiMessage>(
      accountId,
      `${messagePath(id)}?$select=internetMessageId,internetMessageHeaders`,
    );
    const header = (name: string) =>
      message.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
    return { messageId: message.internetMessageId ?? null, header };
  } catch (err) {
    if (isNotFound(err)) throw new MessageGone(id);
    throw err;
  }
}

export async function getReplyHeaders(
  accountId: string,
  id: string,
): Promise<{ messageIdHeader: string | null; referencesHeader: string | null }> {
  const { messageId, header } = await headersOf(accountId, id);
  return { messageIdHeader: messageId, referencesHeader: header("references") };
}

export async function getUnsubscribeHeaders(
  accountId: string,
  id: string,
): Promise<{ listUnsubscribe: string; oneClick: boolean }> {
  const { header } = await headersOf(accountId, id);
  return {
    listUnsubscribe: header("list-unsubscribe") ?? "",
    oneClick: /one-click/i.test(header("list-unsubscribe-post") ?? ""),
  };
}
