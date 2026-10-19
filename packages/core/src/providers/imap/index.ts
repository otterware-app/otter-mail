/**
 * Any other mailbox, through IMAP (and SMTP to send): a password kept on the
 * device, folders as labels, UID/modseq sync and IDLE (docs/imap.md).
 */

import { IMAP_CAPABILITIES } from "@otter-mail/contracts";

import { MailProtocolError } from "../../protocols/index.js";
import { hasImapPassword } from "../../services/imap-passwords.js";
import type { ErrorKind, MailProvider } from "../provider.js";
import { closeImap, FolderChanged, failedServer, tier } from "./connection.js";
import { forgetFolders } from "./folders.js";
import * as reads from "./reads.js";
import * as send from "./send.js";
import { readLabels, syncImap } from "./sync.js";
import { watchInbox } from "./watch.js";
import * as writes from "./writes.js";

/** The web app's tunnel turned a connection away (mail-socket.ts): wait, like a rate limit. */
const tooManyConnections = (err: MailProtocolError) =>
  err.kind === "network" && /Too many connections/i.test(err.message);

function errorKind(err: unknown): ErrorKind | null {
  if (err instanceof reads.MessageGone) return "notFound";
  if (!(err instanceof MailProtocolError)) return null;
  if (err.kind === "auth") return "auth";
  if (tooManyConnections(err)) return "rateLimit";
  if (err.kind === "network" || err.kind === "timeout") return "network";
  // Too many connections, or the server is unwell: back off like a rate limit.
  const code = (err as { code?: string }).code;
  if (code === "LIMIT" || code === "UNAVAILABLE" || code === "INUSE") return "rateLimit";
  return null;
}

function describeError(err: unknown): string {
  if (err instanceof FolderChanged) return err.message;
  if (err instanceof MailProtocolError) {
    const where = failedServer.get(err);
    const host = where?.host ?? "the mail server";
    if (err.kind === "auth") return `Wrong password for ${where?.user ?? "this mailbox"}`;
    if (/certificate|self[- ]signed|CERT_|unable to verify/i.test(err.message)) {
      return `${host}'s certificate isn't trusted — check the server name`;
    }
    if (tooManyConnections(err)) return "Too many connections, retrying shortly";
    if (err.kind === "network") return `Can't reach ${host} — retrying`;
    if (err.kind === "timeout") return `${host} isn't answering — retrying`;
    const text = (err as { serverText?: string }).serverText || err.message;
    return `${host}: ${text.slice(0, 200)}`;
  }
  const text = String(err);
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export const imapProvider: MailProvider = {
  kind: "imap",
  capabilities: IMAP_CAPABILITIES,

  isSignedIn: hasImapPassword,
  signedOutMessage: "Enter this mailbox's password to sync it.",
  // The password goes with the account (handlers' removeLocalAccount).
  async removeAccount(accountId) {
    closeImap(accountId);
    forgetFolders(accountId);
  },

  sync: syncImap,
  // No quota to share; background work just waits behind the user's for the connection.
  background: (lane, fn) => tier().run(lane, fn),
  errorKind,
  describeError,

  watch: watchInbox,

  listLabels: readLabels,
  getSummaries: reads.getSummaries,
  getMessage: reads.getMessage,
  fetchAttachment: reads.fetchAttachment,
  getReplyHeaders: reads.getReplyHeaders,
  getUnsubscribeHeaders: reads.getUnsubscribeHeaders,

  modifyMessage: writes.modifyMessage,
  modifyThread: writes.modifyThread,
  trashMessage: writes.trashMessage,
  trashThread: writes.trashThread,
  untrashMessage: writes.untrashMessage,
  untrashThread: writes.untrashThread,
  deleteForever: writes.deleteForever,
  emptyFolder: writes.emptyFolder,

  createLabel: writes.createLabel,
  updateLabel: writes.updateLabel,
  deleteLabel: writes.deleteLabel,

  send: send.send,
  sendRaw: (accountId, raw) => send.sendRaw(accountId, raw),

  saveDraft: send.saveDraft,
  deleteDraft: send.deleteDraft,
  getDraftVersion: send.getDraftVersion,
  findDraftId: send.findDraftId,
};
