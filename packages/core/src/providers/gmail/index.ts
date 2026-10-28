/**
 * Gmail, through the Gmail API: a Google sign-in (the platform's GoogleAuth),
 * Gmail's per-user quota, history sync, and push through the relay
 * (users.watch → Pub/Sub → relay).
 */

import { GMAIL_CAPABILITIES, GMAIL_SETTINGS_PERMISSION } from "@otter-mail/contracts";

import { SIGNED_OUT_MESSAGE } from "../../google.js";
import { platform } from "../../platform.js";
import type { MailProvider } from "../provider.js";
import * as api from "./api.js";
import * as calendar from "./calendar.js";
import { inTier, isCoolingDown } from "./quota.js";
import { backfillGmail, forgetGmailSync, needsBackfill, syncGmail } from "./sync.js";
import { renewWatch } from "./watch.js";

export const gmailProvider: MailProvider = {
  kind: "gmail",
  capabilities: GMAIL_CAPABILITIES,

  isSignedIn: (accountId) => platform().google.isSignedIn(accountId),
  signedOutMessage: SIGNED_OUT_MESSAGE,
  async removeAccount(accountId) {
    forgetGmailSync(accountId);
    await platform().google.removeTokens(accountId);
  },

  sync: syncGmail,
  needsBackfill,
  backfill: backfillGmail,
  background: inTier,
  isCoolingDown,
  errorKind: api.errorKind,
  describeError: api.describeError,

  watchViaRelay: renewWatch,

  listLabels: api.listLabels,
  getSummaries: api.fetchMetadataForIds,
  getMessage: api.getMessage,
  getThread: api.getThread,
  fetchAttachment: api.fetchAttachment,
  getReplyHeaders: api.fetchReplyHeaders,
  getUnsubscribeHeaders: api.getUnsubscribeHeaders,
  listIds: api.listMessageIdsPage,
  search: api.searchMailPage,

  async modifyMessage(accountId, messageId, change) {
    await api.modifyMessage(accountId, messageId, change);
  },
  async modifyThread(accountId, threadId, change) {
    await api.modifyThread(accountId, threadId, change);
  },
  async trashMessage(accountId, messageId) {
    await api.trashMessage(accountId, messageId);
  },
  async trashThread(accountId, threadId) {
    await api.trashThread(accountId, threadId);
  },
  untrashMessage: api.untrashMessage,
  untrashThread: api.untrashThread,
  deleteForever: api.batchDeleteMessages,
  async emptyFolder(accountId, labelId, cachedIds) {
    // Gmail's own listing too: the cache may not have every message.
    const ids = new Set(cachedIds);
    let pageToken: string | undefined;
    do {
      const page = await api.listMessageIdsPage(accountId, { labelIds: [labelId], pageToken });
      for (const id of page.ids) ids.add(id);
      pageToken = page.nextPageToken;
    } while (pageToken);
    const messageIds = [...ids];
    if (messageIds.length > 0) await api.batchDeleteMessages(accountId, messageIds);
    return messageIds;
  },

  createLabel: api.createLabel,
  async updateLabel(accountId, params) {
    await api.updateLabel(accountId, params);
  },
  async deleteLabel(accountId, labelId) {
    await api.deleteLabel(accountId, labelId);
  },

  send: api.sendMessage,
  async sendRaw(accountId, raw, threadId) {
    await api.sendRawMessage(accountId, raw, threadId);
  },

  saveDraft: api.saveDraft,
  deleteDraft: api.deleteDraft,
  getDraftVersion: api.getDraftVersion,
  findDraftId: api.findDraftIdByMessageId,

  signatures: {
    get: api.getSignature,
    async set(accountId, email, html) {
      try {
        return await api.setSignature(accountId, email, html);
      } catch (err) {
        // Only a sign-in without the settings scope; not rate limits or other refusals.
        if (
          err instanceof api.GmailApiError &&
          err.status === 403 &&
          !err.rateLimited &&
          /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(err.body)
        ) {
          throw new Error(GMAIL_SETTINGS_PERMISSION, { cause: err });
        }
        throw err;
      }
    },
  },

  calendar,
};
