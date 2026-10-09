/**
 * Microsoft Graph, for one Outlook mailbox at a time.
 *
 * Every request asks for immutable ids (`Prefer: IdType="ImmutableId"`), so a
 * message keeps its id when it moves between folders, as a Gmail message does
 * when its labels change.
 *
 * Graph limits each app to 4 requests in flight per mailbox (and 10,000 per
 * 10 minutes), answering 429 with Retry-After past them. Requests take turns
 * per mailbox like IMAP's commands do: what the user just did first, then
 * sync, backfill and offline downloads. Background work waits out a 429; the
 * user's own requests retry a few times, then fail.
 */

import { OUTLOOK_SIGNED_OUT_MESSAGE } from "../../microsoft.js";
import { platform, type AsyncContext } from "../../platform.js";
import type { ErrorKind, Lane } from "../provider.js";

export const GRAPH = "https://graph.microsoft.com/v1.0";

const MAX_IN_FLIGHT = 4;
const REQUEST_TIMEOUT_MS = 90_000;
const FOREGROUND_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
const BACKGROUND_MAX_RETRIES = 6;
/** Network drops and Graph's 5xx, retried by background work. */
const BACKGROUND_TRANSIENT_RETRIES = 3;
/** After a 429, background work stands down at least this long. */
const COOLDOWN_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failed Graph call: its status and Graph's own error code and words. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(
      `Microsoft Graph error: ${status}${code ? ` ${code}` : ""}${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "GraphError";
  }

  get throttled(): boolean {
    return this.status === 429;
  }
}

/** Graph's `{ error: { code, message } }`, if that's what the body is. */
function parseError(body: string): { code: string; message: string } {
  try {
    const error = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error;
    return { code: error?.code ?? "", message: error?.message?.trim() ?? "" };
  } catch {
    return { code: "", message: body.trim().slice(0, 200) };
  }
}

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof GraphError) return false;
  return (
    err.name === "TimeoutError" ||
    err.name === "AbortError" ||
    /fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(
      `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`,
    )
  );
}

export const isNotFound = (err: unknown): boolean =>
  err instanceof GraphError && (err.status === 404 || err.code === "ErrorItemNotFound");

export function errorKind(err: unknown): ErrorKind | null {
  if (err instanceof GraphError && (err.throttled || err.status === 503)) return "rateLimit";
  if (isNetworkError(err)) return "network";
  if (isNotFound(err)) return "notFound";
  return null;
}

export function describeError(err: unknown): string {
  if (err instanceof GraphError) {
    if (err.throttled) return "Outlook is limiting requests right now — retrying shortly";
    if (err.status === 401) return OUTLOOK_SIGNED_OUT_MESSAGE;
    if (err.status === 403) {
      return "Outlook refused access to this mailbox — sign in to it again to allow Otter Mail";
    }
    if (err.status >= 500) return "Outlook is having trouble right now — retrying shortly";
    return err.message.replace(/^Microsoft Graph error: /, "Outlook error ").slice(0, 240);
  }
  if (isNetworkError(err)) return "Can't reach Outlook — retrying when the connection is back";
  const text = String(err);
  if (text.includes(OUTLOOK_SIGNED_OUT_MESSAGE)) return OUTLOOK_SIGNED_OUT_MESSAGE;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

// ── Turns ───────────────────────────────────────────────────────────────────

let tierContext: AsyncContext<Lane> | null = null;
/** Which lane the running work belongs to; none is the user's own request. */
export const tier = (): AsyncContext<Lane> => (tierContext ??= platform().asyncContext<Lane>());
const RANK = { user: 0, sync: 1, backfill: 2, prefetch: 3 } as const;

type Slots = { inFlight: number; waiting: { rank: number; start: () => void }[] };
const slots = new Map<string, Slots>();
const cooldownUntil = new Map<string, number>();

/** Background work is standing down after a 429 (offline downloads check this). */
export const isCoolingDown = (accountId: string): boolean =>
  Date.now() < (cooldownUntil.get(accountId) ?? 0);

async function takeSlot(accountId: string): Promise<() => void> {
  let s = slots.get(accountId);
  if (!s) slots.set(accountId, (s = { inFlight: 0, waiting: [] }));
  const lane = tier().get();
  const rank = lane ? RANK[lane] : RANK.user;
  if (lane && isCoolingDown(accountId)) {
    await sleep((cooldownUntil.get(accountId) ?? 0) - Date.now());
  }
  if (s.inFlight >= MAX_IN_FLIGHT || s.waiting.length > 0) {
    await new Promise<void>((resolve) => {
      const at = s.waiting.findIndex((w) => w.rank > rank);
      const entry = { rank, start: resolve };
      if (at < 0) s.waiting.push(entry);
      else s.waiting.splice(at, 0, entry);
    });
  }
  s.inFlight++;
  return () => {
    s.inFlight--;
    s.waiting.shift()?.start();
  };
}

/** Drops a removed account's turns and cooldown. */
export function forgetGraph(accountId: string): void {
  slots.delete(accountId);
  cooldownUntil.delete(accountId);
}

// ── Requests ────────────────────────────────────────────────────────────────

export type GraphInit = {
  method?: string;
  /** JSON (an object), or text sent as is (a base64 MIME message: `contentType` text/plain). */
  body?: unknown;
  contentType?: string;
  /** More `Prefer` preferences (odata.maxpagesize=…, outlook.body-content-type=…). */
  prefer?: string[];
  headers?: Record<string, string>;
};

const IMMUTABLE_IDS = 'IdType="ImmutableId"';

export const preferHeader = (prefer: string[] = []) => [IMMUTABLE_IDS, ...prefer].join(", ");

/** A Graph request's response, after retries; throws GraphError when it failed. */
async function request(
  accountId: string,
  path: string,
  init: GraphInit = {},
  retry = 0,
  attempt: { tokenRefreshed?: boolean; transient?: number } = {},
): Promise<Response> {
  const background = tier().get() !== undefined;
  const release = await takeSlot(accountId);
  let response: Response;
  try {
    const auth = platform().microsoft;
    if (!auth) throw new Error("This app can't sign in to Outlook.");
    const token = await auth.getAccessToken(accountId);
    const body =
      init.body === undefined
        ? undefined
        : typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);
    response = await fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
      method: init.method ?? "GET",
      body,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        Prefer: preferHeader(init.prefer),
        ...(body !== undefined ? { "Content-Type": init.contentType ?? "application/json" } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    release();
    const tries = attempt.transient ?? 0;
    if (background && tries < BACKGROUND_TRANSIENT_RETRIES && isNetworkError(err)) {
      await sleep(2000 * 2 ** tries);
      return request(accountId, path, init, retry, { ...attempt, transient: tries + 1 });
    }
    throw err;
  }
  release();
  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  // The cached access token was revoked or expired early: refresh it once.
  if (response.status === 401 && !attempt.tokenRefreshed) {
    await platform().microsoft?.getAccessToken(accountId, { forceRefresh: true });
    return request(accountId, path, init, retry, { ...attempt, tokenRefreshed: true });
  }
  const { code, message } = parseError(text);
  if (response.status === 429 || response.status === 503) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "", 10) * 1000;
    const wait = retryAfter > 0 ? retryAfter : Math.min(1000 * 2 ** retry, 32_000);
    if (response.status === 429) {
      cooldownUntil.set(accountId, Date.now() + Math.max(wait, COOLDOWN_MS));
    }
    const delay = background ? wait : FOREGROUND_RETRY_DELAYS_MS[retry];
    if (delay !== undefined && (!background || retry < BACKGROUND_MAX_RETRIES)) {
      await sleep(background ? delay : Math.max(delay, Math.min(retryAfter, 10_000)));
      return request(accountId, path, init, retry + 1, attempt);
    }
  }
  const tries = attempt.transient ?? 0;
  if (background && response.status >= 500 && tries < BACKGROUND_TRANSIENT_RETRIES) {
    await sleep(1000 * 2 ** tries);
    return request(accountId, path, init, retry, { ...attempt, transient: tries + 1 });
  }
  throw new GraphError(response.status, code, message);
}

/** A Graph call answering JSON (`{}` for an empty 202/204). */
export async function graph<T = unknown>(
  accountId: string,
  path: string,
  init?: GraphInit,
): Promise<T> {
  const text = await (await request(accountId, path, init)).text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** A Graph call answering bytes (a message's MIME source, a photo). */
export async function graphBytes(accountId: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await request(accountId, path)).arrayBuffer());
}

/** One page of a collection: its items and the link to the next. */
export type Page<T> = {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/** Every item of a collection, following `@odata.nextLink`. */
export async function graphAll<T>(accountId: string, path: string, init?: GraphInit) {
  const items: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: Page<T> = await graph<Page<T>>(accountId, next, init);
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"];
  }
  return items;
}

// ── Batches ─────────────────────────────────────────────────────────────────

export type BatchRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Relative to the API root: `/me/messages/…`. */
  url: string;
  body?: unknown;
};

export type BatchResponse = { status: number; body: unknown };

/** Graph takes 20 requests per $batch. */
const BATCH_SIZE = 20;

/**
 * Runs requests in `$batch`es of 20, in order, answering each one's status
 * and body. Throttled ones are retried after Graph's Retry-After; other
 * failures are answered as they are, for the caller to judge.
 */
export async function graphBatch(
  accountId: string,
  requests: BatchRequest[],
): Promise<BatchResponse[]> {
  const results: BatchResponse[] = Array.from({ length: requests.length });
  for (let start = 0; start < requests.length; start += BATCH_SIZE) {
    let pending = requests
      .slice(start, start + BATCH_SIZE)
      .map((request, i) => ({ index: start + i, request }));
    for (let round = 0; pending.length > 0; round++) {
      const answer = await graph<{
        responses?: {
          id: string;
          status: number;
          headers?: Record<string, string>;
          body?: unknown;
        }[];
      }>(accountId, "/$batch", {
        method: "POST",
        body: {
          requests: pending.map(({ index, request }) => ({
            id: String(index),
            method: request.method,
            url: request.url,
            headers: {
              Prefer: preferHeader(),
              ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            ...(request.body !== undefined ? { body: request.body } : {}),
          })),
        },
      });
      let retryAfter = 0;
      const throttled = new Set<number>();
      for (const response of answer.responses ?? []) {
        const index = Number(response.id);
        if (response.status === 429 && round < BACKGROUND_MAX_RETRIES) {
          throttled.add(index);
          retryAfter = Math.max(retryAfter, Number(response.headers?.["Retry-After"] ?? 2) * 1000);
        } else {
          results[index] = { status: response.status, body: response.body ?? null };
        }
      }
      pending = pending.filter(({ index }) => throttled.has(index));
      if (pending.length > 0) {
        cooldownUntil.set(accountId, Date.now() + Math.max(retryAfter, COOLDOWN_MS));
        await sleep(retryAfter);
      }
    }
  }
  return results;
}

/** A failed batch answer as the GraphError a single request would have thrown. */
export function batchError(response: BatchResponse): GraphError {
  const error = (response.body as { error?: { code?: string; message?: string } } | null)?.error;
  return new GraphError(response.status, error?.code ?? "", error?.message ?? "");
}

export const ok = (response: BatchResponse | undefined): boolean =>
  !!response && response.status >= 200 && response.status < 300;
