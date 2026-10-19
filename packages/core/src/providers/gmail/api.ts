/**
 * Gmail REST API client.
 * Base URL: https://gmail.googleapis.com/gmail/v1/users/me
 *
 * gmailFetch: authenticated fetch that spends the account's Gmail quota through
 * quota.ts (user actions first, sync in the background) and backs off on
 * rate limits (429, and 403 per-user quota errors).
 */

import { fromBase64, toBase64Url, utf8Decode, utf8Encode } from "../../bytes.js";
import { SIGNED_OUT_MESSAGE } from "../../google.js";
import { logger } from "../../logger.js";
import { platform } from "../../platform.js";
import { mapPool } from "../../pool.js";
import { getAccount } from "../../services/account-store.js";
import { buildMime, formatAddress } from "../../services/outgoing.js";
import type { GmailLabel, GmailMessageSummary, GmailMessageDetail } from "../../types.js";
import type { DraftSave, ErrorKind, OutgoingMail } from "../provider.js";
import {
  acquireQuota,
  budgetOf,
  isBackgroundWork,
  quotaCost,
  reportQuotaExceeded,
  spentLastMinute,
} from "./quota.js";

const BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Retries after a rate-limit error. Gmail's quota window is a minute, so the
 * user's own requests wait it out too (writes already answer the UI early and
 * finish in the background, see settleGmailWrite); sync work backs off longer.
 * The quota is per user and per Google project, shared with every other app
 * signed in through the same project, so this app alone can't stay under it.
 */
const FOREGROUND_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
const BACKGROUND_MAX_RETRIES = 6;
/** Transient failures (network drop, Gmail 5xx) retried by background work. */
const BACKGROUND_TRANSIENT_RETRIES = 3;
/** A request that hangs must not stall a sync run forever. */
const REQUEST_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Gmail reports per-user quota exhaustion as 403 as well as 429. */
function isRateLimited(status: number, body: string): boolean {
  if (status === 429) return true;
  return (
    status === 403 &&
    /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED|Quota exceeded/.test(body)
  );
}

/** Gmail's own sentence from an error body ({"error": {"message": …}}), if it has one. */
function gmailErrorMessage(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message?.trim() ?? "";
  } catch {
    return body.trim().slice(0, 200);
  }
}

/**
 * A failed Gmail call. The message keeps the "Gmail API error: <status>" shape
 * callers match on, followed by a readable reason; the full body stays in `body`.
 */
export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly body: string,
  ) {
    const reason = isRateLimited(status, body)
      ? "Gmail is limiting requests for this account right now. Try again in a minute."
      : gmailErrorMessage(body);
    super(`Gmail API error: ${status} ${statusText}${reason ? ` — ${reason}` : ""}`);
    this.name = "GmailApiError";
  }

  get rateLimited(): boolean {
    return isRateLimited(this.status, this.body);
  }
}

/** Whether an error is Gmail telling us to slow down (after gmailFetch's own retries). */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof GmailApiError && err.rateLimited;
}

/** Whether an error is the request not reaching Gmail at all (offline, DNS, timeout). */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof GmailApiError) return false;
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(
      `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`,
    )
  );
}

export function errorKind(err: unknown): ErrorKind | null {
  if (isRateLimitError(err)) return "rateLimit";
  if (isNetworkError(err)) return "network";
  if (err instanceof GmailApiError && err.status === 404) return "notFound";
  if (isSignInError(err)) return "auth";
  return null;
}

/** Google revoked or expired the sign-in, or it lacks the scopes Gmail needs. */
function isSignInError(err: unknown): boolean {
  if (err instanceof GmailApiError) {
    return (
      err.status === 401 ||
      (err.status === 403 && /insufficient(Permissions| authentication scopes)/i.test(err.body))
    );
  }
  const text = String(err);
  return text.includes(SIGNED_OUT_MESSAGE) || text.includes("Google sign-in expired");
}

/** A short, readable reason for the status line (Gmail errors carry whole JSON bodies). */
export function describeError(err: unknown): string {
  if (isRateLimitError(err)) return "Gmail is limiting requests right now — retrying shortly";
  if (isNetworkError(err)) return "Can't reach Gmail — retrying when the connection is back";
  const text = String(err);
  if (text.includes(SIGNED_OUT_MESSAGE) || text.includes("Google sign-in expired")) {
    return SIGNED_OUT_MESSAGE;
  }
  if (err instanceof GmailApiError) {
    if (err.status === 401) {
      return "Gmail rejected this account's sign-in — sign in to it again";
    }
    if (err.status >= 500) return "Gmail is having trouble right now — retrying shortly";
    let detail = "";
    try {
      detail = (JSON.parse(err.body) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      // not JSON: fall back to the status alone
    }
    return `Gmail error ${err.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`;
  }
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

type GmailFetchInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

// ── gmailFetch ────────────────────────────────────────────────────────────────

async function gmailFetch(
  accountId: string,
  path: string,
  init: GmailFetchInit = {},
  retryCount = 0,
  attempt: { tokenRefreshed?: boolean; transientRetries?: number } = {},
): Promise<unknown> {
  await acquireQuota(accountId, quotaCost(init.method ?? "GET", path));
  const token = await platform().google.getAccessToken(accountId);
  const background = isBackgroundWork();

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Wi-Fi hiccups and sleep/wake drop requests; sync rides them out.
    const tries = attempt.transientRetries ?? 0;
    if (background && tries < BACKGROUND_TRANSIENT_RETRIES && isNetworkError(err)) {
      await sleep(2000 * 2 ** tries);
      return gmailFetch(accountId, path, init, retryCount, {
        ...attempt,
        transientRetries: tries + 1,
      });
    }
    throw err;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // The cached access token was revoked or expired early: refresh it once.
    if (response.status === 401 && !attempt.tokenRefreshed) {
      await platform().google.getAccessToken(accountId, { forceRefresh: true });
      return gmailFetch(accountId, path, init, retryCount, { ...attempt, tokenRefreshed: true });
    }
    if (isRateLimited(response.status, body)) {
      const retryAfter = parseInt(response.headers.get("Retry-After") ?? "", 10) * 1000;
      const spent = spentLastMinute(accountId);
      if (reportQuotaExceeded(accountId, retryAfter > 0 ? retryAfter : 0)) {
        logger.info("gmail", `rate limited (${response.status}): ${gmailErrorMessage(body)}`, {
          spentLastMinute: spent,
          budgetNow: budgetOf(accountId),
        });
      }
      const waitMs = background
        ? retryAfter > 0
          ? retryAfter
          : Math.min(1000 * 2 ** retryCount, 32_000)
        : retryAfter > 0 && retryCount < FOREGROUND_RETRY_DELAYS_MS.length
          ? retryAfter
          : FOREGROUND_RETRY_DELAYS_MS[retryCount];
      const canRetry = background ? retryCount < BACKGROUND_MAX_RETRIES : waitMs !== undefined;
      if (canRetry) {
        await sleep(waitMs);
        return gmailFetch(accountId, path, init, retryCount + 1, attempt);
      }
    }
    // Gmail's own hiccups ("backendError", 502/503): background work retries.
    const tries = attempt.transientRetries ?? 0;
    if (background && response.status >= 500 && tries < BACKGROUND_TRANSIENT_RETRIES) {
      await sleep(1000 * 2 ** tries);
      return gmailFetch(accountId, path, init, retryCount, {
        ...attempt,
        transientRetries: tries + 1,
      });
    }
    throw new GmailApiError(response.status, response.statusText, body);
  }

  // DELETE endpoints (drafts) return an empty 204 body.
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

// ── listLabels ────────────────────────────────────────────────────────────────

/** Just the label ids and names (one cheap call) — sync uses it to notice
    labels created, renamed or deleted elsewhere. */
export async function listLabelNames(
  accountId: string,
): Promise<{ id: string; name: string; type: string }[]> {
  const data = (await gmailFetch(accountId, "/labels")) as {
    labels?: { id: string; name: string; type: string }[];
  };
  return data.labels ?? [];
}

export async function listLabels(accountId: string): Promise<GmailLabel[]> {
  const rawLabels = await listLabelNames(accountId);

  // labels.list omits message counts and color — only labels.get returns them,
  // so fetch per-label detail for every label.
  const fetched = await mapPool(
    rawLabels,
    8,
    (l) =>
      gmailFetch(accountId, `/labels/${l.id}`) as Promise<{
        id: string;
        messagesUnread?: number;
        messagesTotal?: number;
        color?: { backgroundColor?: string; textColor?: string };
      }>,
  );
  const detailById = new Map(fetched.map((label) => [label.id, label]));

  return rawLabels.map((label) => {
    const detail = detailById.get(label.id);
    return {
      id: label.id,
      name: label.name,
      type: label.type === "system" ? "system" : "user",
      unread: detail?.messagesUnread,
      total: detail?.messagesTotal,
      color:
        detail?.color?.backgroundColor && detail.color.textColor
          ? { backgroundColor: detail.color.backgroundColor, textColor: detail.color.textColor }
          : undefined,
    };
  });
}

// ── createLabel ──────────────────────────────────────────────────────────────

export async function createLabel(accountId: string, name: string): Promise<GmailLabel> {
  const data = (await gmailFetch(accountId, "/labels", {
    method: "POST",
    body: JSON.stringify({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  })) as { id: string; name: string };

  return { id: data.id, name: data.name, type: "user" };
}

// ── Signatures ───────────────────────────────────────────────────────────────

type SendAs = { sendAsEmail: string; isPrimary?: boolean; signature?: string };

/**
 * The signature Gmail keeps for `email` (Settings › Signature on the web).
 * The API has one per send-as address; Gmail's named signatures aren't in it.
 */
export async function getSignature(accountId: string, email: string): Promise<string> {
  const { sendAs = [] } = (await gmailFetch(accountId, "/settings/sendAs")) as {
    sendAs?: SendAs[];
  };
  const own =
    sendAs.find((s) => s.sendAsEmail.toLowerCase() === email.toLowerCase()) ??
    sendAs.find((s) => s.isPrimary);
  return own?.signature ?? "";
}

/** Saves `email`'s signature in Gmail; answers it as Gmail stored it (sanitized). */
export async function setSignature(
  accountId: string,
  email: string,
  html: string,
): Promise<string> {
  const saved = (await gmailFetch(accountId, `/settings/sendAs/${encodeURIComponent(email)}`, {
    method: "PATCH",
    body: JSON.stringify({ signature: html }),
  })) as SendAs;
  return saved.signature ?? "";
}

// ── updateLabel / deleteLabel ────────────────────────────────────────────────

/**
 * Rename and/or recolor a label. Gmail nests by "/" path but a patch does not
 * move children, so renames cascade to every nested label.
 */
export async function updateLabel(
  accountId: string,
  params: {
    labelId: string;
    name?: string;
    color?: { backgroundColor: string; textColor: string };
  },
): Promise<{ ok: true }> {
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.color) body.color = params.color;

  let children: { id: string; name: string }[] = [];
  let oldName: string | undefined;
  if (params.name) {
    const list = (await gmailFetch(accountId, "/labels")) as {
      labels?: { id: string; name: string; type: string }[];
    };
    oldName = (list.labels ?? []).find((l) => l.id === params.labelId)?.name;
    if (oldName) {
      const prefix = `${oldName}/`;
      children = (list.labels ?? []).filter((l) => l.type === "user" && l.name.startsWith(prefix));
    }
  }

  await gmailFetch(accountId, `/labels/${params.labelId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (params.name && oldName) {
    for (const child of children) {
      await gmailFetch(accountId, `/labels/${child.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: `${params.name}${child.name.slice(oldName.length)}` }),
      });
    }
  }
  return { ok: true };
}

export async function deleteLabel(accountId: string, labelId: string): Promise<{ ok: true }> {
  await gmailFetch(accountId, `/labels/${labelId}`, { method: "DELETE" });
  return { ok: true };
}

// ── parseFrom ─────────────────────────────────────────────────────────────────

function parseFrom(from: string): { fromName: string; fromEmail: string } {
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { fromName: match[1].trim().replace(/^"|"$/g, ""), fromEmail: match[2].trim() };
  }
  return { fromName: from, fromEmail: from };
}

// ── getHeaderValue ─────────────────────────────────────────────────────────────

function getHeaderValue(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** A message's List-Unsubscribe / List-Unsubscribe-Post headers (RFC 2369 / 8058). */
export async function getUnsubscribeHeaders(
  accountId: string,
  messageId: string,
): Promise<{ listUnsubscribe: string; oneClick: boolean }> {
  const msg = (await gmailFetch(
    accountId,
    `/messages/${messageId}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`,
  )) as { payload?: { headers?: { name: string; value: string }[] } };
  const headers = msg.payload?.headers ?? [];
  return {
    listUnsubscribe: getHeaderValue(headers, "List-Unsubscribe"),
    oneClick: /List-Unsubscribe=One-Click/i.test(getHeaderValue(headers, "List-Unsubscribe-Post")),
  };
}

// ── mapMessageSummary ─────────────────────────────────────────────────────────

export interface RawMessageMetadata {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: {
    headers?: { name: string; value: string }[];
    parts?: unknown[];
  };
}

export function mapMessageSummary(msg: RawMessageMetadata): GmailMessageSummary {
  const headers = msg.payload?.headers ?? [];
  const from = getHeaderValue(headers, "From");
  const { fromName, fromEmail } = parseFrom(from);
  const labelIds = msg.labelIds ?? [];

  return {
    id: msg.id,
    threadId: msg.threadId,
    fromName,
    fromEmail,
    to: getHeaderValue(headers, "To"),
    subject: getHeaderValue(headers, "Subject"),
    snippet: msg.snippet ?? "",
    date: msg.internalDate ? parseInt(msg.internalDate, 10) : 0,
    unread: labelIds.includes("UNREAD"),
    starred: labelIds.includes("STARRED"),
    labelIds,
    hasAttachments: false, // metadata format does not expose attachment info reliably
    messageIdHeader: getHeaderValue(headers, "Message-ID") || undefined,
    referencesHeader: getHeaderValue(headers, "References") || undefined,
  };
}

// ── fetchMetadataForIds ─────────────────────────────────────────────────────

/**
 * Fetch metadata-format summaries for a set of message ids, capped at 5
 * concurrent requests. Shared by live paging (cold-cache warm-up) and the
 * background sync engine (quota.ts paces the latter behind user actions).
 */
export async function fetchMetadataForIds(
  accountId: string,
  ids: string[],
): Promise<GmailMessageSummary[]> {
  // messages.get costs 5 quota units; quota.ts paces the calls, so the
  // pool only bounds sockets in flight.
  const fetched = await mapPool(ids, 6, async (id) => {
    try {
      return (await gmailFetch(
        accountId,
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID&metadataHeaders=References`,
      )) as RawMessageMetadata;
    } catch (err) {
      // A message can be purged between the history feed listing it and this
      // fetch; a dead id must not kill the sync (the cursor would never
      // advance and every tick would replay the same failure).
      if (err instanceof GmailApiError && err.status === 404) return null;
      throw err;
    }
  });

  return fetched.filter((m): m is RawMessageMetadata => m !== null).map(mapMessageSummary);
}

/**
 * Whole messages (the summary, bodies and attachment list) for a set of ids.
 * A full fetch costs about 2.5 metadata fetches (quota.ts), less than a
 * metadata fetch now and a full one later: sync uses it where bodies are
 * kept for offline reading.
 */
export async function fetchMessagesForIds(
  accountId: string,
  ids: string[],
): Promise<GmailMessageDetail[]> {
  const fetched = await mapPool(ids, 6, async (id) => {
    try {
      return await getMessage(accountId, id);
    } catch (err) {
      // Purged since it was listed: skip it, as fetchMetadataForIds does.
      if (err instanceof GmailApiError && err.status === 404) return null;
      throw err;
    }
  });
  return fetched.filter((m): m is GmailMessageDetail => m !== null);
}

// ── Sync primitives ───────────────────────────────────────────────────────────

/** Mailbox profile — used to seed/track the incremental-sync history cursor. */
export async function getProfile(
  accountId: string,
): Promise<{ historyId: string; messagesTotal: number }> {
  const data = (await gmailFetch(accountId, "/profile")) as {
    historyId?: string;
    messagesTotal?: number;
  };
  return { historyId: data.historyId ?? "", messagesTotal: data.messagesTotal ?? 0 };
}

/** A single page of message ids (no metadata) for full-mailbox sync. */
export async function listMessageIdsPage(
  accountId: string,
  params: { pageToken?: string; maxResults?: number; labelIds?: string[]; spamTrash?: boolean },
): Promise<{ ids: string[]; nextPageToken?: string; resultSizeEstimate: number }> {
  const query = new URLSearchParams();
  query.set("maxResults", String(params.maxResults ?? 500));
  // Spam/Trash are synced too — the Junk and Trash views read the local cache.
  if (params.spamTrash !== false) query.set("includeSpamTrash", "true");
  for (const lid of params.labelIds ?? []) query.append("labelIds", lid);
  if (params.pageToken) query.set("pageToken", params.pageToken);

  const list = (await gmailFetch(accountId, `/messages?${query.toString()}`)) as {
    messages?: { id: string }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  };

  return {
    ids: (list.messages ?? []).map((m) => m.id),
    nextPageToken: list.nextPageToken,
    resultSizeEstimate: list.resultSizeEstimate ?? 0,
  };
}

/**
 * One page of Gmail's own search (the same engine and operators as the Gmail
 * web search box). Spam and Trash are left out unless the query asks for them,
 * like Gmail does.
 */
export async function searchGmailPage(
  accountId: string,
  q: string,
  pageToken?: string,
  maxResults = 50,
): Promise<{
  refs: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}> {
  const query = new URLSearchParams({ q, maxResults: String(maxResults) });
  if (/\b(in|label):(spam|trash|anywhere)\b/i.test(q)) query.set("includeSpamTrash", "true");
  if (pageToken) query.set("pageToken", pageToken);
  const list = (await gmailFetch(accountId, `/messages?${query.toString()}`)) as {
    messages?: { id: string; threadId: string }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  };
  return {
    refs: list.messages ?? [],
    nextPageToken: list.nextPageToken,
    resultSizeEstimate: list.resultSizeEstimate ?? 0,
  };
}

export interface GmailHistoryPage {
  historyId?: string;
  nextPageToken?: string;
  history?: {
    messagesAdded?: { message: { id: string } }[];
    messagesDeleted?: { message: { id: string } }[];
    labelsAdded?: { message: { id: string }; labelIds: string[] }[];
    labelsRemoved?: { message: { id: string }; labelIds: string[] }[];
  }[];
}

/** One page of the history feed since `startHistoryId`. */
export async function listHistory(
  accountId: string,
  startHistoryId: string,
  pageToken?: string,
): Promise<GmailHistoryPage> {
  const query = new URLSearchParams();
  query.set("startHistoryId", startHistoryId);
  query.set("maxResults", "500");
  if (pageToken) query.set("pageToken", pageToken);
  return (await gmailFetch(accountId, `/history?${query.toString()}`)) as GmailHistoryPage;
}

/**
 * Asks Gmail to publish this mailbox's changes to a Pub/Sub topic (the
 * relay's). A watch lasts 7 days; Gmail recommends renewing it daily.
 */
export async function watchMailbox(
  accountId: string,
  topicName: string,
): Promise<{ historyId: string; expiration: number }> {
  const data = (await gmailFetch(accountId, "/watch", {
    method: "POST",
    body: JSON.stringify({ topicName }),
  })) as { historyId?: string; expiration?: string };
  return { historyId: data.historyId ?? "", expiration: Number(data.expiration ?? 0) };
}

/** Distinguish an expired-history-cursor (HTTP 404) from other failures. */
export function isHistoryExpiredError(err: unknown): boolean {
  return err instanceof GmailApiError && err.status === 404;
}

// ── getMessage ────────────────────────────────────────────────────────────────

interface MimePart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: MimePart[];
}

function decodeBase64url(data: string): string {
  return utf8Decode(fromBase64(data));
}

function walkParts(
  parts: MimePart[],
  result: {
    bodyHtml: string | null;
    bodyText: string | null;
    attachments: {
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      contentId?: string;
    }[];
  },
): void {
  for (const part of parts) {
    const mimeType = part.mimeType ?? "";

    if (part.filename && part.body?.attachmentId) {
      result.attachments.push({
        id: part.body.attachmentId,
        filename: part.filename,
        mimeType,
        size: part.body.size ?? 0,
        // Inline images are referenced from the HTML as `cid:<Content-ID>`.
        contentId:
          getHeaderValue(part.headers ?? [], "Content-ID").replace(/^<|>$/g, "") || undefined,
      });
      continue;
    }

    if (mimeType === "text/html" && result.bodyHtml === null && part.body?.data) {
      result.bodyHtml = decodeBase64url(part.body.data);
    } else if (mimeType === "text/plain" && result.bodyText === null && part.body?.data) {
      result.bodyText = decodeBase64url(part.body.data);
    }

    if (part.parts?.length) {
      walkParts(part.parts, result);
    }
  }
}

interface RawMessageFull extends RawMessageMetadata {
  payload?: RawMessageMetadata["payload"] & {
    body?: { data?: string };
    parts?: MimePart[];
    mimeType?: string;
  };
}

export async function getMessage(
  accountId: string,
  messageId: string,
): Promise<GmailMessageDetail> {
  return detailOf(
    (await gmailFetch(accountId, `/messages/${messageId}?format=full`)) as RawMessageFull,
  );
}

/**
 * Every message of a thread, whole: one threads.get (40 units) where each
 * message on its own costs 20, so it's cheaper from two messages up.
 */
export async function getThread(
  accountId: string,
  threadId: string,
): Promise<GmailMessageDetail[]> {
  const thread = (await gmailFetch(accountId, `/threads/${threadId}?format=full`)) as {
    messages?: RawMessageFull[];
  };
  return (thread.messages ?? []).map(detailOf);
}

function detailOf(msg: RawMessageFull): GmailMessageDetail {
  const summary = mapMessageSummary(msg);
  const headers = msg.payload?.headers ?? [];

  const bodyResult: {
    bodyHtml: string | null;
    bodyText: string | null;
    attachments: {
      id: string;
      filename: string;
      mimeType: string;
      size: number;
      contentId?: string;
    }[];
  } = { bodyHtml: null, bodyText: null, attachments: [] };

  const payload = msg.payload;
  if (payload) {
    const topMime = payload.mimeType ?? "";
    if (topMime === "text/html" && payload.body?.data) {
      bodyResult.bodyHtml = decodeBase64url(payload.body.data);
    } else if (topMime === "text/plain" && payload.body?.data) {
      bodyResult.bodyText = decodeBase64url(payload.body.data);
    }

    if (payload.parts?.length) {
      walkParts(payload.parts, bodyResult);
    }
  }

  return {
    ...summary,
    cc: getHeaderValue(headers, "Cc") || undefined,
    bcc: getHeaderValue(headers, "Bcc") || undefined,
    bodyHtml: bodyResult.bodyHtml,
    bodyText: bodyResult.bodyText,
    hasAttachments: bodyResult.attachments.length > 0,
    attachments: bodyResult.attachments,
  };
}

// ── modifyMessage ─────────────────────────────────────────────────────────────

export async function modifyMessage(
  accountId: string,
  messageId: string,
  params: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ ok: true }> {
  await gmailFetch(accountId, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({
      addLabelIds: params.addLabelIds ?? [],
      removeLabelIds: params.removeLabelIds ?? [],
    }),
  });
  return { ok: true };
}

// ── trashMessage ──────────────────────────────────────────────────────────────

export async function trashMessage(accountId: string, messageId: string): Promise<{ ok: true }> {
  await gmailFetch(accountId, `/messages/${messageId}/trash`, { method: "POST" });
  return { ok: true };
}

// ── Thread actions ────────────────────────────────────────────────────────────

export async function modifyThread(
  accountId: string,
  threadId: string,
  params: { addLabelIds?: string[]; removeLabelIds?: string[] },
): Promise<{ ok: true }> {
  await gmailFetch(accountId, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({
      addLabelIds: params.addLabelIds ?? [],
      removeLabelIds: params.removeLabelIds ?? [],
    }),
  });
  return { ok: true };
}

export async function trashThread(accountId: string, threadId: string): Promise<{ ok: true }> {
  await gmailFetch(accountId, `/threads/${threadId}/trash`, { method: "POST" });
  return { ok: true };
}

/** Restores a trashed thread and returns fresh summaries — trashing deleted the
    local rows, so the caller re-upserts them. */
export async function untrashThread(
  accountId: string,
  threadId: string,
): Promise<GmailMessageSummary[]> {
  const res = (await gmailFetch(accountId, `/threads/${threadId}/untrash`, {
    method: "POST",
  })) as { messages?: { id: string }[] };
  const ids = (res.messages ?? []).map((m) => m.id);
  return ids.length > 0 ? fetchMetadataForIds(accountId, ids) : [];
}

/** PERMANENT bulk delete — one messages.batchDelete per 1000 ids. Gmail has
    no threads.batchDelete, so callers resolve threads to message ids first. */
export async function batchDeleteMessages(accountId: string, messageIds: string[]): Promise<void> {
  for (let i = 0; i < messageIds.length; i += 1000) {
    await gmailFetch(accountId, "/messages/batchDelete", {
      method: "POST",
      body: JSON.stringify({ ids: messageIds.slice(i, i + 1000) }),
    });
  }
}

/** PERMANENT thread delete — fallback for threads with no locally-known messages. */
export async function deleteThreadPermanently(
  accountId: string,
  threadId: string,
): Promise<{ ok: boolean }> {
  await gmailFetch(accountId, `/threads/${threadId}`, { method: "DELETE" });
  return { ok: true };
}

export async function untrashMessage(
  accountId: string,
  messageId: string,
): Promise<GmailMessageSummary[]> {
  await gmailFetch(accountId, `/messages/${messageId}/untrash`, { method: "POST" });
  return fetchMetadataForIds(accountId, [messageId]);
}

// ── Reply headers ─────────────────────────────────────────────────────────────

/** Live fetch of the RFC 2822 reply headers for a message not yet cached with them. */
export async function fetchReplyHeaders(
  accountId: string,
  messageId: string,
): Promise<{ messageIdHeader: string | null; referencesHeader: string | null }> {
  const msg = (await gmailFetch(
    accountId,
    `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
  )) as RawMessageMetadata;
  const headers = msg.payload?.headers ?? [];
  return {
    messageIdHeader: getHeaderValue(headers, "Message-ID") || null,
    referencesHeader: getHeaderValue(headers, "References") || null,
  };
}

// ── sendMessage ───────────────────────────────────────────────────────────────

function encodeBase64url(data: string): string {
  return toBase64Url(utf8Encode(data));
}

export async function sendMessage(
  accountId: string,
  params: OutgoingMail,
): Promise<{ ok: true; messageId?: string }> {
  const account = await getAccount(accountId);
  const fromAddress = account ? formatAddress(account.name, account.email) : accountId;

  const raw = buildMime({
    from: fromAddress,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.body,
    bodyHtml: params.bodyHtml,
    inReplyTo: params.inReplyTo,
    references: params.references,
    attachments: params.attachments,
  });

  const payload: { raw: string; threadId?: string } = { raw: encodeBase64url(raw) };
  if (params.threadId) payload.threadId = params.threadId;

  const sent = (await gmailFetch(accountId, "/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { id?: string };

  return { ok: true, messageId: sent.id };
}

/** Sends a ready-made RFC 822 message (calendar replies build their own MIME). */
export async function sendRawMessage(
  accountId: string,
  raw: string,
  threadId?: string,
): Promise<{ id?: string }> {
  const payload: { raw: string; threadId?: string } = { raw: encodeBase64url(raw) };
  if (threadId) payload.threadId = threadId;
  return (await gmailFetch(accountId, "/messages/send", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as { id?: string };
}

/** Creates or updates a Gmail draft with the same MIME builder as sends. */
export async function saveDraft(
  accountId: string,
  params: DraftSave,
): Promise<{ draftId: string; messageId?: string; threadId?: string }> {
  const account = await getAccount(accountId);
  const fromAddress = account ? formatAddress(account.name, account.email) : accountId;

  const raw = buildMime({
    from: fromAddress,
    to: params.to,
    cc: params.cc,
    bcc: params.bcc,
    subject: params.subject,
    body: params.body,
    bodyHtml: params.bodyHtml,
    attachments: params.attachments,
  });
  const message: { raw: string; threadId?: string } = { raw: encodeBase64url(raw) };
  if (params.threadId) message.threadId = params.threadId;

  const res = (await gmailFetch(
    accountId,
    params.draftId ? `/drafts/${params.draftId}` : "/drafts",
    {
      method: params.draftId ? "PUT" : "POST",
      body: JSON.stringify(params.draftId ? { id: params.draftId, message } : { message }),
    },
  )) as { id: string; message?: { id?: string; threadId?: string } };
  return {
    draftId: res.id,
    messageId: res.message?.id,
    threadId: res.message?.threadId,
  };
}

/**
 * The message currently backing a draft (every edit mints a new one), or null
 * when the draft no longer exists (sent or deleted elsewhere).
 */
export async function getDraftVersion(accountId: string, draftId: string): Promise<string | null> {
  try {
    const res = (await gmailFetch(accountId, `/drafts/${draftId}?format=minimal`)) as {
      message?: { id?: string };
    };
    return res.message?.id ?? null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Gmail API error: 404")) return null;
    throw err;
  }
}

/** Every draft's id with its current message (up to 500 drafts). */
export async function listDraftIds(
  accountId: string,
): Promise<{ draftId: string; messageId: string; threadId?: string }[]> {
  const out: { draftId: string; messageId: string; threadId?: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ maxResults: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const res = (await gmailFetch(accountId, `/drafts?${query.toString()}`)) as {
      drafts?: { id: string; message?: { id?: string; threadId?: string } }[];
      nextPageToken?: string;
    };
    for (const d of res.drafts ?? []) {
      if (d.message?.id)
        out.push({ draftId: d.id, messageId: d.message.id, threadId: d.message.threadId });
    }
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

/**
 * The draft id owning a message id, or null. Draft updates mint new message
 * ids, so a stale row can miss — then a draft in the same thread is the
 * best match.
 */
export async function findDraftIdByMessageId(
  accountId: string,
  messageId: string,
  threadId?: string,
): Promise<string | null> {
  const drafts = await listDraftIds(accountId);
  return (
    drafts.find((d) => d.messageId === messageId)?.draftId ??
    (threadId ? (drafts.find((d) => d.threadId === threadId)?.draftId ?? null) : null)
  );
}

export async function deleteDraft(
  accountId: string,
  draftId: string,
): Promise<{ ok: true; messageId?: string }> {
  // Learn the draft's message id first so the local row can be removed too.
  let messageId: string | undefined;
  try {
    const draft = (await gmailFetch(accountId, `/drafts/${draftId}?format=minimal`)) as {
      message?: { id?: string };
    };
    messageId = draft.message?.id;
  } catch {
    // already gone
  }
  await gmailFetch(accountId, `/drafts/${draftId}`, { method: "DELETE" });
  return { ok: true, messageId };
}

// ── Attachments ───────────────────────────────────────────────────────────────

export async function fetchAttachment(
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<Uint8Array> {
  const data = (await gmailFetch(
    accountId,
    `/messages/${messageId}/attachments/${attachmentId}`,
  )) as { data?: string; size?: number };

  if (!data.data) {
    throw new Error(`Attachment ${attachmentId} returned no data.`);
  }
  return fromBase64(data.data);
}
