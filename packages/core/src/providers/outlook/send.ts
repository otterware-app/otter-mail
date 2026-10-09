/**
 * Sending and drafts through Graph. Everything sent starts as a draft: a
 * reply is made with `createReply` on the message it answers, so Outlook
 * keeps it in the conversation, then gets the composer's recipients, subject
 * and body (the quote included) and its attachments, and is sent. With
 * immutable ids the sent message keeps the draft's id, in Sent Items.
 *
 * A draft is that message in Drafts; each save updates it in place, so a
 * draft's id is its message's id and never changes.
 */

import { fromBase64, toBase64, utf8Encode } from "../../bytes.js";
import * as store from "../../services/mail-store.js";
import { splitAddressList } from "../../services/outgoing.js";
import type { ComposeAttachment } from "../../types.js";
import type { DraftSave, OutgoingMail } from "../provider.js";
import { graph, graphAll, isNotFound } from "./graph.js";
import { messagePath, type ApiMessage } from "./messages.js";

/** Attachments past this go up in an upload session (Graph takes 3 MB in one request). */
const INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** Upload sessions take chunks in multiples of 320 KiB. */
const UPLOAD_CHUNK_BYTES = 10 * 320 * 1024;

type Recipient = { emailAddress: { address: string; name?: string } };

/** "Ann <a@b>, c@d" → Graph's recipients. */
function recipients(list: string | undefined): Recipient[] {
  return (list ? splitAddressList(list) : []).flatMap((entry) => {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(entry);
    const address = (match?.[2] ?? entry).trim();
    if (!address.includes("@")) return [];
    const name = match?.[1]?.trim();
    return [{ emailAddress: name ? { address, name } : { address } }];
  });
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The message's fields as the composer has them. */
function fields(mail: Omit<OutgoingMail, "inReplyTo" | "references" | "attachments">) {
  return {
    subject: mail.subject,
    body: mail.bodyHtml
      ? { contentType: "html", content: mail.bodyHtml }
      : {
          contentType: "html",
          content: `<div style="white-space: pre-wrap">${escapeHtml(mail.body)}</div>`,
        },
    toRecipients: recipients(mail.to),
    ccRecipients: recipients(mail.cc),
    bccRecipients: recipients(mail.bcc),
  };
}

/** The Graph id of the message a Message-ID header names, if it's in the mailbox. */
async function messageByHeader(accountId: string, header: string): Promise<string | null> {
  const filter = encodeURIComponent(`internetMessageId eq '${header.replace(/'/g, "''")}'`);
  const found = await graph<{ value?: { id: string }[] }>(
    accountId,
    `/me/messages?$filter=${filter}&$select=id&$top=1`,
  );
  return found.value?.[0]?.id ?? null;
}

/** What a reply answers: the message its In-Reply-To names, else the thread's latest. */
async function repliedTo(
  accountId: string,
  inReplyTo: string | undefined,
  threadId: string | undefined,
): Promise<string | null> {
  if (inReplyTo) {
    const id = await messageByHeader(accountId, inReplyTo);
    if (id) return id;
  }
  if (!threadId) return null;
  const latest = store
    .getThreadMessages(accountId, threadId)
    .filter((m) => !m.labelIds.includes("DRAFT"))
    .sort((a, b) => b.date - a.date)[0];
  return latest?.id ?? null;
}

/** A new draft: a reply to `replyTo` (in its conversation), or a message of its own. */
async function createDraft(
  accountId: string,
  mail: Omit<OutgoingMail, "inReplyTo" | "references" | "attachments">,
  replyTo: string | null,
): Promise<ApiMessage> {
  if (replyTo) {
    try {
      const draft = await graph<ApiMessage>(accountId, `${messagePath(replyTo)}/createReply`, {
        method: "POST",
      });
      return graph<ApiMessage>(accountId, messagePath(draft.id), {
        method: "PATCH",
        body: fields(mail),
      });
    } catch (err) {
      // The message it answers is gone: a message of its own, then.
      if (!isNotFound(err)) throw err;
    }
  }
  return graph<ApiMessage>(accountId, "/me/messages", { method: "POST", body: fields(mail) });
}

/** Puts the composer's attachments on a draft: small ones in one request, big ones in chunks. */
async function attach(
  accountId: string,
  draftId: string,
  attachments: ComposeAttachment[],
): Promise<void> {
  const path = `${messagePath(draftId)}/attachments`;
  for (const attachment of attachments) {
    const bytes = fromBase64(attachment.base64);
    if (bytes.length <= INLINE_ATTACHMENT_BYTES) {
      await graph(accountId, path, {
        method: "POST",
        body: {
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: attachment.name,
          contentType: attachment.mimeType,
          contentBytes: toBase64(bytes),
        },
      });
      continue;
    }
    const session = await graph<{ uploadUrl: string }>(accountId, `${path}/createUploadSession`, {
      method: "POST",
      body: {
        AttachmentItem: {
          attachmentType: "file",
          name: attachment.name,
          size: bytes.length,
          contentType: attachment.mimeType,
        },
      },
    });
    // The upload URL carries its own authorization: no bearer token.
    for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) {
      const chunk = bytes.subarray(start, start + UPLOAD_CHUNK_BYTES);
      const response = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Range": `bytes ${start}-${start + chunk.length - 1}/${bytes.length}`,
        },
        body: chunk.slice(),
      });
      if (!response.ok) {
        throw new Error(`Couldn't upload ${attachment.name} to Outlook (${response.status}).`);
      }
    }
  }
}

/** Makes the draft's attachments the composer's: drops the ones it no longer has, adds new ones. */
async function syncAttachments(
  accountId: string,
  draftId: string,
  attachments: ComposeAttachment[],
): Promise<void> {
  const path = `${messagePath(draftId)}/attachments`;
  const existing = await graphAll<{ id: string; name: string; size: number; isInline?: boolean }>(
    accountId,
    `${path}?$select=id,name,size,isInline`,
  );
  const wanted = [...attachments];
  for (const current of existing) {
    if (current.isInline) continue;
    // Graph's size counts the attachment's properties too: match by name.
    const at = wanted.findIndex((a) => a.name === current.name);
    if (at >= 0) wanted.splice(at, 1);
    else await graph(accountId, `${path}/${encodeURIComponent(current.id)}`, { method: "DELETE" });
  }
  await attach(accountId, draftId, wanted);
}

export async function send(accountId: string, mail: OutgoingMail): Promise<{ messageId?: string }> {
  if (recipients(mail.to).length + recipients(mail.cc).length + recipients(mail.bcc).length === 0) {
    throw new Error("Add at least one recipient.");
  }
  const replyTo = await repliedTo(accountId, mail.inReplyTo, mail.threadId);
  const draft = await createDraft(accountId, mail, replyTo);
  try {
    if (mail.attachments?.length) await attach(accountId, draft.id, mail.attachments);
    await graph(accountId, `${messagePath(draft.id)}/send`, { method: "POST" });
  } catch (err) {
    // Don't leave a half-made draft behind.
    await graph(accountId, `${messagePath(draft.id)}/permanentDelete`, { method: "POST" }).catch(
      () => {},
    );
    throw err;
  }
  return { messageId: draft.id };
}

/** A ready-made RFC 822 message (unsubscribe mail, invitation replies), sent as MIME. */
export async function sendRaw(accountId: string, raw: string): Promise<void> {
  await graph(accountId, "/me/sendMail", {
    method: "POST",
    body: toBase64(utf8Encode(raw)),
    contentType: "text/plain",
  });
}

export async function saveDraft(
  accountId: string,
  draft: DraftSave,
): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
  let saved: ApiMessage | null = null;
  if (draft.draftId) {
    try {
      saved = await graph<ApiMessage>(accountId, messagePath(draft.draftId), {
        method: "PATCH",
        body: fields(draft),
      });
    } catch (err) {
      // Sent or deleted elsewhere meanwhile: save it anew.
      if (!isNotFound(err)) throw err;
    }
  }
  if (saved) await syncAttachments(accountId, saved.id, draft.attachments ?? []);
  else {
    saved = await createDraft(
      accountId,
      draft,
      await repliedTo(accountId, undefined, draft.threadId),
    );
    if (draft.attachments?.length) await attach(accountId, saved.id, draft.attachments);
  }
  return { draftId: saved.id, messageId: saved.id, threadId: saved.conversationId };
}

export async function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<{ messageId?: string }> {
  try {
    await graph(accountId, `${messagePath(draftId)}/permanentDelete`, { method: "POST" });
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  return { messageId: draftId };
}

export async function getDraftVersion(accountId: string, draftId: string): Promise<string | null> {
  try {
    const message = await graph<ApiMessage>(
      accountId,
      `${messagePath(draftId)}?$select=id,isDraft`,
    );
    return message.isDraft ? message.id : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** A draft's id is its message's: the message itself when it's a draft, else one in its thread. */
export async function findDraftId(
  accountId: string,
  messageId: string,
  threadId?: string,
): Promise<string | null> {
  if (store.getMessageLabelIds(accountId, messageId)?.includes("DRAFT")) return messageId;
  if (!threadId) return null;
  const draft = store
    .getThreadMessages(accountId, threadId)
    .filter((m) => m.labelIds.includes("DRAFT"))
    .sort((a, b) => b.date - a.date)[0];
  return draft?.id ?? null;
}
