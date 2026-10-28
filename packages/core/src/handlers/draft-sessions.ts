/**
 * Draft sessions: one per open composer. Saves for a session run in order and
 * reuse its draft id, so a first save whose reply never reached the renderer
 * (IPC timeout) can't lead to a second draft.
 */

import { getAccount } from "../services/account-store.js";
import * as mailStore from "../services/mail-store.js";
import type { ComposeAttachment, MessageSummary } from "../types.js";

// ── Draft sessions (one per open composer) ──────────────────────────────────

/** Draft id per composer session, `${accountId}|${sessionKey}`. */
const draftSessions = new Map<string, string>();
/** The tail of each session's save queue. */
const draftSaveQueues = new Map<string, Promise<unknown>>();

export const draftSessionId = (accountId: string, sessionKey: string | undefined) =>
  sessionKey ? `${accountId}|${sessionKey}` : "";

/** Runs a session's saves one after another (no session: runs directly). */
export function queueDraftSave<T>(sessionId: string, save: () => Promise<T>): Promise<T> {
  if (!sessionId) return save();
  const previous = draftSaveQueues.get(sessionId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(save);
  draftSaveQueues.set(sessionId, next);
  void next
    .finally(() => {
      if (draftSaveQueues.get(sessionId) === next) draftSaveQueues.delete(sessionId);
    })
    .catch(() => {});
  return next;
}

export type DraftContent = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: ComposeAttachment[];
};

/**
 * Mirrors a saved draft into the cache from what was just saved — no Gmail
 * read-back, so a save costs one round trip — and records its draft id so
 * reopening it needs no Gmail lookup. With attachments only the summary is
 * mirrored (the cache's attachment list comes from Gmail's ids).
 */
export async function mirrorDraft(
  accountId: string,
  res: { draftId: string; messageId?: string; threadId?: string; revision?: string },
  content: DraftContent,
): Promise<void> {
  if (!res.messageId) return;
  try {
    const account = await getAccount(accountId);
    const summary: MessageSummary = {
      id: res.messageId,
      threadId: res.threadId ?? res.messageId,
      fromName: account?.displayName || account?.name || "",
      fromEmail: account?.email ?? accountId,
      to: content.to,
      subject: content.subject,
      snippet: content.body.replace(/\s+/g, " ").trim().slice(0, 200),
      date: Date.now(),
      unread: false,
      starred: false,
      labelIds: ["DRAFT"],
      hasAttachments: (content.attachments?.length ?? 0) > 0,
    };
    if (summary.hasAttachments) {
      mailStore.upsertMessages(accountId, [summary]);
      mailStore.invalidateMessageDetail(accountId, res.messageId);
    } else {
      mailStore.upsertMessageDetail(accountId, {
        ...summary,
        draftRevision: res.revision,
        cc: content.cc,
        bcc: content.bcc,
        bodyHtml: content.bodyHtml ?? null,
        bodyText: content.body,
        attachments: [],
      });
    }
    mailStore.setDraftId(accountId, res.messageId, res.draftId);
    if (res.threadId) mailStore.deleteOtherDraftsInThread(accountId, res.threadId, res.messageId);
  } catch (err) {
    console.log("[gmail:saveDraft] saved; local mirror failed", { error: String(err) });
  }
}

/** The draft id a session's saves have produced so far, if any. */
export function sessionDraftId(sessionId: string): string | undefined {
  return sessionId ? draftSessions.get(sessionId) : undefined;
}

export function rememberSessionDraft(sessionId: string, draftId: string): void {
  if (sessionId) draftSessions.set(sessionId, draftId);
}

/** Ends a session: waits for its queued saves, then returns (and forgets) the
    draft id they produced. */
export async function takeSessionDraft(sessionId: string): Promise<string | undefined> {
  if (!sessionId) return undefined;
  await draftSaveQueues.get(sessionId)?.catch(() => {});
  const draftId = draftSessions.get(sessionId);
  draftSessions.delete(sessionId);
  return draftId;
}
