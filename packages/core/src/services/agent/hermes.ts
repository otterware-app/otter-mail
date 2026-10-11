/**
 * Hermes over its built-in API server (https://<host>:8642, Bearer
 * API_SERVER_KEY). Requests stream SSE. Two transports, one event contract:
 *  - Native Sessions API (preferred): /api/sessions/{id}/chat/stream. Each
 *    conversation maps to a persistent server-side session; history lives on
 *    the server and survives app + gateway restarts.
 *  - Responses API (legacy chats): /v1/responses with previous_response_id,
 *    kept so conversations started before the migration keep their thread.
 */

import { utf8Decode } from "../../bytes.js";
import { logger } from "../../logger.js";
import { dataUrl, readAttachment } from "./attachments.js";
import { TextStream } from "./text-stream.js";
import { getHermesKey } from "./settings.js";
import { hermesStep, TOOL_OUTPUT_CHARS } from "./steps.js";
import type {
  ApprovalDecision,
  ChatAttachment,
  ChatProvider,
  ChatSession,
  ChatSessionMessage,
  Emit,
  ProviderModel,
  ProviderModelOption,
  ProviderSettings,
  Skill,
} from "./types.js";

const IDLE_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 4_000;

/** `https://host:8642/v1` → OpenAI-compatible base; the Sessions API hangs off the root. */
export function normalizeHermesBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/i, "");
}

function authHeaders(key: string, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

type Ready = { baseUrl: string; root: string; key: string; agentModel: string };

async function requireReady(settings: ProviderSettings): Promise<Ready> {
  const key = await getHermesKey();
  const { baseUrl, agentModel } = settings.hermes;
  if (!baseUrl || !key) throw new Error("not_configured");
  return { baseUrl, root: apiRoot(baseUrl), key, agentModel };
}

// ---------------------------------------------------------------------------
// Attachments (api_server accepts text + image parts only)
// ---------------------------------------------------------------------------

/** Whole request cap is 10 MB; base64 grows images by a third. */
const HERMES_IMAGE_BUDGET = 7 * 1024 * 1024;
/** Text parts together are capped at 64 KB server-side. */
const HERMES_TEXT_BUDGET = 60 * 1024;
const TEXT_TYPES = /^(text\/|application\/(json|xml)|message\/rfc822)/;

async function hermesContent(input: string, attachments: ChatAttachment[]): Promise<unknown[]> {
  const unsupported = attachments.filter((a) => a.kind === "file" && !TEXT_TYPES.test(a.mime));
  if (unsupported.length > 0) {
    throw new Error(
      `Hermes can't read ${unsupported.map((a) => a.name).join(", ")} — its API takes images and text files only. Try Codex or Claude for PDFs and Office documents.`,
    );
  }
  const images = attachments.filter((a) => a.kind === "image");
  const imageBytes = images.reduce((sum, a) => sum + a.size, 0);
  if (imageBytes > HERMES_IMAGE_BUDGET) {
    throw new Error("Those images are too large for Hermes together (7 MB max per message).");
  }
  let text = input;
  for (const doc of attachments.filter((a) => a.kind === "file")) {
    const body = utf8Decode(await readAttachment(doc));
    text += `\n\n--- ${doc.name} ---\n${body}`;
  }
  if (new TextEncoder().encode(text).byteLength > HERMES_TEXT_BUDGET) {
    throw new Error("The attached text is too long for Hermes (about 60 KB per message).");
  }
  return [
    { type: "text", text: text || "See the attached image." },
    ...(await Promise.all(
      images.map(async (image) => ({
        type: "image_url",
        image_url: { url: await dataUrl(image) },
      })),
    )),
  ];
}

// ---------------------------------------------------------------------------
// Model catalog + per-turn model options
// ---------------------------------------------------------------------------

/** Efforts the gateway accepts in model_options.reasoning.effort. */
const REASONING_EFFORTS: [string, string][] = [
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra High"],
];

type RawModelOptions = {
  model?: string;
  provider?: string;
  providers?: {
    slug?: string;
    name?: string;
    is_current?: boolean;
    authenticated?: boolean;
    models?: (string | { id?: string; slug?: string; name?: string })[];
    capabilities?: Record<
      string,
      { fast?: boolean; reasoning?: boolean; can_disable_reasoning?: boolean }
    >;
  }[];
  capabilities?: Record<
    string,
    { fast?: boolean; reasoning?: boolean; can_disable_reasoning?: boolean }
  >;
};

type Capabilities = {
  fast?: boolean;
  reasoning?: boolean;
  can_disable_reasoning?: boolean;
};

/** Reasoning / Service Tier for one model, from the gateway's capability flags. */
function hermesModelOptions(caps: Capabilities | undefined): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  if (caps?.reasoning) {
    options.push({
      id: "reasoningEffort",
      label: "Reasoning",
      choices: [
        { id: "", label: "Default", description: "Hermes' configured effort" },
        ...(caps.can_disable_reasoning ? [{ id: "none", label: "Off" }] : []),
        ...REASONING_EFFORTS.map(([id, label]) => ({ id, label })),
      ].map((c, i) => (i === 0 ? { ...c, isDefault: true } : c)),
    });
  }
  if (caps?.fast) {
    options.push({
      id: "serviceTier",
      label: "Service Tier",
      choices: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "Priority processing, increased usage",
        },
      ],
    });
  }
  return options;
}

/**
 * GET /api/model/options — the providers and models Hermes is configured for
 * (the dashboard's model picker). Slugs are `provider::model`; the gateway's
 * current default is marked. Older gateways without the endpoint → [].
 */
async function fetchHermesCatalog(baseUrl: string, key: string): Promise<ProviderModel[]> {
  try {
    const response = await fetch(`${apiRoot(baseUrl)}/api/model/options`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = (await response.json()) as RawModelOptions;
    const models: ProviderModel[] = [];
    for (const provider of body.providers ?? []) {
      if (!provider.slug || provider.authenticated === false) continue;
      for (const raw of provider.models ?? []) {
        const id = typeof raw === "string" ? raw : (raw.id ?? raw.slug ?? "");
        if (!id) continue;
        const caps = provider.capabilities?.[id] ?? body.capabilities?.[id];
        models.push({
          slug: `${provider.slug}::${id}`,
          // A provider's generic "default" model reads better as the provider itself.
          name:
            id === "default"
              ? (provider.name ?? provider.slug)
              : typeof raw === "string"
                ? raw
                : (raw.name ?? id),
          subProvider: provider.name ?? provider.slug,
          ...(provider.slug === body.provider && id === body.model ? { isDefault: true } : {}),
          options: hermesModelOptions(caps),
        });
      }
    }
    return models;
  } catch (error) {
    logger.info("agent", "hermes model options failed", {
      error: String(error),
    });
    return [];
  }
}

/** `model` / `provider` / `model_options` for a turn, per the api_server contract. */
function turnModelFields(settings: ProviderSettings): Record<string, unknown> {
  const { model, reasoningEffort, serviceTier } = settings.hermes;
  const [provider, modelId] = model.includes("::") ? model.split("::", 2) : ["", ""];
  const modelOptions: Record<string, unknown> = {};
  if (reasoningEffort === "none") modelOptions.reasoning = { enabled: false };
  else if (reasoningEffort) modelOptions.reasoning = { effort: reasoningEffort };
  if (serviceTier && serviceTier !== "default") modelOptions.service_tier = serviceTier;
  return {
    ...(modelId ? { model: modelId, provider } : {}),
    ...(Object.keys(modelOptions).length > 0 ? { model_options: modelOptions } : {}),
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** GET /api/sessions?limit=1 — 200 means the native Sessions API is served. */
export async function probeHermesSessions(baseUrl: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiRoot(baseUrl)}/api/sessions?limit=1`, {
      headers: authHeaders(key),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** GET /v1/models: authenticates the key and names the agent's model. */
export async function fetchHermesModels(baseUrl: string, key: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: authHeaders(key),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (response.status === 401) throw new Error("The API key was rejected (401).");
  if (!response.ok)
    throw new Error(`The server answered ${response.status} — is that the API server URL?`);
  const data = (await response.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Sessions API payloads
// ---------------------------------------------------------------------------

type RawSession = {
  id?: string;
  title?: string | null;
  source?: string;
  last_active?: number | string | null;
  started_at?: number | string | null;
  message_count?: number | null;
  preview?: string | null;
};

function toMillis(value: number | string | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Date.parse(value) || Number(value);
  if (!Number.isFinite(n)) return 0;
  // The gateway stores epoch seconds (float); ISO strings already parse to ms.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function toSession(raw: RawSession): ChatSession {
  return {
    id: String(raw.id ?? ""),
    title: raw.title ? String(raw.title) : null,
    source: String(raw.source ?? "api_server"),
    lastActive: toMillis(raw.last_active) || toMillis(raw.started_at),
    messageCount: Number(raw.message_count ?? 0) || 0,
    preview: raw.preview ? String(raw.preview) : null,
  };
}

type RawMessage = {
  role?: string;
  content?: unknown;
  tool_name?: string | null;
  tool_calls?:
    | { function?: { name?: string; arguments?: string }; name?: string; arguments?: string }[]
    | null;
};

/** Text of a stored message: plain string or multimodal parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { type?: string; text?: string };
        return p.type === "text" || p.type === "output_text" || p.type === "input_text"
          ? (p.text ?? "")
          : "";
      })
      .join("");
  }
  if (content && typeof content === "object") return (content as { text?: string }).text ?? "";
  return "";
}

/** POST /api/sessions — an empty session the turn then streams into. */
async function createSession(ready: Ready, title: string | undefined): Promise<string> {
  const attempt = (t: string | undefined) =>
    fetch(`${ready.root}/api/sessions`, {
      method: "POST",
      headers: authHeaders(ready.key, true),
      body: JSON.stringify({
        source: "api_server",
        ...(t ? { title: t } : {}),
      }),
    });
  let response = await attempt(title);
  // Titles are unique server-side; a clash must not block a new chat.
  if (response.status === 400 && title) response = await attempt(undefined);
  if (!response.ok) throw new Error(await readError(response));
  const body = (await response.json()) as { session?: RawSession };
  const id = toSession(body.session ?? {}).id;
  if (!id) throw new Error("The server returned no session id.");
  return id;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/**
 * Pulls SSE frames off a body: `event:` (optional) + `data:` lines, blank-line
 * separated; comment lines (`: keepalive`) only reset the idle timer.
 */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string | null, data: string) => void,
  onActivity: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity();
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length > 0) onFrame(event, data.join("\n"));
    }
  }
}

function parseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

type TurnContext = {
  requestId: string;
  input: string;
  /** What the session chat sends: the text, or content parts with attachments. */
  message: string | unknown[];
  /** model / provider / model_options for this turn. */
  modelFields: Record<string, unknown>;
  ready: Ready;
  signal: AbortSignal;
  resetIdle: () => void;
  emit: Emit;
};

/**
 * Native session turn. Event names/payloads per gateway/platforms/api_server.py:
 * assistant.delta{delta}, assistant.commentary{text,already_streamed},
 * tool.started|completed|failed{tool_name|tool,preview}, run.completed|failed|cancelled,
 * error{message}, done. Closing the connection interrupts the run server-side.
 */
async function streamSessionTurn(ctx: TurnContext & { sessionId: string }): Promise<void> {
  const { requestId, sessionId, ready, signal, resetIdle, emit } = ctx;
  const response = await fetch(
    `${ready.root}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
    {
      method: "POST",
      headers: { ...authHeaders(ready.key, true), Accept: "text/event-stream" },
      body: JSON.stringify({ message: ctx.message, ...ctx.modelFields }),
      signal,
    },
  );
  if (response.status === 401) return emit({ requestId, type: "error", message: "unauthorized" });
  // The session was deleted (e.g. from another client); the panel starts a new one.
  if (response.status === 404)
    return emit({ requestId, type: "error", message: "session_not_found" });
  if (!response.ok || !response.body) {
    logger.info("agent", "hermes turn rejected", {
      requestId,
      status: response.status,
      message: await readError(response),
    });
    return emit({
      requestId,
      type: "error",
      message: `http_${response.status}`,
    });
  }

  let terminal: "completed" | "failed" | "cancelled" | null = null;
  const textStream = new TextStream(requestId, emit);

  await readSse(
    response.body,
    (name, json) => {
      const payload = parseJson(json);
      if (!payload) return;
      const event = name ?? String(payload.type ?? payload.event ?? "");
      // Every event names its run: steer / stop / approvals address it.
      if (payload.run_id) runs.set(requestId, { runId: String(payload.run_id), ready });
      switch (event) {
        case "assistant.delta": {
          const text = String(payload.delta ?? payload.text ?? "");
          textStream.append(text);
          break;
        }
        case "assistant.commentary": {
          // Mid-turn commentary beside tool calls; skip when it already streamed as deltas.
          if (payload.already_streamed) {
            textStream.start();
            break;
          }
          const text = String(payload.text ?? "").trim();
          textStream.snapshot(text);
          textStream.start();
          break;
        }
        case "assistant.completed": {
          // Also carries resolved MEDIA images that aren't present in raw deltas.
          textStream.snapshot(contentText(payload.content));
          break;
        }
        case "tool.started":
          textStream.start();
          emit({
            requestId,
            type: "tool",
            step: hermesStep(String(payload.tool_name ?? payload.tool ?? "tool"), payload.preview),
          });
          break;
        case "tool.completed":
        case "tool.failed": {
          const preview = String(payload.preview ?? "").slice(0, TOOL_OUTPUT_CHARS);
          emit({
            requestId,
            type: "toolResult",
            output: preview || (event === "tool.failed" ? "(failed)" : "(done)"),
          });
          break;
        }
        case "approval.request": {
          // A dangerous command waits for the user (the gateway's approvals.mode);
          // answered via POST /v1/runs/{run_id}/approval.
          const approvalId = String(payload.request_id ?? "");
          const runId = String(payload.run_id ?? "");
          if (!approvalId || !runId) break;
          const allowed: ApprovalDecision[] = ["once", "session", "always", "deny"];
          const choices = Array.isArray(payload.choices)
            ? (payload.choices as string[]).filter((c): c is ApprovalDecision =>
                allowed.includes(c as ApprovalDecision),
              )
            : allowed;
          pendingApprovals.set(approvalId, { requestId, runId, ready, emit });
          emit({
            requestId,
            type: "approval",
            approval: {
              id: approvalId,
              kind: "command",
              title: "Command approval",
              detail: payload.command ? String(payload.command) : undefined,
              reason: payload.description ? String(payload.description) : undefined,
              choices,
            },
          });
          break;
        }
        case "run.completed":
          terminal = "completed";
          // A steer that arrived after the final answer comes back unapplied.
          if (typeof payload.pending_steer === "string" && payload.pending_steer.trim())
            emit({
              requestId,
              type: "steerReturned",
              text: payload.pending_steer,
            });
          break;
        case "run.failed": {
          terminal = "failed";
          const reason = payload.turn_exit_reason ? String(payload.turn_exit_reason) : "";
          emit({
            requestId,
            type: "error",
            message: reason ? `agent_error: ${reason}` : "agent_error",
          });
          break;
        }
        case "run.cancelled":
          terminal = "cancelled";
          emit({ requestId, type: "error", message: "cancelled" });
          break;
        case "error": {
          terminal = "failed";
          const message = String(payload.message ?? "");
          emit({
            requestId,
            type: "error",
            message: message ? `agent_error: ${message}` : "agent_error",
          });
          break;
        }
        default:
          // run.started, message.started, tool.progress (reasoning), done — nothing to relay.
          break;
      }
    },
    resetIdle,
  );

  if (terminal === "completed") emit({ requestId, type: "done", responseId: null });
  // Stream closed without a terminal event: the gateway dropped the connection.
  else if (terminal === null) emit({ requestId, type: "error", message: "unreachable" });
}

/** Legacy Responses-API turn (previous_response_id chaining) for pre-migration chats. */
async function streamResponsesTurn(
  ctx: TurnContext & { previousResponseId?: string },
): Promise<void> {
  const { requestId, input, previousResponseId, ready, signal, resetIdle, emit } = ctx;
  const response = await fetch(`${ready.baseUrl}/responses`, {
    method: "POST",
    headers: authHeaders(ready.key, true),
    body: JSON.stringify({
      model: ready.agentModel,
      ...ctx.modelFields,
      input,
      stream: true,
      store: true,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }),
    signal,
  });
  if (response.status === 401) return emit({ requestId, type: "error", message: "unauthorized" });
  if (!response.ok || !response.body)
    return emit({
      requestId,
      type: "error",
      message: `http_${response.status}`,
    });

  let responseId: string | null = null;
  const textStream = new TextStream(requestId, emit);
  await readSse(
    response.body,
    (_name, json) => {
      if (json === "[DONE]") return;
      const event = parseJson(json);
      if (!event) return;
      // Tool results ride on output_item.added (not .done) and their `output`
      // is an array of {type, text} parts, not a plain string.
      const type = String(event.type ?? "");
      if (type === "response.created" || type === "response.completed") {
        const resp = event.response as { id?: string } | undefined;
        if (resp?.id) responseId = resp.id;
      } else if (type === "response.output_text.delta") {
        textStream.append(String(event.delta ?? ""));
      } else if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = event.item as
          | {
              type?: string;
              id?: string;
              content?: unknown;
              name?: string;
              arguments?: string;
              output?: { text?: string }[] | string;
            }
          | undefined;
        if (item?.type === "message") {
          if (type === "response.output_item.added") textStream.start(item.id);
          textStream.snapshot(contentText(item.content));
        } else if (type === "response.output_item.added" && item?.type === "function_call") {
          emit({ requestId, type: "tool", step: hermesStep(item.name ?? "tool", item.arguments) });
        } else if (type === "response.output_item.added" && item?.type === "function_call_output") {
          const text = (
            typeof item.output === "string"
              ? item.output
              : (item.output ?? []).map((part) => part?.text ?? "").join("")
          ).slice(0, TOOL_OUTPUT_CHARS);
          emit({ requestId, type: "toolResult", output: text });
        }
      } else if (type === "response.failed") {
        const resp = event.response as { error?: { message?: string } } | undefined;
        emit({
          requestId,
          type: "error",
          message: resp?.error?.message ? `agent_error: ${resp.error.message}` : "agent_error",
        });
      }
    },
    resetIdle,
  );
  emit({ requestId, type: "done", responseId });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let skillsCache: { at: number; baseUrl: string; data: Skill[] } | null = null;
const active = new Map<string, AbortController>();

/** The gateway run behind each streaming turn, for steer / stop. */
const runs = new Map<string, { runId: string; ready: Ready }>();

/** Approvals the user hasn't answered, by approval (request) id. */
const pendingApprovals = new Map<
  string,
  { requestId: string; runId: string; ready: Ready; emit: Emit }
>();

/** Clears a finished turn's unanswered approvals (the gateway denies them itself). */
function dropApprovals(requestId: string): void {
  for (const [approvalId, pending] of pendingApprovals) {
    if (pending.requestId !== requestId) continue;
    pendingApprovals.delete(approvalId);
    pending.emit({ requestId, type: "approvalResolved", approvalId });
  }
}

export const hermesProvider: ChatProvider = {
  kind: "hermes",
  displayName: "Hermes",

  async checkStatus(settings) {
    const base = {
      kind: "hermes" as const,
      displayName: "Hermes",
      version: null,
      models: [],
      model: null,
      sessions: false,
    };
    const key = await getHermesKey();
    if (!settings.hermes.baseUrl || !key) {
      return {
        ...base,
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
        message: "Add the API server URL and key to connect.",
      };
    }
    try {
      const [agentModels, sessions, catalog] = await Promise.all([
        fetchHermesModels(settings.hermes.baseUrl, key),
        probeHermesSessions(settings.hermes.baseUrl, key),
        fetchHermesCatalog(settings.hermes.baseUrl, key),
      ]);
      // Without a catalog, the agent's virtual model is the only choice.
      const models: ProviderModel[] =
        catalog.length > 0
          ? catalog
          : agentModels.map((slug) => ({
              slug: "",
              name: slug,
              isDefault: true,
            }));
      return {
        ...base,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models,
        sessions,
        message: `${new URL(settings.hermes.baseUrl).host} · ${
          sessions ? "chats persist on Hermes" : "no Sessions API, chats chain by response id"
        }`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejected = message.includes("401");
      return {
        ...base,
        // A rejected key still proves the server answered.
        installed: rejected,
        status: "error",
        auth: { status: rejected ? "unauthenticated" : "unknown" },
        message: rejected ? message : `Can't reach Hermes — are you on Tailscale? (${message})`,
      };
    }
  },

  /**
   * One turn. With a session it streams the native session transcript;
   * otherwise it chains the Responses API. Agent runs can take minutes when
   * tools are involved — the timeout is on stream inactivity, not duration.
   */
  async sendTurn(turn, settings, emit) {
    const { requestId } = turn;
    const ready = await requireReady(settings).catch(() => null);
    if (!ready) return emit({ requestId, type: "error", message: "not_configured" });

    // An invoked skill: the agent loads it with its skill_view tool and follows it.
    const input = turn.skill
      ? `[IMPORTANT: The user invoked the "${turn.skill.name}" skill. Load it with skill_view and follow its instructions.]${
          turn.input ? `\n\n${turn.input}` : ""
        }`
      : turn.input;

    // Attachments ride in `message` as content parts: images inline, text
    // documents as text. Hermes' API refuses other documents (PDF, Office).
    let message: string | unknown[] = input;
    if (turn.attachments?.length) {
      try {
        message = await hermesContent(input, turn.attachments);
      } catch (error) {
        return emit({
          requestId,
          type: "error",
          message: `agent_error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    const controller = new AbortController();
    active.set(requestId, controller);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error("idle_timeout")), IDLE_TIMEOUT_MS);
    };
    const ctx = {
      requestId,
      input,
      message,
      modelFields: turnModelFields(settings),
      ready,
      signal: controller.signal,
      resetIdle,
      emit,
    };
    try {
      resetIdle();
      let sessionId = turn.sessionId;
      // A new chat gets a persistent server session; a pre-migration chat keeps
      // its response chain. If the session can't be created, fall back to chaining.
      if (!sessionId && !turn.previousResponseId && settings.hermes.sessions) {
        try {
          sessionId = await createSession(ready, turn.title);
          emit({ requestId, type: "session", sessionId });
        } catch (error) {
          logger.info("agent", "hermes session create failed, chaining", {
            error: String(error),
          });
        }
      }
      if (sessionId) await streamSessionTurn({ ...ctx, sessionId });
      else
        await streamResponsesTurn({
          ...ctx,
          previousResponseId: turn.previousResponseId,
        });
    } catch (err) {
      const reason = controller.signal.reason;
      const message = controller.signal.aborted
        ? reason instanceof Error && reason.message === "idle_timeout"
          ? "timeout"
          : "cancelled"
        : "unreachable";
      logger.info("agent", "hermes turn failed", {
        requestId,
        message,
        error: String(err),
      });
      emit({ requestId, type: "error", message });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      active.delete(requestId);
      runs.delete(requestId);
      dropApprovals(requestId);
    }
  },

  async respondApproval(requestId, approvalId, decision) {
    const pending = pendingApprovals.get(approvalId);
    if (!pending || pending.requestId !== requestId) return;
    const { ready, runId, emit } = pending;
    const response = await fetch(`${ready.root}/v1/runs/${encodeURIComponent(runId)}/approval`, {
      method: "POST",
      headers: authHeaders(ready.key, true),
      body: JSON.stringify({ choice: decision, request_id: approvalId }),
    });
    // 409: already answered / timed out server-side — either way it's settled.
    if (!response.ok && response.status !== 409) throw new Error(await readError(response));
    pendingApprovals.delete(approvalId);
    emit({ requestId, type: "approvalResolved", approvalId });
  },

  /** POST /v1/runs/{id}/stop (hard interrupt), then drop the stream. */
  cancel(requestId) {
    const run = runs.get(requestId);
    if (run) {
      void fetch(`${run.ready.root}/v1/runs/${encodeURIComponent(run.runId)}/stop`, {
        method: "POST",
        headers: authHeaders(run.ready.key),
      }).catch(() => {});
    }
    active.get(requestId)?.abort();
  },

  /**
   * POST /v1/runs/{id}/steer — lands after the current batch of tool calls.
   * Right after run.started the agent may not accept steers yet: retry briefly.
   */
  async steer(requestId, input) {
    const run = runs.get(requestId);
    if (!run) return false;
    // Three tries fit the renderer's 5s IPC budget.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(
        `${run.ready.root}/v1/runs/${encodeURIComponent(run.runId)}/steer`,
        {
          method: "POST",
          headers: authHeaders(run.ready.key, true),
          body: JSON.stringify({ message: input }),
          signal: AbortSignal.timeout(1_200),
        },
      ).catch(() => null);
      if (response?.ok) return true;
      if (response?.status !== 409 || !runs.has(requestId)) return false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
  },

  /** The agent's installed skills for the "/" picker (5-min cache). */
  async listSkills(settings) {
    const ready = await requireReady(settings).catch(() => null);
    if (!ready) return [];
    if (
      skillsCache &&
      skillsCache.baseUrl === ready.baseUrl &&
      Date.now() - skillsCache.at < 300_000
    )
      return skillsCache.data;
    try {
      const response = await fetch(`${ready.baseUrl}/skills`, {
        headers: authHeaders(ready.key),
      });
      if (!response.ok) return skillsCache?.data ?? [];
      const body = (await response.json()) as { data?: Skill[] } | Skill[];
      const raw = Array.isArray(body) ? body : (body.data ?? []);
      const skills = raw.map((s) => ({
        name: String(s.name ?? ""),
        description: String(s.description ?? ""),
        category: s.category ?? null,
      }));
      skillsCache = { at: Date.now(), baseUrl: ready.baseUrl, data: skills };
      return skills;
    } catch {
      return skillsCache?.data ?? [];
    }
  },

  /** Most recently active first, all sources, so WebUI chats show too. */
  async listSessions(settings, limit) {
    const ready = await requireReady(settings);
    const response = await fetch(`${ready.root}/api/sessions?limit=${limit}`, {
      headers: authHeaders(ready.key),
    });
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { data?: RawSession[] };
    return (body.data ?? []).map(toSession).filter((s) => s.id);
  },

  async readSession(settings, sessionId) {
    const ready = await requireReady(settings);
    const response = await fetch(
      `${ready.root}/api/sessions/${encodeURIComponent(sessionId)}/messages?order=oldest&limit=500`,
      { headers: authHeaders(ready.key) },
    );
    if (!response.ok) throw new Error(await readError(response));
    const body = (await response.json()) as { data?: RawMessage[] };
    return (body.data ?? []).map((m): ChatSessionMessage => {
      const role =
        m.role === "user" || m.role === "assistant" || m.role === "tool" ? m.role : "system";
      const toolCalls = (m.tool_calls ?? [])
        .filter((call) => call.function?.name ?? call.name)
        .map((call) =>
          hermesStep(
            call.function?.name ?? call.name ?? "",
            call.function?.arguments ?? call.arguments,
          ),
        );
      return {
        role,
        text: contentText(m.content),
        ...(m.tool_name ? { toolName: String(m.tool_name) } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    });
  },

  /** A missing session counts as deleted. */
  async deleteSession(settings, sessionId) {
    const ready = await requireReady(settings);
    const response = await fetch(`${ready.root}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: authHeaders(ready.key),
    });
    if (!response.ok && response.status !== 404) throw new Error(await readError(response));
  },

  shutdown() {
    for (const controller of active.values()) controller.abort();
  },
};
