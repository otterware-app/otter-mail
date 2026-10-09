/**
 * Outlook (Microsoft 365, outlook.com), through Microsoft Graph: a Microsoft
 * sign-in (the platform's MicrosoftAuth), folders and categories as labels,
 * per-folder delta sync, Outlook's search and calendar, and push through the
 * relay (a Graph subscription → relay → devices). See docs/outlook.md.
 */

import { OUTLOOK_CAPABILITIES } from "@otter-mail/contracts";

import { OUTLOOK_SIGNED_OUT_MESSAGE } from "../../microsoft.js";
import { platform } from "../../platform.js";
import * as mailStore from "../../services/mail-store.js";
import type { MailProvider } from "../provider.js";
import * as calendar from "./calendar.js";
import { forgetFolders, labelsOf, readMailbox } from "./folders.js";
import { describeError, errorKind, forgetGraph, isCoolingDown, tier } from "./graph.js";
import * as messages from "./messages.js";
import { readProfile } from "./profile.js";
import * as search from "./search.js";
import * as send from "./send.js";
import { backfillOutlook, forgetOutlookSync, needsBackfill, syncOutlook } from "./sync.js";
import { endSubscription, renewSubscription } from "./watch.js";
import * as writes from "./writes.js";

export const outlookProvider: MailProvider = {
  kind: "outlook",
  capabilities: OUTLOOK_CAPABILITIES,

  isSignedIn: (accountId) => platform().microsoft?.isSignedIn(accountId) ?? false,
  signedOutMessage: OUTLOOK_SIGNED_OUT_MESSAGE,
  async removeAccount(accountId) {
    await endSubscription(accountId);
    forgetOutlookSync(accountId);
    forgetFolders(accountId);
    forgetGraph(accountId);
    await platform().microsoft?.removeTokens(accountId);
  },

  sync: syncOutlook,
  needsBackfill,
  backfill: backfillOutlook,
  background: (lane, fn) => tier().run(lane, fn),
  isCoolingDown,
  errorKind,
  describeError,

  watchViaRelay: (accountId) => renewSubscription(accountId),

  async listLabels(accountId) {
    return labelsOf(accountId, await readMailbox(accountId));
  },
  getSummaries: messages.getSummaries,
  getMessage: messages.getMessage,
  fetchAttachment: messages.fetchAttachment,
  getReplyHeaders: messages.getReplyHeaders,
  getUnsubscribeHeaders: messages.getUnsubscribeHeaders,
  listIds: search.listIds,
  search: (accountId, q, pageToken, maxResults) =>
    search.search(accountId, q, pageToken, maxResults, mailStore.getLabels(accountId)),

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

  readProfile,

  calendar,
};
