/**
 * OpenClaw over its gateway's WebSocket, the way OpenClaw's own apps connect
 * (wss://<machine>.<tailnet>.ts.net with Tailscale Serve). This install is a
 * device with its own Ed25519 key: it introduces itself once, with a setup
 * code from `openclaw qr` (the gateway's address and a one-time bootstrap
 * token) or the gateway token, the user approves it on the gateway
 * (`openclaw devices approve`), and from then on it signs in with the device
 * token the gateway issued.
 *
 * Each chat is a gateway session (`agent:<agentId>:otter-mail:<uuid>`);
 * replies, tool calls and command approvals arrive as gateway events. A run
 * belongs to the gateway, not this app: it goes on when the socket drops or
 * the app quits, and is picked up again from the session's transcript.
 */

import {
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceIdentity,
} from "@openclaw/gateway-client/browser";
import { toBase64, fromBase64, utf8Encode } from "../../bytes.js";
import { logger } from "../../logger.js";
import { platform } from "../../platform.js";
import { readAttachment } from "./attachments.js";
import { chatFile, chatFilePath, downloadChatFile } from "./files.js";
import { OpenClawText, openClawMessageText as textOf } from "./openclaw-stream.js";
import {
  clearOpenClawBootstrapToken,
  clearOpenClawDeviceToken,
  getOpenClawBootstrapToken,
  getOpenClawDeviceKey,
  getOpenClawDeviceToken,
  getOpenClawToken,
  setOpenClawDeviceKey,
  setOpenClawDeviceToken,
} from "./settings.js";
import { openClawStep } from "./steps.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  ChatQuestion,
  ChatProvider,
  ChatSession,
  ChatSessionMessage,
  Emit,
  ProviderSettings,
} from "./types.js";

const CONNECT_TIMEOUT_MS = 8_000;
/**
 * What this device asks for. Answering the agent's questions came later: a
 * device paired without it signs in with the scopes it has, and asks for it
 * separately (`allowOpenClawQuestions`), as the gateway refuses a paired
 * device that just asks for more.
 */
const QUESTIONS = "operator.questions";
const SCOPES = ["operator.read", "operator.write", "operator.approvals", QUESTIONS];

/** `chris-agent-01.tail1234.ts.net`, `https://…` → `wss://…`. */
export function normalizeOpenClawUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^http/i, "ws");
  return `wss://${trimmed}`;
}

/** A setup code (`openclaw qr --setup-code-only`): base64url JSON of the address and a bootstrap token. */
export type OpenClawSetupCode = { url: string; bootstrapToken: string; expiresAtMs?: number };

export function parseOpenClawSetupCode(code: string): OpenClawSetupCode | null {
  try {
    const json = JSON.parse(atob(code.trim().replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    if (typeof json.url !== "string" || typeof json.bootstrapToken !== "string") return null;
    return {
      url: json.url,
      bootstrapToken: json.bootstrapToken,
      ...(typeof json.expiresAtMs === "number" ? { expiresAtMs: json.expiresAtMs } : {}),
    };
  } catch {
    return null;
  }
}

// ── Device identity ──────────────────────────────────────────────────────────

const base64url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let identity: Promise<GatewayBrowserDeviceIdentity> | null = null;

/** This install's Ed25519 key, made once and kept in the platform's secrets; its id is the key's SHA-256. */
function deviceIdentity(): Promise<GatewayBrowserDeviceIdentity> {
  identity ??= (async () => {
    let jwk = JSON.parse((await getOpenClawDeviceKey()) || "null") as JsonWebKey | null;
    if (!jwk) {
      const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
      await setOpenClawDeviceKey(JSON.stringify(jwk));
    }
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    const publicKey = jwk.x ?? "";
    const raw = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
    return {
      deviceId: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
      publicKey,
      sign: async (payload: string) =>
        base64url(
          new Uint8Array(
            await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(payload)),
          ),
        ),
    };
  })();
  return identity;
}

const lifecycle = new GatewayBrowserDeviceAuthLifecycle({
  loadIdentity: deviceIdentity,
  tokenStore: {
    load: async () => JSON.parse((await getOpenClawDeviceToken()) || "null"),
    store: ({ token, scopes }) => setOpenClawDeviceToken(JSON.stringify({ token, scopes })),
    clear: () => clearOpenClawDeviceToken(),
  },
});

// ── Connection ───────────────────────────────────────────────────────────────

/** The approval this device waits for on the gateway, shown in Settings. */
let pairingRequest: string | null = null;

export function openClawPairingRequest(): string | null {
  return pairingRequest;
}

type Gateway = {
  url: string;
  client: GatewayProtocolClient<GatewayBrowserDeviceAuthPlan>;
  /** What the gateway granted this device. */
  scopes: string[];
};

/** Whether the agent's questions reach this device (null until it has connected). */
let questionsAllowed: boolean | null = null;
/** The scope upgrade for questions this device waits on (`openclaw devices approve <id>`). */
let questionsRequest: string | null = null;

export function openClawQuestions(): { allowed: boolean | null; request: string | null } {
  return { allowed: questionsAllowed, request: questionsRequest };
}

let current: { url: string; ready: Promise<Gateway> } | null = null;
const listeners = new Set<(event: EventFrame) => void>();
const closeListeners = new Set<(client: Gateway["client"]) => void>();

/** The gateway's reason for refusing a connection: `PAIRING_REQUIRED`, `CONTROL_UI_ORIGIN_NOT_ALLOWED`, … */
function gatewayCode(error: unknown): string {
  return (error as { details?: { code?: string } })?.details?.code ?? "";
}

/** How this device introduces itself: the gateway token or a setup code's bootstrap token. */
type Credentials = { token: string; bootstrapToken: string };

/** Null until there's a way in: a token, a setup code, or the device token from an earlier pairing. */
async function credentials(): Promise<Credentials | null> {
  const [token, bootstrapToken, deviceToken] = await Promise.all([
    getOpenClawToken(),
    getOpenClawBootstrapToken(),
    getOpenClawDeviceToken(),
  ]);
  return token || bootstrapToken || deviceToken ? { token, bootstrapToken } : null;
}

export async function hasOpenClawCredentials(): Promise<boolean> {
  return (await credentials()) !== null;
}

function open(url: string, { token, bootstrapToken }: Credentials): Promise<Gateway> {
  return new Promise((resolve, reject) => {
    let requestId = 0;
    let settled = false;
    let scopes: string[] = [];
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        client.stop();
        reject(error);
      } else resolve({ url, client, scopes });
    };
    const timer = setTimeout(
      () => settle(new Error("The gateway didn't answer.")),
      CONNECT_TIMEOUT_MS,
    );
    const p = platform();
    const clientInfo = {
      id: "gateway-client" as const,
      mode: "ui" as const,
      displayName: `Otter Mail (${p.kind})`,
      version: p.appVersion,
      platform: p.kind,
    };
    const client: GatewayProtocolClient<GatewayBrowserDeviceAuthPlan> = new GatewayProtocolClient({
      createSocket: (on) => {
        const socket = new WebSocket(url);
        socket.addEventListener("open", () => on.open());
        socket.addEventListener("message", (event) => on.message(String(event.data)));
        socket.addEventListener("close", (event) => on.close(event.code, event.reason));
        socket.addEventListener("error", () => on.error(new Error("Can't reach the gateway.")));
        return {
          isOpen: () => socket.readyState === WebSocket.OPEN,
          send: (data) => socket.send(data),
          close: (code, reason) => socket.close(code, reason),
        };
      },
      createRequestId: () => `otter-mail-${++requestId}`,
      buildConnectPlan: async ({ nonce, challengeTs }) =>
        lifecycle.buildPlan({
          client: clientInfo,
          role: "operator",
          // The scopes this device was approved for, when it has been.
          defaultScopes: (await heldScopes()) ?? SCOPES,
          token: token || undefined,
          bootstrapToken: bootstrapToken || undefined,
          preferBootstrapToken: Boolean(bootstrapToken),
          nonce,
          challengeTs,
        }),
      buildConnectParams: (plan) => ({
        minProtocol: 4,
        maxProtocol: 4,
        client: clientInfo,
        role: plan.role,
        scopes: plan.scopes,
        caps: ["tool-events", "exec-approvals"],
        auth: plan.auth,
        device: plan.device,
      }),
      onConnectHello: (hello, context) => lifecycle.acceptHello(hello, context.plan),
      onHello: (hello) => {
        pairingRequest = null;
        scopes = hello.auth?.scopes ?? [];
        questionsAllowed = scopes.includes(QUESTIONS);
        // The device token the gateway just issued replaces the one-time setup code.
        if (bootstrapToken) void clearOpenClawBootstrapToken();
        settle(null);
      },
      onConnectFailure: (error) => {
        const details = (error as { details?: { code?: string; requestId?: string } }).details;
        if (details?.code === "PAIRING_REQUIRED") pairingRequest = details.requestId ?? null;
        settle(error);
        return { closeCode: 1000, closeReason: "connect failed", stop: true, error };
      },
      onConnectError: (error) => settle(error),
      // One socket at a time; the next use reconnects.
      resolveClose: () => ({ retry: false, notify: false }),
      onClose: () => {
        if (current?.url === url) current = null;
        settle(new Error("Can't reach the gateway."));
        for (const listener of closeListeners) listener(client);
      },
      onEvent: (event) => {
        for (const listener of listeners) listener(event);
      },
      handshake: { mode: "require-challenge", timeoutMs: CONNECT_TIMEOUT_MS },
      reconnect: { initialMs: 1_000, multiplier: 2, maxMs: 30_000 },
    });
    client.start();
  });
}

/** The connected gateway, connecting first when needed. */
async function gateway(settings: ProviderSettings): Promise<Gateway> {
  const { url } = settings.openclaw;
  const creds = await credentials();
  if (!url || !creds) throw new Error("not_configured");
  if (current?.url !== url) {
    disconnect();
    const ready = open(url, creds);
    current = { url, ready };
    ready.catch(() => {
      if (current?.ready === ready) current = null;
    });
  }
  return current.ready;
}

function disconnect(): void {
  const previous = current;
  current = null;
  void previous?.ready
    .then((g) => {
      g.client.stop();
      // A stopped client doesn't report its close; runs on it find the next one.
      for (const listener of closeListeners) listener(g.client);
    })
    .catch(() => {});
}

/** New gateway or token: forget the old connection and device token. */
export async function resetOpenClawConnection(): Promise<void> {
  disconnect();
  pairingRequest = null;
  questionsAllowed = null;
  questionsRequest = null;
  await clearOpenClawDeviceToken();
}

/** The scopes the device token from an earlier pairing carries. */
async function heldScopes(): Promise<string[] | null> {
  const stored = JSON.parse((await getOpenClawDeviceToken()) || "null") as {
    scopes?: string[];
  } | null;
  return stored?.scopes?.length ? stored.scopes : null;
}

/**
 * Asks the gateway to let this device answer the agent's questions; the user
 * approves it there (`openclaw devices approve <id>`). Approved, the gateway
 * issues a new device token, and the next connection signs in with it.
 */
export async function allowOpenClawQuestions(
  settings: ProviderSettings,
  changed: () => void,
): Promise<void> {
  const g = await gateway(settings);
  if (g.scopes.includes(QUESTIONS)) return;
  const { requestId } = await g.client.request<{ requestId: string }>(
    "device.scopes.requestUpgrade",
    { scopes: [...new Set([...g.scopes, ...SCOPES])] },
  );
  questionsRequest = requestId;
  changed();
  g.client
    .request<{ status: string; deviceToken?: string; scopes?: string[] }>(
      "device.scopes.waitUpgrade",
      { requestId },
      { timeoutMs: null },
    )
    .then(async (result) => {
      logger.info("agent", "openclaw questions upgrade", { status: result.status });
      if (result.status !== "approved" || !result.deviceToken) return;
      await setOpenClawDeviceToken(
        JSON.stringify({ token: result.deviceToken, scopes: result.scopes ?? [] }),
      );
      if (current?.url === g.url) disconnect();
    })
    .catch((error: unknown) =>
      logger.info("agent", "openclaw questions upgrade failed", { error: String(error) }),
    )
    .finally(() => {
      if (questionsRequest === requestId) questionsRequest = null;
      changed();
    });
}

type Agent = { id: string; name?: string; identity?: { name?: string } };

async function listAgents(g: Gateway): Promise<{ defaultId: string; agents: Agent[] }> {
  const result = await g.client.request<{ defaultId?: string; agents?: Agent[] }>(
    "agents.list",
    {},
  );
  return { defaultId: result.defaultId ?? "main", agents: result.agents ?? [] };
}

/** The gateway's profile for connections it can't tie to a person (every token or device-token client). */
const OWNER_PROFILE_ID = "gateway-owner";

/**
 * Who the gateway takes this device for: a person's profile, or the shared
 * owner profile. Null when the gateway can't say (an older one).
 */
async function whoAmI(g: Gateway): Promise<{ label: string } | null> {
  try {
    const { profile } = await g.client.request<{
      profile: { id: string; displayName: string | null; emails: string[] };
    }>("users.self", {});
    if (profile.id === OWNER_PROFILE_ID)
      return {
        label: profile.displayName
          ? `the shared owner (${profile.displayName})`
          : "the shared owner",
      };
    return { label: profile.displayName ?? profile.emails[0] ?? profile.id };
  } catch (error) {
    logger.info("agent", "openclaw users.self failed", { error: String(error) });
    return null;
  }
}

/** A failed connection, as the chat's error codes. */
function connectError(error: unknown): string {
  const code = gatewayCode(error);
  if (code === "PAIRING_REQUIRED") return "pairing_required";
  if (code === "CONTROL_UI_ORIGIN_NOT_ALLOWED") return "origin_not_allowed";
  const message = error instanceof Error ? error.message : String(error);
  if (message === "not_configured") return message;
  return /token|unauthori[sz]ed/i.test(message) ? "unauthorized" : "unreachable";
}

// ── Turns ────────────────────────────────────────────────────────────────────

/** How long a run may go quiet before asking the gateway whether it's still going. */
const QUIET_MS = 60_000;
/** Waits between tries to get the gateway back when the socket drops mid-run. */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * A run this app follows. It's sent with the request id as its idempotency
 * key, which the gateway keeps on the user's transcript row: a chat reopened
 * after a quit finds its run by the id it saved.
 */
type Turn = {
  requestId: string;
  sessionKey: string;
  runId: string;
  /**
   * The runs its steers started: a steer the runtime takes mid-turn joins
   * the run, one it can't runs after it, under its own id. The turn lasts
   * until they're all over.
   */
  steers: Set<string>;
  gateway: Gateway;
  emit: Emit;
  /** The run's live text, sent again to a window that comes back mid-run. */
  text: OpenClawText;
  /** Part of the run went unseen (a reconnect, a window back): its end is read from the transcript. */
  resynced: boolean;
  /** Reports the turn's last event and ends it. */
  finish: (event: ChatEvent) => void;
};

const turns = new Map<string, Turn>();
/** Approvals the user hasn't answered, by id. */
const approvals = new Map<string, { requestId: string; approval: ApprovalRequest }>();
/** Questions the user hasn't answered, by id. */
const questions = new Map<string, { requestId: string; question: ChatQuestion }>();

const DECISIONS: Record<ApprovalDecision, string> = {
  once: "allow-once",
  session: "allow-once",
  always: "allow-always",
  deny: "deny",
};

function newTurn(requestId: string, sessionKey: string, gateway: Gateway, emit: Emit): Turn {
  return {
    requestId,
    sessionKey,
    runId: requestId,
    steers: new Set(),
    gateway,
    emit,
    text: new OpenClawText(requestId, emit),
    resynced: false,
    finish: () => {},
  };
}

/** One of the turn's runs: the one its message started, or one a steer did. */
const ownsRun = (turn: Turn, runId: unknown) =>
  runId === turn.runId || (typeof runId === "string" && turn.steers.has(runId));

/** The send a user row came from: its idempotency key, less the gateway's `:user` suffix. */
function sendKeyOf(row: Record<string, unknown>): string | undefined {
  const meta = row.__openclaw as { idempotencyKey?: unknown } | undefined;
  const key = meta?.idempotencyKey ?? row.idempotencyKey;
  return typeof key === "string" ? key.replace(/:user$/, "") : undefined;
}

/** Transcript rows as the panel shows them. */
function transcript(messages: Record<string, unknown>[]): ChatSessionMessage[] {
  // A model's own wrapper around a tool (Codex's `exec`) is mirrored beside
  // the real call; the gateway marks its result as the provider's response.
  const mirrored = new Set(
    messages
      .filter((m) => {
        const meta = m.__openclaw as { toolOutput?: { source?: string } } | undefined;
        return m.role === "toolResult" && meta?.toolOutput?.source === "provider-response";
      })
      .map((m) => m.toolCallId),
  );
  return messages.flatMap((m): ChatSessionMessage[] => {
    if (m.role === "user") return [{ role: "user", text: textOf(m) }];
    if (m.role === "toolResult")
      return mirrored.has(m.toolCallId)
        ? []
        : [{ role: "tool", text: textOf(m), toolName: String(m.toolName ?? "") }];
    if (m.role !== "assistant") return [];
    const toolCalls = (Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [])
      .filter((part) => part.type === "toolCall" && !mirrored.has(part.id))
      .map((part) => openClawStep(String(part.name ?? "tool"), part.arguments));
    const text = textOf(m);
    if (!text && toolCalls.length === 0) return [];
    return [{ role: "assistant", text, ...(toolCalls.length > 0 ? { toolCalls } : {}) }];
  });
}

/** Where a run stands on the gateway: whether it got the message, what it wrote since, whether it's going. */
type RunState = { found: boolean; messages: ChatSessionMessage[]; active: boolean };

async function runState(turn: Turn): Promise<RunState> {
  const result = await turn.gateway.client.request<{
    messages?: Record<string, unknown>[];
    sessionInfo?: { hasActiveRun?: boolean; activeRunIds?: string[] };
  }>("chat.history", { sessionKey: turn.sessionKey, limit: 200 });
  const rows = result.messages ?? [];
  const start = rows.findLastIndex((m) => m.role === "user" && sendKeyOf(m) === turn.requestId);
  const info = result.sessionInfo ?? {};
  return {
    found: start >= 0,
    messages: start >= 0 ? transcript(rows.slice(start + 1)) : [],
    active: info.activeRunIds
      ? info.activeRunIds.some((id) => ownsRun(turn, id))
      : Boolean(info.hasActiveRun),
  };
}

/** A command approval, from its `exec.approval.requested` event or `exec.approval.list`. */
function askApproval(turn: Turn, payload: Record<string, unknown>): void {
  const request = (payload.request ?? {}) as Record<string, unknown>;
  if (request.sessionKey !== turn.sessionKey || typeof payload.id !== "string") return;
  const approval: ApprovalRequest = {
    id: payload.id,
    kind: "command",
    title: "Command approval",
    detail: String(request.command ?? request.commandPreview ?? "") || undefined,
    choices: ["once", "always", "deny"],
  };
  approvals.set(approval.id, { requestId: turn.requestId, approval });
  turn.emit({ requestId: turn.requestId, type: "approval", approval });
}

/** A question the run asks, from its `question.requested` event or `question.list`. */
function askQuestion(turn: Turn, record: Record<string, unknown>): void {
  if (record.sessionKey !== turn.sessionKey || typeof record.id !== "string") return;
  if ((record.runId && !ownsRun(turn, record.runId)) || record.status !== "pending") return;
  if (questions.has(record.id)) return;
  const question: ChatQuestion = {
    id: record.id,
    questions: ((record.questions ?? []) as Record<string, unknown>[]).map((q) => ({
      id: String(q.questionId),
      header: String(q.header ?? ""),
      question: String(q.question ?? ""),
      options: ((q.options ?? []) as { label: string; description?: string }[]).map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
      multiSelect: q.multiSelect === true,
      secret: q.isSecret === true,
    })),
    expiresAt: Number(record.expiresAtMs) || 0,
  };
  questions.set(question.id, { requestId: turn.requestId, question });
  turn.emit({ requestId: turn.requestId, type: "question", question });
}

/** Approvals and questions the run asked while this app wasn't listening. */
async function askPending(turn: Turn): Promise<void> {
  const [pendingApprovals, pendingQuestions] = await Promise.all([
    turn.gateway.client
      .request<Record<string, unknown>[]>("exec.approval.list", {})
      .catch(() => []),
    // Needs `operator.questions`, which a device paired before may not have yet.
    turn.gateway.client
      .request<{ questions?: Record<string, unknown>[] }>("question.list", {})
      .catch(() => ({ questions: [] })),
  ]);
  for (const payload of pendingApprovals) {
    if (!approvals.has(String(payload.id))) askApproval(turn, payload);
  }
  for (const record of pendingQuestions.questions ?? []) askQuestion(turn, record);
}

/**
 * The session's transcript rows as they're written: a run picked up on
 * another connection gets its tool calls (with their arguments) from them,
 * as only the connection that sent the message gets `tool` events.
 */
function watchTranscript(turn: Turn): void {
  void turn.gateway.client
    .request("sessions.messages.subscribe", { key: turn.sessionKey })
    .catch((error: unknown) =>
      logger.info("agent", "openclaw transcript watch failed", { error: String(error) }),
    );
}

/** The run so far, for a panel that missed some of it: the transcript, then the live text. */
function catchUp(turn: Turn, state: RunState): void {
  turn.resynced = true;
  turn.emit({ requestId: turn.requestId, type: "transcript", messages: state.messages });
  turn.text.replay();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follows a run until it ends. The gateway sends every connection its
 * sessions' events, so when the socket drops the run is picked up again on
 * the next one, and what went unseen is read from the transcript. A run
 * that goes quiet (a long command) is asked after, not given up on.
 */
async function follow(
  turn: Turn,
  settings: ProviderSettings,
  start: () => Promise<void>,
): Promise<void> {
  const { requestId, sessionKey, emit } = turn;
  let ended: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => (ended = resolve));
  // The first ending wins (a final, a cancel, the gateway gone for good).
  turn.finish = (event) => {
    if (!ended) return;
    emit(event);
    ended();
    ended = null;
  };
  turns.set(requestId, turn);

  /** The run is over: its end as the transcript has it, when some of it went unseen. */
  const settle = async (state?: RunState) => {
    if (turn.resynced) {
      try {
        state ??= await runState(turn);
        if (ended) emit({ requestId, type: "transcript", messages: state.messages });
      } catch (error) {
        logger.info("agent", "openclaw transcript unavailable", { error: String(error) });
      }
    }
    turn.finish({ requestId, type: "done", responseId: null });
  };

  let quiet: ReturnType<typeof setTimeout> | undefined;
  const hush = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => void check(), QUIET_MS);
  };
  const check = async () => {
    try {
      const state = await runState(turn);
      if (!ended) return;
      if (state.active) hush();
      else {
        turn.resynced = true;
        await settle(state);
      }
    } catch {
      hush();
    }
  };

  const reconnect = async () => {
    clearTimeout(quiet);
    for (const delay of RECONNECT_DELAYS_MS) {
      await sleep(delay);
      if (!ended) return;
      try {
        turn.gateway = await gateway(settings);
        // Live text on the new socket starts from a fresh snapshot.
        turn.text = new OpenClawText(requestId, emit);
        const state = await runState(turn);
        if (!ended) return;
        logger.info("agent", "openclaw run picked up again", { requestId, active: state.active });
        turn.resynced = true;
        if (!state.active) return await settle(state);
        catchUp(turn, state);
        watchTranscript(turn);
        await askPending(turn);
        return hush();
      } catch (error) {
        logger.info("agent", "openclaw reconnect failed", { requestId, error: String(error) });
      }
    }
    turn.finish({ requestId, type: "error", message: "detached" });
  };

  // Tool calls already shown (`<call id>:start|done`), as both `tool` events and the transcript may tell of one.
  const seen = new Set<string>();
  // The turn's runs that have ended.
  const finals = new Set<string>();
  const startStep = (id: string | undefined, name: string, args: unknown) => {
    // A catalog tool's own call (`tool_call:<call id>:ask_user:1`) repeats its `tool_call`.
    if (id?.startsWith("tool_call:")) return;
    if (id && seen.has(`${id}:start`)) return;
    if (id) seen.add(`${id}:start`);
    turn.text.boundary();
    emit({ requestId, type: "tool", id, step: openClawStep(name, args) });
  };
  const endStep = (id: string | undefined, failed: boolean) => {
    if (id?.startsWith("tool_call:")) return;
    if (id && seen.has(`${id}:done`)) return;
    if (id) seen.add(`${id}:done`);
    emit({ requestId, type: "toolResult", id, output: failed ? "(failed)" : "(done)" });
  };
  const onEvent = ({ event, payload }: EventFrame) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (event === "exec.approval.requested") return askApproval(turn, p);
    if (event === "exec.approval.resolved") {
      if (typeof p.id === "string" && approvals.delete(p.id))
        emit({ requestId, type: "approvalResolved", approvalId: p.id });
      return;
    }
    if (event === "question.requested") return askQuestion(turn, p);
    if (event === "question.resolved") {
      if (typeof p.id === "string" && questions.delete(p.id))
        emit({ requestId, type: "questionResolved", questionId: p.id });
      return;
    }
    if (p.sessionKey !== sessionKey) return;
    if (event === "session.message") {
      if (!turn.resynced) return;
      const row = (p.message ?? {}) as Record<string, unknown>;
      const meta = (row.__openclaw ?? {}) as {
        runId?: string;
        mirrorOrigin?: unknown;
        toolOutput?: { source?: string };
      };
      // Another run's rows, or a model's own wrapper mirrored beside the real call.
      if ((meta.runId && !ownsRun(turn, meta.runId)) || meta.mirrorOrigin) return;
      if (meta.toolOutput?.source === "provider-response") return;
      hush();
      if (row.role === "assistant" && Array.isArray(row.content))
        for (const part of row.content as Record<string, unknown>[]) {
          if (part.type === "toolCall")
            startStep(
              typeof part.id === "string" ? part.id : undefined,
              String(part.name ?? "tool"),
              part.arguments,
            );
        }
      if (row.role === "toolResult")
        endStep(
          typeof row.toolCallId === "string" ? row.toolCallId : undefined,
          row.isError === true,
        );
      return;
    }
    // A steer's run may end before its id is back from `chat.send`.
    if (event === "chat" && p.state === "final" && typeof p.runId === "string") finals.add(p.runId);
    if (p.runId && !ownsRun(turn, p.runId)) return;
    hush();
    if (event === "agent" && p.stream === "assistant") {
      turn.text.assistant((p.data ?? {}) as Record<string, unknown>);
      return;
    }
    // A tool's end reaches every connection as an activity item (results aren't transcript events).
    if (event === "agent" && p.stream === "item" && turn.resynced) {
      const data = (p.data ?? {}) as Record<string, unknown>;
      if (data.kind === "tool" && data.phase === "end" && typeof data.toolCallId === "string")
        endStep(data.toolCallId, data.status === "failed");
      return;
    }
    // Only the connection that sent the message gets these (a run picked up
    // on another reads its tool calls from the transcript).
    if (event === "agent" && p.stream === "tool") {
      const data = (p.data ?? {}) as Record<string, unknown>;
      const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
      if (data.phase === "start") startStep(id, String(data.name ?? "tool"), data.args);
      else if (data.phase === "result") endStep(id, data.isError === true);
      return;
    }
    if (event !== "chat") return;
    switch (p.state) {
      case "delta":
        turn.text.chat(p);
        break;
      case "final":
        turn.text.chat(p, true);
        clearTimeout(quiet);
        // Over when its runs are; a steer queued behind it may still be going.
        if ([turn.runId, ...turn.steers].every((id) => finals.has(id))) void settle();
        else void check();
        break;
      case "aborted":
        turn.finish({ requestId, type: "error", message: "cancelled" });
        break;
      case "error":
        turn.finish({
          requestId,
          type: "error",
          message: `agent_error: ${String(p.errorMessage ?? "The run failed.")}`,
        });
        break;
    }
  };
  const onClose = (client: Gateway["client"]) => {
    if (client === turn.gateway.client) void reconnect();
  };
  listeners.add(onEvent);
  closeListeners.add(onClose);
  try {
    hush();
    await start();
    await finished;
  } catch (error) {
    logger.info("agent", "openclaw turn failed", { requestId, error: String(error) });
    turn.finish({
      requestId,
      type: "error",
      message: `agent_error: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearTimeout(quiet);
    listeners.delete(onEvent);
    closeListeners.delete(onClose);
    turns.delete(requestId);
    for (const [approvalId, owner] of approvals) {
      if (owner.requestId !== requestId) continue;
      approvals.delete(approvalId);
      emit({ requestId, type: "approvalResolved", approvalId });
    }
    for (const [questionId, owner] of questions) {
      if (owner.requestId !== requestId) continue;
      questions.delete(questionId);
      emit({ requestId, type: "questionResolved", questionId });
    }
    if (turn.resynced)
      void turn.gateway.client
        .request("sessions.messages.unsubscribe", { key: sessionKey })
        .catch(() => {});
  }
}

export const openClawProvider: ChatProvider = {
  kind: "openclaw",
  displayName: "OpenClaw",

  async checkStatus(settings) {
    const base = {
      kind: "openclaw" as const,
      displayName: "OpenClaw",
      version: null,
      models: [],
      model: null,
      sessions: true,
    };
    if (!settings.openclaw.url || !(await credentials())) {
      return {
        ...base,
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
        message: "Paste a setup code to connect.",
      };
    }
    try {
      const g = await gateway(settings);
      const [{ defaultId, agents }, me] = await Promise.all([listAgents(g), whoAmI(g)]);
      return {
        ...base,
        installed: true,
        status: "ready",
        auth: { status: "authenticated", ...me },
        models: agents.map((agent) => ({
          slug: agent.id,
          name: agent.identity?.name ?? agent.name ?? agent.id,
          ...(agent.id === defaultId ? { isDefault: true } : {}),
        })),
        message: new URL(settings.openclaw.url).host,
      };
    } catch (error) {
      const code = connectError(error);
      logger.info("agent", "openclaw check failed", { code, error: String(error) });
      return {
        ...base,
        // Asking for approval or refusing the site still proves the gateway answered.
        installed: code !== "unreachable",
        status: code === "pairing_required" ? "warning" : "error",
        auth: { status: code === "unreachable" ? "unknown" : "unauthenticated" },
        message:
          code === "pairing_required"
            ? "Approve this device on the gateway."
            : code === "origin_not_allowed"
              ? "The gateway doesn't allow this site yet."
              : code === "unauthorized"
                ? "The gateway refused the setup code or token — make a new setup code."
                : "Can't reach the gateway — are you on Tailscale?",
      };
    }
  },

  async sendTurn(input, settings, emit) {
    const { requestId } = input;
    let g: Gateway;
    try {
      g = await gateway(settings);
    } catch (error) {
      return emit({ requestId, type: "error", message: connectError(error) });
    }

    let sessionKey = input.sessionId;
    if (!sessionKey) {
      const agentId = settings.openclaw.model || (await listAgents(g)).defaultId;
      sessionKey = `agent:${agentId}:otter-mail:${crypto.randomUUID()}`;
      emit({ requestId, type: "session", sessionId: sessionKey });
    }

    let attachments: unknown[];
    try {
      attachments = await Promise.all(
        (input.attachments ?? []).map(async (a) => ({
          type: a.kind,
          mimeType: a.mime,
          fileName: a.name,
          content: toBase64(await readAttachment(a)),
        })),
      );
    } catch (error) {
      return emit({
        requestId,
        type: "error",
        message: `agent_error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const turn = newTurn(requestId, sessionKey, g, emit);
    await follow(turn, settings, async () => {
      const sent = await g.client.request<{ runId?: string }>("chat.send", {
        sessionKey,
        message: input.input,
        idempotencyKey: requestId,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      turn.runId = sent.runId ?? requestId;
    });
  },

  /**
   * A run the panel lost track of (the app quit, the window closed): still
   * followed here → the panel gets the run so far; else it's found on the
   * gateway by its send, shown as far as it got, and followed if it's going.
   */
  async resume({ requestId, sessionId }, settings, emit) {
    const following = turns.get(requestId);
    if (following) {
      try {
        catchUp(following, await runState(following));
      } catch (error) {
        logger.info("agent", "openclaw transcript unavailable", { error: String(error) });
      }
      for (const { requestId: owner, approval } of approvals.values())
        if (owner === requestId) emit({ requestId, type: "approval", approval });
      for (const { requestId: owner, question } of questions.values())
        if (owner === requestId) emit({ requestId, type: "question", question });
      return;
    }
    let turn: Turn;
    let state: RunState;
    try {
      turn = newTurn(requestId, sessionId, await gateway(settings), emit);
      state = await runState(turn);
    } catch (error) {
      logger.info("agent", "openclaw resume failed", { requestId, error: String(error) });
      return emit({ requestId, type: "error", message: "detached" });
    }
    logger.info("agent", "openclaw resume", {
      requestId,
      found: state.found,
      active: state.active,
    });
    if (!state.found) return emit({ requestId, type: "error", message: "not_received" });
    catchUp(turn, state);
    if (!state.active) return emit({ requestId, type: "done", responseId: null });
    await follow(turn, settings, async () => {
      watchTranscript(turn);
      await askPending(turn);
    });
  },

  cancel(requestId) {
    const turn = turns.get(requestId);
    if (!turn) return;
    void turn.gateway.client
      // With steers, everything the chat has running.
      .request("chat.abort", {
        sessionKey: turn.sessionKey,
        ...(turn.steers.size > 0 ? {} : { runId: turn.runId }),
      })
      .catch(() => turn.finish({ requestId, type: "error", message: "cancelled" }));
  },

  /** A steer joins the running turn on the gateway. */
  async steer(requestId, input) {
    const turn = turns.get(requestId);
    if (!turn) return false;
    try {
      const sent = await turn.gateway.client.request<{ runId?: string }>("chat.send", {
        sessionKey: turn.sessionKey,
        message: input,
        idempotencyKey: crypto.randomUUID(),
        queueMode: "steer",
      });
      if (sent.runId) turn.steers.add(sent.runId);
      return true;
    } catch {
      return false;
    }
  },

  async respondApproval(requestId, approvalId, decision) {
    const turn = turns.get(requestId);
    if (!turn || approvals.get(approvalId)?.requestId !== requestId) return;
    await turn.gateway.client.request("exec.approval.resolve", {
      id: approvalId,
      decision: DECISIONS[decision],
    });
    approvals.delete(approvalId);
    turn.emit({ requestId, type: "approvalResolved", approvalId });
  },

  async answerQuestion(requestId, questionId, answers) {
    const turn = turns.get(requestId);
    if (!turn || questions.get(questionId)?.requestId !== requestId) return;
    await turn.gateway.client.request(
      "question.resolve",
      answers ? { id: questionId, answers: { answers } } : { id: questionId, cancel: true },
    );
    questions.delete(questionId);
    turn.emit({ requestId, type: "questionResolved", questionId });
  },

  async listSkills() {
    return [];
  },

  /** The gateway's conversations, newest first (not cron runs or sub-agents). */
  async listSessions(settings, limit) {
    const g = await gateway(settings);
    const result = await g.client.request<{ sessions?: Record<string, unknown>[] }>(
      "sessions.list",
      {
        limit,
        includeDerivedTitles: true,
        includeLastMessage: true,
        excludeCron: true,
        excludeSubagents: true,
        excludeSystem: true,
      },
    );
    return (result.sessions ?? []).map((s): ChatSession => ({
      id: String(s.key),
      title:
        String(s.derivedTitle ?? s.displayName ?? s.label ?? "") || (s.isMain ? "Main chat" : null),
      source: String(s.agentId ?? "openclaw"),
      lastActive: Number(s.updatedAt) || 0,
      // The list carries no count; a last message means there are messages.
      messageCount: s.lastMessagePreview ? 1 : 0,
      preview: s.lastMessagePreview ? String(s.lastMessagePreview) : null,
    }));
  },

  async readSession(settings, sessionId) {
    const g = await gateway(settings);
    const result = await g.client.request<{ messages?: Record<string, unknown>[] }>(
      "chat.history",
      { sessionKey: sessionId, limit: 500 },
    );
    return transcript(result.messages ?? []);
  },

  async readFile(settings, sessionId, href) {
    if (!sessionId) throw new Error("Open the image from its OpenClaw chat.");
    const g = await gateway(settings);
    if (href.startsWith("otter-artifact:")) {
      const result = await g.client.request<{
        artifact: { title: string; mimeType?: string };
        data?: string;
        encoding?: string;
        url?: string;
      }>("artifacts.download", {
        sessionKey: sessionId,
        artifactId: decodeURIComponent(href.slice("otter-artifact:".length)),
      });
      if (result.encoding === "base64" && result.data)
        return chatFile(result.artifact.title, fromBase64(result.data), result.artifact.mimeType);
      if (result.url) {
        const base = `${settings.openclaw.url.replace(/^ws/i, "http").replace(/\/$/, "")}/`;
        const file = await downloadChatFile(new URL(result.url.replace(/^\//, ""), base).href);
        return {
          ...file,
          name: result.artifact.title,
          mimeType: result.artifact.mimeType || file.mimeType,
        };
      }
      throw new Error("OpenClaw hasn't made this image available to download.");
    }
    const path = chatFilePath(href);
    // The file preview's text cap is small; media assets have their own larger budget.
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) {
      const ref = encodeURIComponent(path.split("/").pop() || "image");
      const result = await g.client.request<{
        assets: { content?: string; mimeType?: string; error?: string }[];
      }>("sessions.files.assets", { sessionKey: sessionId, path, refs: [ref] });
      const asset = result.assets[0];
      if (asset?.content !== undefined)
        return chatFile(
          path.split("/").pop() || "Image",
          fromBase64(asset.content),
          asset.mimeType,
        );
      throw new Error("OpenClaw couldn't read this image. Ask it to attach the image directly.");
    }
    const result = await g.client.request<{
      file?: { name?: string; content?: string; contentEncoding?: string; mimeType?: string };
      reason?: string;
    }>("sessions.files.get", { sessionKey: sessionId, path });
    if (result.file?.content === undefined)
      throw new Error("OpenClaw couldn't read this file. Ask it to attach the image directly.");
    const bytes =
      result.file.contentEncoding === "base64"
        ? fromBase64(result.file.content)
        : utf8Encode(result.file.content);
    return chatFile(
      result.file.name || path.split("/").pop() || "Image",
      bytes,
      result.file.mimeType,
    );
  },

  async deleteSession(settings, sessionId) {
    const g = await gateway(settings);
    await g.client.request("sessions.delete", { key: sessionId });
  },

  /** The runs go on on the gateway: the panel picks them up again (`resume`). */
  shutdown() {
    for (const [requestId, turn] of turns)
      turn.finish({ requestId, type: "error", message: "detached" });
    disconnect();
  },
};
