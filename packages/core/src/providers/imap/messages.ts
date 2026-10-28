/**
 * IMAP messages in the cache's shape: summaries from FETCH (ENVELOPE, FLAGS,
 * BODYSTRUCTURE, the reply headers and the start of the body, for the
 * snippet), and whole messages from BODY[] parsed with postal-mime.
 */

import { utf8Encode } from "../../bytes.js";
import {
  parseMessage,
  type BodyStructure,
  type FetchedMessage,
  type FetchQuery,
  type ImapAddress,
  type ParsedMessage,
} from "../../protocols/index.js";
import type { MessageDetail, MessageSummary } from "../../types.js";
import { labelsFor, messageId, type Folder } from "./folders.js";

const SNIPPET_BYTES = 1024;

export const SUMMARY_QUERY: FetchQuery = {
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  headers: ["References"],
  textStart: SNIPPET_BYTES,
};

/** How a list shows addresses: `Name <a@b>, c@d` (names with commas quoted). */
export function formatAddresses(addresses: ImapAddress[]): string {
  return addresses
    .map(({ name, address }) => {
      if (!name || name === address) return address;
      return /[",]/.test(name)
        ? `"${name.replace(/"/g, '\\"')}" <${address}>`
        : `${name} <${address}>`;
    })
    .join(", ");
}

/** The first `<id>` in a header (References, In-Reply-To), brackets and all. */
const firstId = (value: string | null | undefined): string | null =>
  value?.match(/<[^<>\s]+>/)?.[0] ?? null;

/** A subject without its Re:/Fwd: prefixes (in a few languages), for threading. */
export function baseSubject(subject: string): string {
  let text = subject.replace(/\s+/g, " ").trim().toLowerCase();
  for (;;) {
    const next = text.replace(/^(re|fwd?|aw|wg|sv|vs|antw|tr|rif|odp)(\[\d+\])?\s*:\s*/, "");
    if (next === text) return text;
    text = next;
  }
}

/** FNV-1a, as 8 hex digits: a short, stable tag for a subject. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A conversation is its root message (the first of References, else
 * In-Reply-To, else the message itself) and its subject, Re: and all
 * stripped: `<subject hash>.<root id without brackets>`. The subject is part
 * of it because References is the sender's to write: naming someone else's
 * Message-ID alone mustn't pull a message into their conversation (and have
 * it reported as junk along with it).
 */
export function threadIdOf(
  references: string | undefined,
  inReplyTo: string | null | undefined,
  ownId: string | null | undefined,
  subject: string,
): string | null {
  const root = firstId(references) ?? firstId(inReplyTo) ?? firstId(ownId);
  return root ? `${hash(baseSubject(subject))}.${root.slice(1, -1)}` : null;
}

/** The References header a draft carries to stay in its conversation (its root id). */
export const referencesFor = (threadId: string | undefined): string | undefined => {
  const root = /^[\da-f]{8}\.(.+@.+)$/.exec(threadId ?? "")?.[1];
  return root ? `<${root}>` : undefined;
};

function hasAttachments(node: BodyStructure | undefined): boolean {
  if (!node) return false;
  if (node.childNodes.length > 0 && !node.type.startsWith("message/")) {
    return node.childNodes.some(hasAttachments);
  }
  return node.disposition === "attachment" || (!!node.filename && node.disposition !== "inline");
}

export function snippetOf(parsed: Pick<ParsedMessage, "text" | "html">): string {
  const text = parsed.text ?? htmlText(parsed.html ?? "");
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function htmlText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * The snippet from the first bytes of the body: put back behind the
 * message's own Content-Type (a multipart's boundary, a part's encoding), the
 * truncated body parses like any message.
 */
async function snippetFromStart(structure: BodyStructure | undefined, start: Uint8Array) {
  if (!structure || start.length === 0) return "";
  const params = Object.entries(structure.parameters)
    .map(([key, value]) => `; ${key}="${value.replace(/["\\\r\n]/g, "")}"`)
    .join("");
  const head = [`Content-Type: ${structure.type}${params}`];
  if (structure.encoding) head.push(`Content-Transfer-Encoding: ${structure.encoding}`);
  const header = utf8Encode(`${head.join("\r\n")}\r\n\r\n`);
  const source = new Uint8Array(header.length + start.length);
  source.set(header);
  source.set(start, header.length);
  try {
    return snippetOf(await parseMessage(source));
  } catch {
    return "";
  }
}

export async function toSummary(
  folder: Folder,
  uidValidity: number,
  message: FetchedMessage,
): Promise<MessageSummary> {
  const envelope = message.envelope;
  const id = messageId(uidValidity, message.uid, folder.path);
  const labelIds = labelsFor(folder, message.flags ?? []);
  const from = envelope?.from[0] ?? envelope?.sender[0];
  const references = message.headers?.references;
  return {
    id,
    threadId:
      threadIdOf(references, envelope?.inReplyTo, envelope?.messageId, envelope?.subject ?? "") ??
      id,
    fromName: from?.name ?? "",
    fromEmail: from?.address ?? "",
    to: formatAddresses(envelope?.to ?? []),
    subject: envelope?.subject ?? "",
    snippet: await snippetFromStart(message.bodyStructure, message.textStart ?? new Uint8Array()),
    date: (message.internalDate ?? envelope?.date)?.getTime() ?? 0,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    labelIds,
    hasAttachments: hasAttachments(message.bodyStructure),
    messageIdHeader: envelope?.messageId ?? undefined,
    referencesHeader: references || undefined,
  };
}

export const DETAIL_QUERY: FetchQuery = { ...SUMMARY_QUERY, textStart: undefined, source: true };

/** A whole message; attachment ids are indexes into postal-mime's list. */
export async function toDetail(
  folder: Folder,
  uidValidity: number,
  message: FetchedMessage,
): Promise<MessageDetail> {
  const summary = await toSummary(folder, uidValidity, message);
  const parsed = await parseMessage(message.source ?? new Uint8Array());
  const attachments = parsed.attachments.map((a, i) => ({
    id: String(i),
    filename: a.filename ?? `attachment-${i + 1}`,
    mimeType: a.mimeType,
    size: a.bytes.length,
    // Inline images are referenced from the HTML as `cid:<Content-ID>`.
    contentId: a.contentId ?? undefined,
  }));
  return {
    ...summary,
    snippet: snippetOf(parsed) || summary.snippet,
    cc: formatAddresses(message.envelope?.cc ?? []) || undefined,
    bcc: formatAddresses(message.envelope?.bcc ?? []) || undefined,
    bodyHtml: parsed.html,
    bodyText: parsed.text,
    hasAttachments: attachments.length > 0,
    attachments,
  };
}
