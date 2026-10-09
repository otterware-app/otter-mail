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
 * replies, tool calls and command approvals arrive as gateway events.
 */

import {
  GatewayBrowserDeviceAuthLifecycle,
  GatewayProtocolClient,
  type EventFrame,
  type GatewayBrowserDeviceAuthPlan,
  type GatewayBrowserDeviceIdentity,
} from "@openclaw/gateway-client/browser";
import { toBase64 } from "../../bytes.js";
import { logger } from "../../logger.js";
import { platform } from "../../platform.js";
import { readAttachment } from "./attachments.js";
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
  ChatEvent,
  ChatProvider,
  ChatSession,
  ChatSessionMessage,
  Emit,
  ProviderSettings,
} from "./types.js";

const CONNECT_TIMEOUT_MS = 8_000;
const IDLE_TIMEOUT_MS = 300_000;
const SCOPES = ["operator.read", "operator.write", "operator.approvals"];

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

type Gateway = { url: string; client: GatewayProtocolClient<GatewayBrowserDeviceAuthPlan> };

let current: { url: string; ready: Promise<Gateway> } | null = null;
const listeners = new Set<(event: EventFrame) => void>();
const closeListeners = new Set<() => void>();

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
    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        client.stop();
        reject(error);
      } else resolve({ url, client });
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
      buildConnectPlan: ({ nonce, challengeTs }) =>
        lifecycle.buildPlan({
          client: clientInfo,
          role: "operator",
          defaultScopes: SCOPES,
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
      onHello: () => {
        pairingRequest = null;
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
        for (const listener of closeListeners) listener();
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
  void previous?.ready.then((g) => g.client.stop()).catch(() => {});
}

/** New gateway or token: forget the old connection and device token. */
export async function resetOpenClawConnection(): Promise<void> {
  disconnect();
  pairingRequest = null;
  await clearOpenClawDeviceToken();
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

/** Text of a gateway message: a string or content parts. */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type?: string; text?: string }[])
    .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
    .join("");
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

type Turn = {
  sessionKey: string;
  runId: string | null;
  gateway: Gateway;
  emit: Emit;
  /** Reports the turn's last event and ends it. */
  finish: (event: ChatEvent) => void;
};

const turns = new Map<string, Turn>();
/** Approvals the user hasn't answered: approval id → request id. */
const approvals = new Map<string, string>();

const DECISIONS: Record<ApprovalDecision, string> = {
  once: "allow-once",
  session: "allow-once",
  always: "allow-always",
  deny: "deny",
};

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

  async sendTurn(turn, settings, emit) {
    const { requestId } = turn;
    let g: Gateway;
    try {
      g = await gateway(settings);
    } catch (error) {
      return emit({ requestId, type: "error", message: connectError(error) });
    }

    let sessionKey = turn.sessionId;
    if (!sessionKey) {
      const agentId = settings.openclaw.model || (await listAgents(g)).defaultId;
      sessionKey = `agent:${agentId}:otter-mail:${crypto.randomUUID()}`;
      emit({ requestId, type: "session", sessionId: sessionKey });
    }

    let attachments: unknown[];
    try {
      attachments = await Promise.all(
        (turn.attachments ?? []).map(async (a) => ({
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

    let ended: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => (ended = resolve));
    // The first ending wins (a final, the socket closing, a cancel).
    const finish = (event: ChatEvent) => {
      if (!ended) return;
      emit(event);
      ended();
      ended = null;
    };
    const state: Turn = { sessionKey, runId: null, gateway: g, emit, finish };
    turns.set(requestId, state);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => finish({ requestId, type: "error", message: "timeout" }),
        IDLE_TIMEOUT_MS,
      );
    };

    // The reply arrives as snapshots of the message being written; after a
    // tool call the next message starts a new paragraph.
    let text = "";
    const showText = (next: string) => {
      if (!next || next === text) return;
      emit({
        requestId,
        type: "delta",
        text: next.startsWith(text) ? next.slice(text.length) : `${text ? "\n\n" : ""}${next}`,
      });
      text = next;
    };

    const onEvent = ({ event, payload }: EventFrame) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (event === "exec.approval.requested") {
        const request = (p.request ?? {}) as Record<string, unknown>;
        if (request.sessionKey !== sessionKey || typeof p.id !== "string") return;
        approvals.set(p.id, requestId);
        emit({
          requestId,
          type: "approval",
          approval: {
            id: p.id,
            kind: "command",
            title: "Command approval",
            detail: String(request.command ?? request.commandPreview ?? "") || undefined,
            choices: ["once", "always", "deny"],
          },
        });
        return;
      }
      if (event === "exec.approval.resolved") {
        if (typeof p.id === "string" && approvals.delete(p.id))
          emit({ requestId, type: "approvalResolved", approvalId: p.id });
        return;
      }
      if (p.sessionKey !== sessionKey) return;
      resetIdle();
      if (event === "agent" && p.stream === "tool") {
        const data = (p.data ?? {}) as Record<string, unknown>;
        const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
        if (data.phase === "start")
          emit({
            requestId,
            type: "tool",
            id,
            step: openClawStep(String(data.name ?? "tool"), data.args),
          });
        else if (data.phase === "result")
          emit({ requestId, type: "toolResult", id, output: data.isError ? "(failed)" : "(done)" });
        return;
      }
      if (event !== "chat") return;
      switch (p.state) {
        case "delta":
          showText(
            p.message ? textOf(p.message) : `${p.replace ? "" : text}${String(p.deltaText ?? "")}`,
          );
          break;
        case "final":
          showText(textOf(p.message));
          finish({ requestId, type: "done", responseId: null });
          break;
        case "aborted":
          finish({ requestId, type: "error", message: "cancelled" });
          break;
        case "error":
          finish({
            requestId,
            type: "error",
            message: `agent_error: ${String(p.errorMessage ?? "The run failed.")}`,
          });
          break;
      }
    };
    const onClose = () => finish({ requestId, type: "error", message: "unreachable" });
    listeners.add(onEvent);
    closeListeners.add(onClose);
    try {
      resetIdle();
      const sent = await g.client.request<{ runId?: string }>("chat.send", {
        sessionKey,
        message: turn.input,
        idempotencyKey: crypto.randomUUID(),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      state.runId = sent.runId ?? null;
      await finished;
    } catch (error) {
      logger.info("agent", "openclaw turn failed", { requestId, error: String(error) });
      emit({
        requestId,
        type: "error",
        message: `agent_error: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      clearTimeout(idle);
      listeners.delete(onEvent);
      closeListeners.delete(onClose);
      turns.delete(requestId);
      for (const [approvalId, owner] of approvals) {
        if (owner !== requestId) continue;
        approvals.delete(approvalId);
        emit({ requestId, type: "approvalResolved", approvalId });
      }
    }
  },

  cancel(requestId) {
    const turn = turns.get(requestId);
    if (!turn) return;
    void turn.gateway.client
      .request("chat.abort", {
        sessionKey: turn.sessionKey,
        ...(turn.runId ? { runId: turn.runId } : {}),
      })
      .catch(() => turn.finish({ requestId, type: "error", message: "cancelled" }));
  },

  /** A steer joins the running turn on the gateway. */
  async steer(requestId, input) {
    const turn = turns.get(requestId);
    if (!turn) return false;
    try {
      await turn.gateway.client.request("chat.send", {
        sessionKey: turn.sessionKey,
        message: input,
        idempotencyKey: crypto.randomUUID(),
        queueMode: "steer",
      });
      return true;
    } catch {
      return false;
    }
  },

  async respondApproval(requestId, approvalId, decision) {
    const turn = turns.get(requestId);
    if (!turn || approvals.get(approvalId) !== requestId) return;
    await turn.gateway.client.request("exec.approval.resolve", {
      id: approvalId,
      decision: DECISIONS[decision],
    });
    approvals.delete(approvalId);
    turn.emit({ requestId, type: "approvalResolved", approvalId });
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
    const messages = result.messages ?? [];
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
  },

  async deleteSession(settings, sessionId) {
    const g = await gateway(settings);
    await g.client.request("sessions.delete", { key: sessionId });
  },

  shutdown() {
    for (const [requestId, turn] of turns)
      turn.finish({ requestId, type: "error", message: "cancelled" });
    disconnect();
  },
};
