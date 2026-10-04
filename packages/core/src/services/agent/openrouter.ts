/** Thin client for the server's AI SDK agent; it never holds the OpenRouter key. */
import type {
  OpenRouterConnection,
  OpenRouterEvent,
  OpenRouterFile,
  OpenRouterMessage,
  OpenRouterSession,
  OpenRouterToolOutput,
} from "@otter-mail/contracts/openrouter";
import { toBase64 } from "../../bytes.js";
import { platform } from "../../platform.js";
import { getOtterUser, getSessionToken } from "../otter-account.js";
import { ATTACHMENTS_DIR, readAttachment, stageAttachment } from "./attachments.js";
import {
  agentTools,
  cancelToolApprovals,
  runAgentTool,
  type ToolCaller,
  type ToolFiles,
} from "./tools/index.js";
import type { ChatProvider, Emit, ProviderSettings } from "./types.js";

/** Capture this account's authentication for an entire turn, including cancellation. */
function api() {
  const p = platform();
  if (!p.agentServerUrl && !getOtterUser())
    throw new Error("Sign in to your Otter account in Settings before connecting OpenRouter.");
  const base = p.agentServerUrl || `${p.relayUrl}/v1/agent`;
  const token = getSessionToken();
  const credentials =
    p.agentServerUrl || p.relaySession === "cookie" ? ("include" as const) : ("omit" as const);
  return async (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${base}${path}`, {
      method,
      credentials,
      signal: signal ?? AbortSignal.timeout(10_000),
      headers: {
        ...(token && !p.agentServerUrl ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        data.error ||
          (response.status === 401
            ? "Sign in to your Otter account again in Settings."
            : "Can't reach the agent server. Try again in a moment."),
      );
    }
    return response;
  };
}

export async function openRouterConnection(): Promise<OpenRouterConnection> {
  return (await api()("GET", "/connection")).json() as Promise<OpenRouterConnection>;
}

export async function connectOpenRouter(apiKey: string): Promise<void> {
  await api()("PUT", "/connection", { apiKey });
}

export async function disconnectOpenRouter(): Promise<void> {
  openRouterProvider.shutdown();
  await api()("DELETE", "/connection");
}

const files: ToolFiles = {
  async save(name, bytes) {
    return (await stageAttachment(name, "", bytes)).path;
  },
  async read(path) {
    if (
      !path.startsWith(`${ATTACHMENTS_DIR}/`) ||
      path.includes("\\") ||
      path.split("/").some((part) => part === ".." || part === ".")
    )
      throw new Error("Choose an attachment in Otter Mail first.");
    const bytes = await platform().files.read(path);
    if (!bytes || bytes.length > 50 * 1024 * 1024)
      throw new Error("This attachment is unavailable or exceeds the 50 MB limit.");
    return { name: path.split("/").at(-1) || "attachment", bytes };
  },
};

type Run = { controller: AbortController; caller: ToolCaller; cancel(): Promise<void> };
const runs = new Map<string, Run>();
const callers = new Map<string, ToolCaller>();

async function toolOutput(
  caller: ToolCaller,
  name: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<OpenRouterToolOutput> {
  const output: OpenRouterToolOutput = await runAgentTool(caller, name, input, signal);
  output.text = output.text.slice(0, 30_000);
  if (name === "get_attachment" && !output.isError) {
    const attachment = JSON.parse(output.text) as {
      path: string;
      mimeType: string;
      filename: string;
    };
    if (
      attachment.mimeType.startsWith("image/") ||
      attachment.mimeType === "application/pdf" ||
      attachment.mimeType.startsWith("text/") ||
      /(?:json|xml|rfc822)/.test(attachment.mimeType)
    ) {
      const { bytes } = await files.read(attachment.path);
      output.file = { name: attachment.filename, mime: attachment.mimeType, data: toBase64(bytes) };
    }
  }
  return output;
}

async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: OpenRouterEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data) onEvent(JSON.parse(data) as OpenRouterEvent);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const openRouterProvider: ChatProvider = {
  kind: "openrouter",
  displayName: "OpenRouter",
  async checkStatus(settings) {
    const base = {
      kind: "openrouter" as const,
      displayName: "OpenRouter",
      installed: true,
      version: null,
      models: [],
      model: settings.openrouter.model || null,
      sessions: true,
    };
    try {
      const connection = await openRouterConnection();
      return {
        ...base,
        models: connection.models,
        status: connection.connected ? "ready" : "warning",
        auth: {
          status: connection.connected ? "authenticated" : "unauthenticated",
          label: connection.connected ? "API key connected" : undefined,
        },
        message: connection.connected
          ? undefined
          : "Add your OpenRouter API key in Settings → Agents.",
      };
    } catch (error) {
      return {
        ...base,
        status: "error",
        auth: { status: "unknown" },
        message: error instanceof Error ? error.message : "Can't reach the agent server.",
      };
    }
  },
  async sendTurn(turn, settings: ProviderSettings, emit: Emit) {
    const controller = new AbortController();
    const id = turn.sessionId || turn.requestId;
    let current: { requestId: string; emit: Emit } | null = { requestId: turn.requestId, emit };
    const caller = callers.get(id) ?? {
      mode: () => settings.openrouter.runtimeMode,
      turn: () => current,
      files,
    };
    caller.mode = () => settings.openrouter.runtimeMode;
    caller.turn = () => current;
    callers.set(id, caller);
    let request: ReturnType<typeof api> | undefined;
    let terminal = false;
    let toolError: unknown;
    const tasks = new Set<Promise<void>>();
    try {
      request = api();
      const cancel = async () => {
        await request!("POST", "/cancel", { requestId: turn.requestId }).catch(() => {});
      };
      runs.set(turn.requestId, { controller, caller, cancel });
      const attachments: OpenRouterFile[] = await Promise.all(
        (turn.attachments ?? []).map(async (a) => ({
          name: a.name,
          mime: a.mime,
          data: toBase64(await readAttachment(a)),
        })),
      );
      const paths = (turn.attachments ?? [])
        .map((a) => `[Attached '${a.name}' is saved at: ${a.path}]`)
        .join("\n");
      const response = await request(
        "POST",
        "/turn",
        {
          ...turn,
          input: paths ? `${turn.input}\n\n${paths}` : turn.input,
          model: settings.openrouter.model,
          tools: agentTools(caller).map(({ name, title, description, input }) => ({
            name,
            title,
            description,
            input,
          })),
          attachments,
        },
        controller.signal,
      );
      if (!response.body) throw new Error("The agent server did not return a stream.");
      await readEvents(response.body, (event) => {
        if (event.requestId !== turn.requestId) return;
        if (event.type === "toolRequest") {
          const task = toolOutput(caller, event.name, event.input, controller.signal)
            .then((output) =>
              request!(
                "POST",
                "/tool-result",
                { requestId: turn.requestId, id: event.id, output },
                controller.signal,
              ),
            )
            .then(() => {})
            .catch((error: unknown) => {
              toolError = error;
              controller.abort();
              void cancel();
            });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        } else {
          if (event.type === "session") callers.set(event.sessionId, caller);
          if (event.type === "done" || event.type === "error") terminal = true;
          emit(event);
        }
      });
      await Promise.all(tasks);
      if (!terminal)
        throw (
          toolError ??
          new Error("The agent connection was interrupted. Send a follow-up to continue.")
        );
    } catch (error) {
      if (!terminal)
        emit({
          requestId: turn.requestId,
          type: "error",
          message:
            controller.signal.aborted && !toolError
              ? "cancelled"
              : `agent_error: ${error instanceof Error ? error.message : "Can't reach the agent server."}`,
        });
      if (request) await request("POST", "/cancel", { requestId: turn.requestId }).catch(() => {});
    } finally {
      controller.abort();
      cancelToolApprovals(caller);
      current = null;
      runs.delete(turn.requestId);
    }
  },
  cancel(requestId) {
    const run = runs.get(requestId);
    run?.controller.abort();
    if (run) {
      cancelToolApprovals(run.caller);
      void run.cancel();
    }
  },
  async steer() {
    return false;
  },
  async respondApproval() {},
  async listSkills() {
    return [];
  },
  async listSessions(_settings, limit) {
    return ((await api()("GET", "/sessions")).json() as Promise<OpenRouterSession[]>).then(
      (sessions) => sessions.slice(0, limit),
    );
  },
  async readSession(_settings, id) {
    return (await api()("GET", `/sessions/${encodeURIComponent(id)}`)).json() as Promise<
      OpenRouterMessage[]
    >;
  },
  async deleteSession(_settings, id) {
    await api()("DELETE", `/sessions/${encodeURIComponent(id)}`);
    callers.delete(id);
  },
  shutdown() {
    for (const id of runs.keys()) openRouterProvider.cancel(id);
    callers.clear();
  },
};
