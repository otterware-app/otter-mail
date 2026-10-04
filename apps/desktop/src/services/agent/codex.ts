/**
 * OpenAI Codex through `codex app-server`, following T3 Code's Codex driver:
 *  - health probe: a short-lived app-server → initialize, account/read,
 *    model/list; a spawn failure means "not installed".
 *  - one app-server per chat session, started with thread/start (or
 *    thread/resume for a saved Codex thread id), then turn/start per message.
 *  - raw notifications map onto the canonical ChatEvent stream.
 * Threads run in the app's agent workspace, so listing that cwd yields
 * exactly the chats started from Otter Mail.
 */

import { logger } from "../../logger.js";
import {
  CodexAppServer,
  CodexSpawnError,
  type Notification,
  type ServerRequest,
} from "./codex-app-server.js";
import { TOOL_OUTPUT_CHARS, codexStep, dataUrl } from "@otter-mail/core";
import { agentWorkspace, withAttachmentPaths } from "./local.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { MCP_SERVER_NAME, toolAccess, type ToolAccess } from "./mcp-server.js";
import type {
  ChatProvider,
  ChatSession,
  ChatSessionMessage,
  CodexSettings,
  Emit,
  ApprovalDecision,
  ApprovalRequest,
  ProviderModel,
  ProviderModelOption,
  ProviderSettings,
  RuntimeMode,
  SendTurnInput,
  Skill,
} from "@otter-mail/core";

const PROBE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Idle chat sessions release their app-server after this long. */
const SESSION_IDLE_MS = 15 * 60_000;
/** The utility server (history, skills) goes away sooner. */
const UTILITY_IDLE_MS = 60_000;

/** T3's runtime modes → Codex thread config. */
function threadConfig(settings: CodexSettings) {
  switch (settings.runtimeMode) {
    case "approval-required":
      return { approvalPolicy: "untrusted", sandbox: "read-only" };
    case "auto-accept-edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
  }
}

/** The same mode as a turn override, so switching modes applies to the next turn. */
function turnPolicy(settings: CodexSettings) {
  const { approvalPolicy, sandbox } = threadConfig(settings);
  const sandboxPolicy =
    sandbox === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : sandbox === "workspace-write"
        ? {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : { type: "dangerFullAccess" };
  return { approvalPolicy, sandboxPolicy };
}

function planLabel(plan: string | null | undefined): string {
  if (!plan || plan === "unknown") return "ChatGPT";
  return `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1).replace(/_/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Thread items → tool rows
// ---------------------------------------------------------------------------

type Item = { type?: string; id?: string } & Record<string, unknown>;

function toolOutput(item: Item): string {
  let text = "";
  if (item.type === "commandExecution") text = String(item.aggregatedOutput ?? "");
  else if (item.type === "mcpToolCall") {
    const error = item.error as { message?: string } | null;
    const result = item.result as { content?: { text?: string }[] } | null;
    text = error?.message ?? (result?.content ?? []).map((c) => c?.text ?? "").join("\n");
  } else if (item.type === "dynamicToolCall") {
    const content = item.contentItems as { text?: string }[] | null;
    text = (content ?? []).map((c) => c?.text ?? "").join("\n");
  } else if (item.type === "fileChange") {
    const changes = item.changes as { path?: string }[] | undefined;
    text = (changes ?? []).map((c) => c.path).join("\n");
  }
  return text.slice(0, TOOL_OUTPUT_CHARS) || "(done)";
}

function userText(item: Item): string {
  const content = item.content as { type?: string; text?: string }[] | undefined;
  return (content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Sessions (one app-server each)
// ---------------------------------------------------------------------------

type ActiveTurn = {
  requestId: string;
  emit: Emit;
  turnId: string | null;
  cancelRequested: boolean;
  streamedText: boolean;
  /** Last non-retried error, reported if the turn then fails. */
  error: string | null;
  /** Approval requests waiting on the user, by approval id. */
  approvals: Map<string, ServerRequest>;
  finish: () => void;
};

type Session = {
  server: CodexAppServer;
  threadId: string;
  turn: ActiveTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The chat's runtime mode, as of its last turn. */
  mode: RuntimeMode;
  /** Otter Mail's tools, on this chat's token. */
  tools: ToolAccess;
};

const sessions = new Map<string, Session>();

function stopSession(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(session.threadId);
  session.server.kill();
}

function armIdle(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!session.turn) stopSession(session);
  }, SESSION_IDLE_MS);
}

/** Codex's answer for an approval request, per T3's decision mapping. */
function approvalResponse(request: ServerRequest, decision: ApprovalDecision | "cancel"): unknown {
  if (request.method === "item/permissions/requestApproval") {
    const granted = decision === "once" || decision === "session" || decision === "always";
    return {
      permissions: granted ? request.params.permissions : {},
      scope: decision === "once" ? "turn" : "session",
    };
  }
  // Legacy v1 approvals speak ReviewDecision.
  if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
    return {
      decision:
        decision === "once"
          ? "approved"
          : decision === "session" || decision === "always"
            ? "approved_for_session"
            : decision === "cancel"
              ? "abort"
              : { denied: { rejection: "The user declined." } },
    };
  }
  return {
    decision:
      decision === "once"
        ? "accept"
        : decision === "session" || decision === "always"
          ? "acceptForSession"
          : decision === "cancel"
            ? "cancel"
            : "decline",
  };
}

/** A server request as the user sees it, or null when it isn't an approval. */
function toApproval(request: ServerRequest): ApprovalRequest | null {
  const p = request.params;
  const id = String(request.id);
  const reason = typeof p.reason === "string" && p.reason ? p.reason : undefined;
  const choices: ApprovalDecision[] = ["once", "session", "deny"];
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return {
        id,
        kind: "command",
        title: "Command approval",
        detail: String(p.command ?? ""),
        reason,
        choices,
      };
    case "execCommandApproval":
      return {
        id,
        kind: "command",
        title: "Command approval",
        detail: Array.isArray(p.command) ? p.command.join(" ") : String(p.command ?? ""),
        reason,
        choices,
      };
    case "item/fileChange/requestApproval":
    case "applyPatchApproval": {
      const files =
        p.fileChanges && typeof p.fileChanges === "object" ? Object.keys(p.fileChanges) : [];
      const detail = files.length > 0 ? files.join("\n") : String(p.grantRoot ?? "");
      return {
        id,
        kind: "fileChange",
        title: "File change approval",
        detail: detail || undefined,
        reason,
        choices,
      };
    }
    case "item/permissions/requestApproval":
      return {
        id,
        kind: "permission",
        title: "Permission approval",
        detail: JSON.stringify(p.permissions ?? {}, null, 2),
        reason,
        choices,
      };
    default:
      return null;
  }
}

/**
 * Approvals go to the user as `approval` events and wait for their answer;
 * other requests (user input, MCP elicitation) are answered empty.
 */
function handleServerRequest(session: Session, request: ServerRequest): void {
  const approval = toApproval(request);
  const turn = session.turn;
  if (approval && turn) {
    turn.approvals.set(approval.id, request);
    turn.emit({ requestId: turn.requestId, type: "approval", approval });
    return;
  }
  logger.info("agent", "codex server request answered empty", {
    method: request.method,
  });
  if (approval) session.server.respond(request.id, approvalResponse(request, "deny"));
  else if (request.method === "item/tool/requestUserInput")
    session.server.respond(request.id, { answers: {} });
  else if (request.method === "mcpServer/elicitation/request")
    session.server.respond(request.id, { action: "decline" });
  else session.server.respond(request.id, {});
}

/** Settles every open approval (before an interrupt, or when the turn ends). */
function settleApprovals(
  session: Session,
  turn: ActiveTurn,
  decision: ApprovalDecision | "cancel",
): void {
  for (const [id, request] of turn.approvals) {
    session.server.respond(request.id, approvalResponse(request, decision));
    turn.emit({
      requestId: turn.requestId,
      type: "approvalResolved",
      approvalId: id,
    });
  }
  turn.approvals.clear();
}

function handleNotification(session: Session, { method, params }: Notification): void {
  const turn = session.turn;
  if (!turn || (params.threadId && params.threadId !== session.threadId)) return;
  const { requestId, emit } = turn;
  switch (method) {
    case "turn/started": {
      const id = (params.turn as { id?: string } | undefined)?.id ?? null;
      turn.turnId ??= id;
      break;
    }
    case "item/agentMessage/delta": {
      const delta = String(params.delta ?? "");
      if (!delta) break;
      turn.streamedText = true;
      emit({ requestId, type: "delta", text: delta });
      break;
    }
    case "item/started": {
      const item = params.item as Item;
      // A new message after tool calls: keep paragraphs apart.
      if (item.type === "agentMessage" && turn.streamedText)
        emit({ requestId, type: "delta", text: "\n\n" });
      const step = codexStep(item);
      if (step) emit({ requestId, type: "tool", id: item.id, step });
      break;
    }
    case "item/completed": {
      const item = params.item as Item;
      if (codexStep(item))
        emit({ requestId, type: "toolResult", id: item.id, output: toolOutput(item) });
      else if (item.type === "agentMessage" && !turn.streamedText && item.text) {
        turn.streamedText = true;
        emit({ requestId, type: "delta", text: String(item.text) });
      }
      break;
    }
    case "error": {
      if (params.willRetry) break;
      turn.error = (params.error as { message?: string } | undefined)?.message ?? "agent_error";
      break;
    }
    case "turn/completed": {
      const done = params.turn as {
        id?: string;
        status?: string;
        error?: { message?: string };
      };
      if (turn.turnId && done.id && done.id !== turn.turnId) break;
      if (done.status === "completed") emit({ requestId, type: "done", responseId: null });
      else if (done.status === "interrupted")
        emit({ requestId, type: "error", message: "cancelled" });
      else {
        const message = done.error?.message ?? turn.error;
        emit({
          requestId,
          type: "error",
          message: message ? `agent_error: ${message}` : "agent_error",
        });
      }
      turn.finish();
      break;
    }
    default:
      break;
  }
}

/** Resume errors that mean "no such thread" (then start a fresh one). */
function isMissingThread(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    message.includes("thread") &&
    [
      "not found",
      "missing thread",
      "no such thread",
      "unknown thread",
      "does not exist",
      "no rollout found",
    ].some((needle) => message.includes(needle))
  );
}

async function openSession(
  settings: CodexSettings,
  sessionId: string | undefined,
): Promise<Session> {
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing?.server.alive) return existing;

  const cwd = await agentWorkspace();
  // The tools' caller is this session, once it exists.
  const current: { session?: Session } = {};
  const tools = await toolAccess({
    mode: () => current.session?.mode ?? settings.runtimeMode,
    turn: () => current.session?.turn ?? null,
  });
  const server = await CodexAppServer.start(settings, cwd).catch((error: unknown) => {
    tools.revoke();
    throw error;
  });
  const params = {
    cwd,
    ...threadConfig(settings),
    ...(settings.model ? { model: settings.model } : {}),
    developerInstructions: AGENT_INSTRUCTIONS,
    config: {
      mcp_servers: {
        [MCP_SERVER_NAME]: {
          url: tools.url,
          http_headers: tools.headers,
          // The tools ask the user themselves (and may wait on them).
          default_tools_approval_mode: "approve",
          tool_timeout_sec: 3600,
        },
      },
    },
  };
  let threadId: string;
  try {
    const opened = sessionId
      ? await server
          .request<{ thread: { id: string } }>(
            "thread/resume",
            { threadId: sessionId, ...params, excludeTurns: true },
            REQUEST_TIMEOUT_MS,
          )
          .catch((error: unknown) => {
            if (!isMissingThread(error)) throw error;
            logger.info("agent", "codex thread gone, starting fresh", {
              sessionId,
            });
            return server.request<{ thread: { id: string } }>(
              "thread/start",
              params,
              REQUEST_TIMEOUT_MS,
            );
          })
      : await server.request<{ thread: { id: string } }>(
          "thread/start",
          params,
          REQUEST_TIMEOUT_MS,
        );
    threadId = opened.thread.id;
  } catch (error) {
    server.kill();
    tools.revoke();
    throw error;
  }

  const session: Session = {
    server,
    threadId,
    turn: null,
    idleTimer: null,
    mode: settings.runtimeMode,
    tools,
  };
  current.session = session;
  server.onNotification = (message) => handleNotification(session, message);
  server.onServerRequest = (request) => handleServerRequest(session, request);
  server.onExit = (code) => {
    sessions.delete(threadId);
    tools.revoke();
    const turn = session.turn;
    if (turn) {
      logger.info("agent", "codex exited mid-turn", { code });
      turn.emit({
        requestId: turn.requestId,
        type: "error",
        message: "unreachable",
      });
      turn.finish();
    }
  };
  sessions.set(threadId, session);
  return session;
}

// ---------------------------------------------------------------------------
// Utility server (probe, history, skills)
// ---------------------------------------------------------------------------

let utility: {
  server: Promise<CodexAppServer>;
  timer: ReturnType<typeof setTimeout> | null;
} | null = null;

async function withUtility<T>(
  settings: CodexSettings,
  fn: (server: CodexAppServer) => Promise<T>,
): Promise<T> {
  if (!utility) {
    const server = agentWorkspace().then((cwd) => CodexAppServer.start(settings, cwd));
    utility = { server, timer: null };
    server.catch(() => {
      utility = null;
    });
  }
  const current = utility;
  if (current.timer) clearTimeout(current.timer);
  const server = await current.server;
  if (!server.alive) {
    utility = null;
    return withUtility(settings, fn);
  }
  try {
    return await fn(server);
  } finally {
    current.timer = setTimeout(() => {
      server.kill();
      if (utility === current) utility = null;
    }, UTILITY_IDLE_MS);
  }
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

/** Standard speed; what an unset service tier means. */
export const DEFAULT_SERVICE_TIER = "default";

type RawModel = {
  model: string;
  displayName?: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: {
    reasoningEffort: string;
    description?: string;
  }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name: string; description?: string }[];
  additionalSpeedTiers?: string[];
  defaultServiceTier?: string | null;
};

/** Reasoning + Service Tier options, as T3's mapCodexModelCapabilities builds them. */
function modelOptions(m: RawModel): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const efforts = m.supportedReasoningEfforts ?? [];
  if (efforts.length > 0) {
    options.push({
      id: "reasoningEffort",
      label: "Reasoning",
      choices: efforts.map(({ reasoningEffort }) => ({
        id: reasoningEffort,
        label: REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort,
        ...(reasoningEffort === m.defaultReasoningEffort ? { isDefault: true } : {}),
      })),
    });
  }
  const tiers =
    m.serviceTiers && m.serviceTiers.length > 0
      ? m.serviceTiers
      : (m.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  if (tiers.length > 0) {
    const defaultTier = tiers.some((t) => t.id === m.defaultServiceTier)
      ? m.defaultServiceTier
      : DEFAULT_SERVICE_TIER;
    options.push({
      id: "serviceTier",
      label: "Service Tier",
      choices: [
        {
          id: DEFAULT_SERVICE_TIER,
          label: "Standard",
          ...(defaultTier === DEFAULT_SERVICE_TIER ? { isDefault: true } : {}),
        },
        ...tiers.map((t) => ({
          id: t.id,
          label: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(defaultTier === t.id ? { isDefault: true } : {}),
        })),
      ],
    });
  }
  return options;
}

/** Last catalog from the health probe; turns resolve effort/tier defaults against it. */
let knownModels: ProviderModel[] = [];

async function listModels(server: CodexAppServer): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: RawModel[]; nextCursor: string | null } = await server.request(
      "model/list",
      cursor ? { cursor } : {},
      PROBE_TIMEOUT_MS,
    );
    for (const m of page.data) {
      if (m.hidden) continue;
      models.push({
        slug: m.model,
        name: m.displayName || m.model,
        ...(m.isDefault ? { isDefault: true } : {}),
        options: modelOptions(m),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  knownModels = models;
  return models;
}

/**
 * Effort + tier for a turn. Both persist on the thread once sent, so the
 * effort is always explicit (the model's default when unset); the tier only
 * applies to this turn and is omitted for standard speed.
 */
function turnOptions(codex: CodexSettings, models: ProviderModel[]): Record<string, string> {
  const model =
    models.find((m) => m.slug === codex.model) ?? models.find((m) => m.isDefault) ?? models[0];
  const choices = (id: ProviderModelOption["id"]) =>
    model?.options?.find((o) => o.id === id)?.choices ?? [];
  const efforts = choices("reasoningEffort");
  const effort =
    efforts.find((c) => c.id === codex.reasoningEffort)?.id ?? efforts.find((c) => c.isDefault)?.id;
  const tier = choices("serviceTier").find((c) => c.id === codex.serviceTier)?.id;
  return {
    ...(effort ? { effort } : {}),
    ...(tier && tier !== DEFAULT_SERVICE_TIER ? { serviceTierForTurn: tier } : {}),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const turnsByRequest = new Map<string, Session>();

export const codexProvider: ChatProvider = {
  kind: "codex",
  displayName: "Codex",

  async checkStatus(settings) {
    const base = {
      kind: "codex" as const,
      displayName: "Codex",
      models: [] as ProviderModel[],
      model: settings.codex.model || null,
      sessions: true,
    };
    let server: CodexAppServer | null = null;
    try {
      return await withTimeout(
        (async () => {
          server = await CodexAppServer.start(settings.codex, await agentWorkspace());
          const account = await server.request<{
            account: {
              type: string;
              email?: string | null;
              planType?: string;
            } | null;
            requiresOpenaiAuth: boolean;
          }>("account/read", {}, PROBE_TIMEOUT_MS);
          const version = server.version;
          if (!account.account && account.requiresOpenaiAuth) {
            return {
              ...base,
              installed: true,
              version,
              status: "error" as const,
              auth: { status: "unauthenticated" as const },
              message: "Codex CLI is not authenticated. Run `codex login` and try again.",
            };
          }
          const models = await listModels(server);
          const acct = account.account;
          const fallbackModel = models.find((m) => m.isDefault)?.slug ?? models[0]?.slug ?? null;
          return {
            ...base,
            installed: true,
            version,
            status: "ready" as const,
            models,
            model: settings.codex.model || fallbackModel,
            auth: acct
              ? {
                  status: "authenticated" as const,
                  label:
                    acct.type === "chatgpt"
                      ? planLabel(acct.planType)
                      : acct.type === "apiKey"
                        ? "API key"
                        : acct.type,
                  ...(acct.email ? { email: acct.email } : {}),
                }
              : { status: "unknown" as const },
          };
        })(),
        PROBE_TIMEOUT_MS,
        "Timed out while checking Codex.",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = error instanceof CodexSpawnError;
      return {
        ...base,
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `${message}. Install it with \`npm i -g @openai/codex\` or set the binary path.`
          : `Codex app-server probe failed: ${message}`,
      };
    } finally {
      (server as CodexAppServer | null)?.kill();
    }
  },

  async sendTurn(turn: SendTurnInput, settings: ProviderSettings, emit: Emit) {
    const { requestId } = turn;
    let session: Session;
    try {
      session = await openSession(settings.codex, turn.sessionId);
    } catch (error) {
      logger.info("agent", "codex session failed", {
        error: String(error),
      });
      const message =
        error instanceof CodexSpawnError
          ? "not_installed"
          : `agent_error: ${String(error instanceof Error ? error.message : error)}`;
      return emit({ requestId, type: "error", message });
    }
    if (session.threadId !== turn.sessionId)
      emit({ requestId, type: "session", sessionId: session.threadId });
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.mode = settings.codex.runtimeMode;

    const finished = new Promise<void>((resolve) => {
      session.turn = {
        requestId,
        emit,
        turnId: null,
        cancelRequested: false,
        streamedText: false,
        error: null,
        approvals: new Map(),
        finish: resolve,
      };
    });
    turnsByRequest.set(requestId, session);
    const input: unknown[] = [];
    if (turn.skill?.path)
      input.push({
        type: "skill",
        name: turn.skill.name,
        path: turn.skill.path,
      });
    // Otter Code: text with every attachment's path, then images as data URLs.
    const attached = turn.attachments ?? [];
    const base = turn.input || (attached.length ? "" : `Use the ${turn.skill?.name ?? ""} skill.`);
    input.push({ type: "text", text: withAttachmentPaths(base, attached), text_elements: [] });
    for (const image of attached.filter((a) => a.kind === "image"))
      input.push({ type: "image", url: await dataUrl(image) });
    try {
      const started = await session.server.request<{ turn: { id: string } }>(
        "turn/start",
        {
          threadId: session.threadId,
          input,
          ...(settings.codex.model ? { model: settings.codex.model } : {}),
          ...turnOptions(settings.codex, knownModels),
          ...turnPolicy(settings.codex),
        },
        REQUEST_TIMEOUT_MS,
      );
      const active = session.turn as ActiveTurn | null;
      if (active?.requestId === requestId) {
        active.turnId ??= started.turn.id;
        if (active.cancelRequested) codexProvider.cancel(requestId);
      }
      await finished;
    } catch (error) {
      emit({
        requestId,
        type: "error",
        message: `agent_error: ${String(error instanceof Error ? error.message : error)}`,
      });
    } finally {
      turnsByRequest.delete(requestId);
      if (session.turn?.requestId === requestId) session.turn = null;
      armIdle(session);
    }
  },

  /** turn/steer: adds input to the active turn (expectedTurnId guards races). */
  async steer(requestId, input) {
    const session = turnsByRequest.get(requestId);
    const turn = session?.turn;
    if (!session || !turn?.turnId || turn.requestId !== requestId) return false;
    try {
      await session.server.request(
        "turn/steer",
        {
          threadId: session.threadId,
          expectedTurnId: turn.turnId,
          input: [{ type: "text", text: input, text_elements: [] }],
        },
        REQUEST_TIMEOUT_MS,
      );
      return true;
    } catch (error) {
      logger.info("agent", "codex steer failed", { error: String(error) });
      return false;
    }
  },

  cancel(requestId) {
    const session = turnsByRequest.get(requestId);
    const turn = session?.turn;
    if (!session || !turn || turn.requestId !== requestId) return;
    if (!turn.turnId) {
      turn.cancelRequested = true;
      return;
    }
    // An open approval blocks Codex's loop: settle it before interrupting.
    settleApprovals(session, turn, "cancel");
    session.tools.cancelApprovals();
    void session.server
      .request(
        "turn/interrupt",
        { threadId: session.threadId, turnId: turn.turnId },
        REQUEST_TIMEOUT_MS,
      )
      .catch((error: unknown) => {
        logger.info("agent", "codex interrupt failed", {
          error: String(error),
        });
        session.server.kill();
      });
  },

  async respondApproval(requestId, approvalId, decision) {
    const session = turnsByRequest.get(requestId);
    const turn = session?.turn;
    const request = turn?.approvals.get(approvalId);
    if (!session || !turn || !request) return;
    turn.approvals.delete(approvalId);
    session.server.respond(request.id, approvalResponse(request, decision));
    turn.emit({ requestId, type: "approvalResolved", approvalId });
  },

  async listSkills(settings): Promise<Skill[]> {
    try {
      const cwd = await agentWorkspace();
      const response = await withUtility(settings.codex, (server) =>
        server.request<{
          data: {
            skills: {
              name: string;
              description: string;
              shortDescription?: string;
              path: string;
              enabled: boolean;
            }[];
          }[];
        }>("skills/list", { cwds: [cwd] }, PROBE_TIMEOUT_MS),
      );
      const seen = new Set<string>();
      return response.data
        .flatMap((entry) => entry.skills)
        .filter((s) => s.enabled && !seen.has(s.name) && seen.add(s.name))
        .map((s) => ({
          name: s.name,
          description: s.shortDescription || s.description,
          category: null,
          path: s.path,
        }));
    } catch (error) {
      logger.info("agent", "codex skills failed", { error: String(error) });
      return [];
    }
  },

  async listSessions(settings, limit): Promise<ChatSession[]> {
    const cwd = await agentWorkspace();
    const response = await withUtility(settings.codex, (server) =>
      server.request<{
        data: {
          id: string;
          name?: string | null;
          preview?: string;
          updatedAt?: number;
          source?: string;
        }[];
      }>(
        "thread/list",
        { cwd, limit, sortKey: "updated_at", useStateDbOnly: true },
        PROBE_TIMEOUT_MS,
      ),
    );
    return response.data.map((t) => ({
      id: t.id,
      title: t.name ?? null,
      source: "codex",
      lastActive: (t.updatedAt ?? 0) * 1000,
      messageCount: t.preview ? 1 : 0,
      preview: t.preview ?? null,
    }));
  },

  async readSession(settings, sessionId): Promise<ChatSessionMessage[]> {
    const response = await withUtility(settings.codex, (server) =>
      server.request<{ data: { items: Item[] }[] }>(
        "thread/turns/list",
        {
          threadId: sessionId,
          itemsView: "full",
          sortDirection: "asc",
          limit: 100,
        },
        PROBE_TIMEOUT_MS,
      ),
    );
    const messages: ChatSessionMessage[] = [];
    for (const turn of response.data) {
      for (const item of turn.items) {
        const step = codexStep(item);
        if (item.type === "userMessage") messages.push({ role: "user", text: userText(item) });
        else if (item.type === "agentMessage")
          messages.push({ role: "assistant", text: String(item.text ?? "") });
        else if (step) {
          messages.push({ role: "assistant", text: "", toolCalls: [step] });
          messages.push({ role: "tool", text: toolOutput(item) });
        }
      }
    }
    return messages;
  },

  /** Archived, not destroyed: it stays recoverable from the Codex CLI. */
  async deleteSession(settings, sessionId) {
    const live = sessions.get(sessionId);
    if (live) stopSession(live);
    await withUtility(settings.codex, (server) =>
      server.request("thread/archive", { threadId: sessionId }, PROBE_TIMEOUT_MS),
    );
  },

  shutdown() {
    for (const session of sessions.values()) stopSession(session);
    const current = utility;
    utility = null;
    if (current) {
      if (current.timer) clearTimeout(current.timer);
      void current.server.then(
        (server) => server.kill(),
        () => {},
      );
    }
  },
};
