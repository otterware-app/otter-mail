/**
 * Claude Code through the Claude Agent SDK, following T3 Code's Claude driver:
 *  - health probe: `claude --version`, then an SDK query whose prompt never
 *    yields (no API request) for `initializationResult()` → account, live
 *    models (with effort levels), slash commands.
 *  - one long-lived `query()` per chat, fed by a streaming prompt queue; each
 *    turn pushes a user message and ends at the SDK's `result`.
 *  - runtime modes → permissionMode; `canUseTool` surfaces approvals.
 *  - stop closes the query (T3: a hard session boundary); the next turn
 *    resumes the session by id.
 * Sessions run in the app's agent workspace, so listing it yields exactly
 * the chats started from Otter Mail.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  deleteSession as sdkDeleteSession,
  getSessionMessages,
  listSessions as sdkListSessions,
  query,
  type CanUseTool,
  type EffortLevel,
  type Options as ClaudeOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../../logger.js";
import fs from "node:fs/promises";
import { attachmentPath, attachmentsDir, agentWorkspace, withAttachmentPaths } from "./local.js";
import { AGENT_INSTRUCTIONS } from "./instructions.js";
import { MCP_SERVER_NAME, toolAccess, type ToolAccess } from "./mcp-server.js";
import { ensureShellPath } from "./shell-path.js";
import { TOOL_OUTPUT_CHARS, claudeStep } from "@otter-mail/core";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatProvider,
  ChatSession,
  ChatSessionMessage,
  ClaudeSettings,
  Emit,
  ProviderModel,
  ProviderModelOption,
  RuntimeMode,
  Skill,
} from "@otter-mail/core";

const PROBE_TIMEOUT_MS = 25_000;
/** Image types Claude accepts as content blocks. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const VERSION_TIMEOUT_MS = 10_000;
/** Idle chats release their Claude process after this long. */
const SESSION_IDLE_MS = 15 * 60_000;

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function claudeBinary(settings: ClaudeSettings): string {
  return expandHome(settings.binaryPath.trim()) || "claude";
}

/** CLAUDE_CONFIG_DIR isolates config without touching HOME (OAuth keeps working). */
function claudeEnv(settings: ClaudeSettings): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // When the app itself was started from a Claude Code session, its session
  // variables would make our `claude` act as that session's child (and ignore
  // the user's own login). Start from a clean slate.
  for (const key of Object.keys(env)) {
    if (
      /^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_EFFORT$|CLAUDE_PID$|ELECTRON_RUN_AS_NODE$)/.test(
        key,
      )
    )
      delete env[key];
  }
  // Claude finds its login in the Keychain by account name; the app's backend
  // runs without USER/LOGNAME, which reads as "Not logged in".
  const username = os.userInfo().username;
  env.USER ??= username;
  env.LOGNAME ??= username;
  env.HOME ??= os.homedir();
  if (settings.homePath.trim()) env.CLAUDE_CONFIG_DIR = expandHome(settings.homePath.trim());
  return env;
}

/** T3's runtime mode → Claude permission mode ("approval-required" = the SDK default). */
function permissionMode(mode: RuntimeMode): PermissionMode {
  return mode === "full-access"
    ? "bypassPermissions"
    : mode === "auto-accept-edits"
      ? "acceptEdits"
      : "default";
}

// ---------------------------------------------------------------------------
// Tool labels + approvals (T3's classifyRequestType / summarizeToolRequest)
// ---------------------------------------------------------------------------

function isReadOnlyTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "read" ||
    n.includes("view") ||
    n.includes("grep") ||
    n.includes("glob") ||
    n.includes("search")
  );
}

function approvalKind(name: string): ApprovalRequest["kind"] {
  const n = name.toLowerCase();
  if (isReadOnlyTool(name)) return "tool";
  if (/bash|command|shell|terminal/.test(n)) return "command";
  if (/edit|write|file|patch|replace|create|delete/.test(n)) return "fileChange";
  return "tool";
}

const APPROVAL_TITLES: Record<ApprovalRequest["kind"], string> = {
  command: "Command approval",
  fileChange: "File change approval",
  permission: "Permission approval",
  tool: "Tool approval",
};

/** Otter Mail's own tools, as Claude names them. */
const OTTER_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** `Bash: gog gmail …`, a file path, or the tool name + JSON input (≤400 chars). */
function summarizeTool(name: string, input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd;
  if (typeof command === "string" && command.trim())
    return `${name}: ${command.trim().slice(0, 400)}`;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file === "string" && file) return `${name}: ${file}`;
  if (typeof input.description === "string" && input.description.trim())
    return `${name}: ${input.description.trim()}`;
  const json = JSON.stringify(input);
  return json.length <= 400 ? `${name}: ${json}` : `${name}: ${json.slice(0, 397)}...`;
}

/** "Always allow this session": the SDK's suggestions scoped to the session. */
function sessionPermissionUpdates(
  name: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const scoped = (suggestions ?? []).map((s): PermissionUpdate => ({
    ...s,
    destination: "session",
  }));
  return scoped.length > 0
    ? scoped
    : [
        {
          type: "addRules",
          rules: [{ toolName: name }],
          behavior: "allow",
          destination: "session",
        },
      ];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

type PendingApproval = {
  resolve: (decision: ApprovalDecision | "cancel") => void;
};

type ActiveTurn = {
  requestId: string;
  emit: Emit;
  streamedText: boolean;
  approvals: Map<string, PendingApproval>;
  /** Steers pushed this turn: a late one gets its own result after this one's. */
  steers: number;
  /** A success result waiting to see whether a late steer continues the turn. */
  settle: ReturnType<typeof setTimeout> | null;
  finish: () => void;
};

/** How long a steered turn waits after a result for the steer's own reply. */
const STEER_SETTLE_MS = 2_000;

/** An async-iterable prompt queue: the long-lived input of one query. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type Session = {
  sessionId: string;
  query: Query;
  prompts: PromptQueue;
  turn: ActiveTurn | null;
  /** Launch options a live query can't change (a change reopens the session). */
  launchKey: string;
  mode: RuntimeMode;
  model: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  /** Otter Mail's tools, on this chat's token. */
  tools: ToolAccess;
  /** Tool uses the chat doesn't show (Claude's own bookkeeping), so their results aren't shown either. */
  hiddenTools: Set<string>;
};

const sessions = new Map<string, Session>();
const turnsByRequest = new Map<string, Session>();

/** Closes the query; open approvals are cancelled and a running turn ends as stopped. */
function closeSession(session: Session, reason: "cancelled" | "unreachable" = "cancelled"): void {
  if (session.closed) return;
  session.closed = true;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  sessions.delete(session.sessionId);
  session.tools.revoke();
  const turn = session.turn;
  if (turn) {
    for (const pending of turn.approvals.values()) pending.resolve("cancel");
    turn.emit({ requestId: turn.requestId, type: "error", message: reason });
    turn.finish();
  }
  session.prompts.close();
  try {
    session.query.close();
  } catch {
    // already gone
  }
}

function armIdle(session: Session): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    if (!session.turn) closeSession(session);
  }, SESSION_IDLE_MS);
}

/** Text of a tool_result's content (string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
      .join("\n");
  return "";
}

/** Routes one SDK message to the running turn (T3's handle*Message family, trimmed). */
function handleMessage(session: Session, message: SDKMessage): void {
  const turn = session.turn;
  if (!turn) return;
  const { requestId, emit } = turn;
  // Activity after a result: a late steer is being answered — keep the turn.
  if (turn.settle && (message.type === "stream_event" || message.type === "assistant")) {
    clearTimeout(turn.settle);
    turn.settle = null;
    turn.streamedText = false;
    emit({ requestId, type: "delta", text: "\n\n" });
  }
  switch (message.type) {
    case "stream_event": {
      // Subagent output stays inside its tool row.
      if (message.parent_tool_use_id) break;
      const event = message.event as {
        type: string;
        content_block?: { type?: string };
        delta?: { type?: string; text?: string };
      };
      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "text" &&
        turn.streamedText
      ) {
        emit({ requestId, type: "delta", text: "\n\n" });
      } else if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        event.delta.text
      ) {
        turn.streamedText = true;
        emit({ requestId, type: "delta", text: event.delta.text });
      }
      break;
    }
    case "assistant": {
      if (message.parent_tool_use_id) break;
      const content = (message.message as { content?: unknown[] }).content ?? [];
      for (const block of content as {
        type?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
        text?: string;
      }[]) {
        if (block.type === "tool_use" && block.name) {
          const step = claudeStep(block.name, block.input ?? {});
          if (step) emit({ requestId, type: "tool", id: block.id, step });
          else if (block.id) session.hiddenTools.add(block.id);
        } else if (block.type === "text" && block.text && !turn.streamedText) {
          // Backfill text the stream didn't deliver.
          turn.streamedText = true;
          emit({ requestId, type: "delta", text: block.text });
        }
      }
      break;
    }
    case "user": {
      if (message.parent_tool_use_id) break;
      const content = (message.message as { content?: unknown }).content;
      if (!Array.isArray(content)) break;
      for (const block of content as {
        type?: string;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }[]) {
        if (block.type !== "tool_result") continue;
        if (block.tool_use_id && session.hiddenTools.delete(block.tool_use_id)) continue;
        const text = resultText(block.content).slice(0, TOOL_OUTPUT_CHARS);
        emit({
          requestId,
          type: "toolResult",
          id: block.tool_use_id,
          output: text || (block.is_error ? "(failed)" : "(done)"),
        });
      }
      break;
    }
    case "result": {
      const result = message as {
        subtype: string;
        is_error?: boolean;
        result?: string;
        errors?: string[];
        terminal_reason?: string;
      };
      // Claude aborted its stream to take the steer: the turn goes on.
      if (
        turn.steers > 0 &&
        (result.terminal_reason === "aborted_streaming" ||
          result.terminal_reason === "aborted_tools")
      )
        break;
      if (result.subtype === "success" && !result.is_error) {
        // Steered: Claude either folded the steer into this result or answers
        // it next with its own. Give it a moment before closing the turn.
        if (turn.steers > 0) {
          turn.steers -= 1;
          if (turn.settle) clearTimeout(turn.settle);
          turn.settle = setTimeout(() => {
            turn.settle = null;
            emit({ requestId, type: "done", responseId: null });
            turn.finish();
          }, STEER_SETTLE_MS);
          break;
        }
        if (turn.settle) clearTimeout(turn.settle);
        emit({ requestId, type: "done", responseId: null });
      } else {
        const text =
          (result.errors ?? []).filter((e) => !e.startsWith("[ede_diagnostic]")).join("\n") ||
          result.result ||
          "";
        const interrupted = /interrupt|aborted/i.test(text);
        emit({
          requestId,
          type: "error",
          message: interrupted ? "cancelled" : text ? `agent_error: ${text}` : "agent_error",
        });
      }
      turn.finish();
      break;
    }
    default:
      break;
  }
}

async function openSession(
  settings: ClaudeSettings,
  sessionId: string | undefined,
): Promise<Session> {
  const launchKey = JSON.stringify([
    settings.binaryPath,
    settings.homePath,
    settings.reasoningEffort,
    settings.serviceTier,
  ]);
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing && !existing.closed && existing.launchKey === launchKey) return existing;
  if (existing) closeSession(existing);

  await ensureShellPath();
  const cwd = await agentWorkspace();
  const id = sessionId ?? randomUUID();
  const prompts = new PromptQueue();
  const mode = settings.runtimeMode;
  const session = {} as Session;
  const tools = await toolAccess({ mode: () => session.mode, turn: () => session.turn });

  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const turn = session.turn;
    if (session.mode === "full-access" || !turn) return { behavior: "allow", updatedInput: input };
    const approval: ApprovalRequest = {
      id: options.toolUseID || randomUUID(),
      kind: approvalKind(toolName),
      title: APPROVAL_TITLES[approvalKind(toolName)],
      detail: summarizeTool(toolName, input),
      ...(options.decisionReason ? { reason: options.decisionReason } : {}),
      choices: ["once", "session", "deny"],
    };
    const decision = await new Promise<ApprovalDecision | "cancel">((resolve) => {
      turn.approvals.set(approval.id, { resolve });
      options.signal.addEventListener("abort", () => resolve("cancel"), {
        once: true,
      });
      turn.emit({ requestId: turn.requestId, type: "approval", approval });
    });
    turn.approvals.delete(approval.id);
    turn.emit({
      requestId: turn.requestId,
      type: "approvalResolved",
      approvalId: approval.id,
    });
    if (decision === "once") return { behavior: "allow", updatedInput: input };
    if (decision === "session" || decision === "always")
      return {
        behavior: "allow",
        updatedInput: input,
        updatedPermissions: sessionPermissionUpdates(toolName, options.suggestions),
      };
    return {
      behavior: "deny",
      message:
        decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.",
    };
  };

  const effort = settings.reasoningEffort as EffortLevel | "";
  const pm = permissionMode(mode);
  const options: ClaudeOptions = {
    cwd,
    pathToClaudeCodeExecutable: claudeBinary(settings),
    env: claudeEnv(settings),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: AGENT_INSTRUCTIONS,
    },
    settingSources: ["user", "project", "local"],
    ...(settings.model ? { model: settings.model } : {}),
    ...(effort ? { effort } : {}),
    ...(settings.serviceTier === "fast" ? { settings: { fastMode: true } } : {}),
    permissionMode: pm,
    ...(pm === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(sessionId ? { resume: sessionId } : { sessionId: id }),
    includePartialMessages: true,
    // Attached documents (and downloaded mail attachments) live outside the workspace.
    additionalDirectories: [await attachmentsDir()],
    mcpServers: {
      // In the prompt from the start, rather than found through ToolSearch.
      [MCP_SERVER_NAME]: {
        type: "http",
        url: tools.url,
        headers: tools.headers,
        alwaysLoad: true,
      },
    },
    // The tools ask the user themselves before changing a mailbox.
    allowedTools: [`${OTTER_TOOL_PREFIX}*`],
    canUseTool,
    stderr: (line: string) => {
      if (/error|auth|login|keychain|credential/i.test(line))
        logger.info("agent", "claude stderr", { line: line.slice(0, 300) });
    },
  };

  Object.assign(session, {
    sessionId: id,
    query: query({ prompt: prompts, options }),
    prompts,
    turn: null,
    launchKey,
    mode,
    model: settings.model,
    idleTimer: null,
    closed: false,
    tools,
    hiddenTools: new Set(),
  } satisfies Session);
  sessions.set(id, session);

  // One pump per query: every SDK message goes to whichever turn is running.
  void (async () => {
    try {
      for await (const message of session.query) handleMessage(session, message);
      if (!session.closed) closeSession(session, "unreachable");
    } catch (error) {
      if (!session.closed) {
        logger.info("agent", "claude session ended", {
          error: String(error),
        });
        closeSession(session, "unreachable");
      }
    }
  })();
  return session;
}

// ---------------------------------------------------------------------------
// Health probe (T3's checkClaudeProviderStatus)
// ---------------------------------------------------------------------------

function claudeVersion(settings: ClaudeSettings): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBinary(settings),
      ["--version"],
      {
        timeout: VERSION_TIMEOUT_MS,
        env: claudeEnv(settings) as NodeJS.ProcessEnv,
      },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve(`${stdout}${stderr}`.match(/\d+\.\d+\.\d+/)?.[0] ?? "");
      },
    );
  });
}

/** "Claude Max" / "Claude API Key" / "Amazon Bedrock", as T3 labels auth. */
function authLabel(account: {
  subscriptionType?: string;
  tokenSource?: string;
  apiProvider?: string;
}): string | undefined {
  const token = account.tokenSource?.toLowerCase().replace(/[\s_-]+/g, "");
  if (token === "apikey" || token === "anthropicapikey" || token === "anthropicauthtoken")
    return "Claude API Key";
  if (account.apiProvider === "bedrock") return "Amazon Bedrock";
  if (account.apiProvider === "vertex") return "Google Vertex";
  const plan = account.subscriptionType?.trim();
  if (!plan) return undefined;
  return /^claude/i.test(plan) ? plan : `Claude ${plan}`;
}

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

type ModelInfo = {
  value: string;
  displayName: string;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
};

function modelOptions(m: ModelInfo): ProviderModelOption[] {
  const options: ProviderModelOption[] = [];
  const efforts = m.supportedEffortLevels ?? [];
  if (efforts.length > 0) {
    options.push({
      id: "reasoningEffort",
      label: "Reasoning",
      choices: [
        {
          id: "",
          label: "Default",
          description: "Claude Code's effort for this model",
          isDefault: true,
        },
        ...efforts.map((e) => ({ id: e, label: EFFORT_LABELS[e] ?? e })),
      ],
    });
  }
  if (m.supportsFastMode) {
    options.push({
      id: "serviceTier",
      label: "Fast Mode",
      choices: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "fast",
          label: "Fast",
          description: "Faster output, increased usage",
        },
      ],
    });
  }
  return options;
}

type ProbeResult = {
  models: ProviderModel[];
  skills: Skill[];
  auth: ReturnType<typeof authLabel>;
  email?: string;
};

/** A query whose prompt never yields: initialization only, no API request. */
async function probe(settings: ClaudeSettings): Promise<ProbeResult> {
  const abort = new AbortController();
  const q = query({
    // A prompt that never yields: the probe sends no API request.
    prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
      await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
      yield* [];
    })(),
    options: {
      persistSession: false,
      pathToClaudeCodeExecutable: claudeBinary(settings),
      abortController: abort,
      settingSources: ["user", "project", "local"],
      // No hooks, tools or MCP servers for a health check.
      settings: { disableAllHooks: true },
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      env: {
        ...claudeEnv(settings),
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      },
      cwd: await agentWorkspace(),
      stderr: () => {},
    },
  });
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const init = await q.initializationResult();
    const models = (init.models as ModelInfo[]).map((m) => ({
      slug: m.value,
      name: m.displayName,
      ...(m.value === "default" ? { isDefault: true } : {}),
      options: modelOptions(m),
    }));
    const skills = (init.commands ?? []).map((c: { name: string; description?: string }) => ({
      name: c.name,
      description: c.description ?? "",
      category: null,
    }));
    return {
      models,
      skills,
      auth: authLabel(init.account ?? {}),
      email: init.account?.email,
    };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

let knownSkills: Skill[] = [];

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const claudeProvider: ChatProvider = {
  kind: "claude",
  displayName: "Claude",

  async checkStatus(settings) {
    const base = {
      kind: "claude" as const,
      displayName: "Claude",
      models: [] as ProviderModel[],
      model: settings.claude.model || null,
      sessions: true,
    };
    await ensureShellPath();
    let version: string;
    try {
      version = await claudeVersion(settings.claude);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return {
        ...base,
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Claude Code CLI (\`${claudeBinary(settings.claude)}\`) was not found. Install it or set the binary path.`
          : "Claude Code CLI is installed but failed to run.",
      };
    }
    try {
      const result = await probe(settings.claude);
      knownSkills = result.skills;
      return {
        ...base,
        installed: true,
        version: version || null,
        status: "ready",
        models: result.models,
        auth: {
          status: "authenticated",
          ...(result.auth ? { label: result.auth } : {}),
          ...(result.email ? { email: result.email } : {}),
        },
      };
    } catch (error) {
      logger.info("agent", "claude probe failed", { error: String(error) });
      return {
        ...base,
        installed: true,
        version: version || null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication. Run `claude` and log in.",
      };
    }
  },

  async sendTurn(turn, settings, emit) {
    const { requestId } = turn;
    let session: Session;
    try {
      session = await openSession(settings.claude, turn.sessionId);
    } catch (error) {
      logger.info("agent", "claude session failed", {
        error: String(error),
      });
      return emit({ requestId, type: "error", message: "not_installed" });
    }
    if (session.sessionId !== turn.sessionId)
      emit({ requestId, type: "session", sessionId: session.sessionId });
    if (session.idleTimer) clearTimeout(session.idleTimer);

    // Mode and model apply to a live query; effort/fast reopen it (launchKey).
    if (session.mode !== settings.claude.runtimeMode) {
      session.mode = settings.claude.runtimeMode;
      await session.query.setPermissionMode(permissionMode(session.mode)).catch(() => {});
    }
    if (session.model !== settings.claude.model) {
      session.model = settings.claude.model;
      await session.query.setModel(session.model || undefined).catch(() => {});
    }

    const finished = new Promise<void>((resolve) => {
      session.turn = {
        requestId,
        emit,
        streamedText: false,
        approvals: new Map(),
        steers: 0,
        settle: null,
        finish: resolve,
      };
    });
    turnsByRequest.set(requestId, session);
    // Slash commands (skills) expand when the text starts with them.
    const text = turn.skill
      ? `/${turn.skill.name}${turn.input ? ` ${turn.input}` : ""}`
      : turn.input;
    // Otter Code: images as base64 blocks, then the text with every
    // attachment's path (Claude reads documents itself). Text last so a
    // /skill command still expands.
    const attached = turn.attachments ?? [];
    const images = await Promise.all(
      attached
        .filter((a) => a.kind === "image" && CLAUDE_IMAGE_TYPES.has(a.mime))
        .map(async (a) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: a.mime,
            data: (await fs.readFile(attachmentPath(a))).toString("base64"),
          },
        })),
    );

    session.prompts.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [...images, { type: "text", text: withAttachmentPaths(text, attached) }],
      },
    } as SDKUserMessage);
    try {
      await finished;
    } finally {
      turnsByRequest.delete(requestId);
      if (session.turn?.requestId === requestId) session.turn = null;
      if (!session.closed) armIdle(session);
    }
  },

  /** T3: a message sent while a turn runs joins the live agent loop. */
  async steer(requestId, input) {
    const session = turnsByRequest.get(requestId);
    if (!session || session.closed || session.turn?.requestId !== requestId) return false;
    session.turn.steers += 1;
    // Otter Code: "now" makes Claude pick the steer up mid-stream.
    session.prompts.push({
      type: "user",
      priority: "now",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: input }] },
    } as SDKUserMessage);
    return true;
  },

  /** T3: stop is a hard boundary — close the query; the next turn resumes by id. */
  cancel(requestId) {
    const session = turnsByRequest.get(requestId);
    if (session) closeSession(session);
  },

  async respondApproval(requestId, approvalId, decision) {
    turnsByRequest.get(requestId)?.turn?.approvals.get(approvalId)?.resolve(decision);
  },

  async listSkills() {
    return knownSkills;
  },

  async listSessions(_settings, limit): Promise<ChatSession[]> {
    const sessionsInfo = await sdkListSessions({
      dir: await agentWorkspace(),
      limit,
    });
    return sessionsInfo.map((s) => ({
      id: s.sessionId,
      title: s.customTitle ?? (s.summary || null),
      source: "claude",
      lastActive: s.lastModified,
      messageCount: 1,
      preview: s.firstPrompt ?? null,
    }));
  },

  async readSession(_settings, sessionId): Promise<ChatSessionMessage[]> {
    const messages = await getSessionMessages(sessionId, {
      dir: await agentWorkspace(),
    });
    const out: ChatSessionMessage[] = [];
    const hidden = new Set<string>();
    for (const m of messages) {
      if (m.parent_tool_use_id) continue;
      const content = (m.message as { content?: unknown })?.content;
      const blocks =
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : Array.isArray(content)
            ? content
            : [];
      for (const block of blocks as {
        type?: string;
        id?: string;
        tool_use_id?: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
        content?: unknown;
      }[]) {
        if (m.type === "user" && block.type === "text" && block.text)
          out.push({ role: "user", text: block.text });
        else if (m.type === "user" && block.type === "tool_result") {
          if (block.tool_use_id && hidden.has(block.tool_use_id)) continue;
          out.push({ role: "tool", text: resultText(block.content).slice(0, TOOL_OUTPUT_CHARS) });
        } else if (m.type === "assistant" && block.type === "text" && block.text)
          out.push({ role: "assistant", text: block.text });
        else if (m.type === "assistant" && block.type === "tool_use" && block.name) {
          const step = claudeStep(block.name, block.input ?? {});
          if (step) out.push({ role: "assistant", text: "", toolCalls: [step] });
          else if (block.id) hidden.add(block.id);
        }
      }
    }
    return out;
  },

  async deleteSession(_settings, sessionId) {
    const live = sessions.get(sessionId);
    if (live) closeSession(live);
    await sdkDeleteSession(sessionId, { dir: await agentWorkspace() });
  },

  shutdown() {
    for (const session of sessions.values()) closeSession(session);
  },
};
