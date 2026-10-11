import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatEvent, ProviderSettings } from "@otter-mail/core";

const fixture = vi.hoisted(() => ({
  claude: [] as unknown[],
  codex: [] as { method: string; params: Record<string, unknown> }[],
}));
vi.mock("@otter-mail/core", async () => ({
  ...(await import("../../../../../packages/core/src/services/agent/steps.js")),
  ...(await import("../../../../../packages/core/src/services/agent/text-stream.js")),
  dataUrl: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ logger: { info: vi.fn() } }));
vi.mock("./shell-path.js", () => ({ ensureShellPath: async () => {} }));
vi.mock("./local.js", () => ({
  agentWorkspace: async () => "/workspace",
  attachmentsDir: async () => "/attachments",
  attachmentPath: (a: { path: string }) => a.path,
  withAttachmentPaths: (text: string) => text,
  readAgentFile: vi.fn(),
}));
vi.mock("./mcp-server.js", () => ({
  MCP_SERVER_NAME: "otter-mail",
  toolAccess: async () => ({ url: "https://tools.test", headers: {}, revoke: () => {} }),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  deleteSession: vi.fn(),
  getSessionMessages: vi.fn(),
  listSessions: vi.fn(),
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) {
        for (const event of fixture.claude) yield event;
      }
    },
    close: () => {},
  }),
}));
vi.mock("./codex-app-server.js", () => ({
  CodexSpawnError: class extends Error {},
  CodexAppServer: class {
    alive = true;
    onNotification?: (event: unknown) => void;
    static async start() {
      return new this();
    }
    async request(method: string) {
      if (method === "thread/start") return { thread: { id: "thread" } };
      if (method === "turn/start") {
        for (const event of fixture.codex) this.onNotification?.(event);
        return { turn: { id: "turn" } };
      }
      return {};
    }
    kill() {
      this.alive = false;
    }
  },
}));

const { claudeProvider } = await import("./claude.js");
const { codexProvider } = await import("./codex.js");
const settings = {
  claude: {
    binaryPath: "",
    homePath: "",
    model: "",
    reasoningEffort: "",
    serviceTier: "",
    runtimeMode: "full-access",
  },
  codex: {
    binaryPath: "",
    homePath: "",
    launchArgs: "",
    model: "",
    reasoningEffort: "",
    serviceTier: "",
    runtimeMode: "full-access",
  },
} as ProviderSettings;
afterEach(() => {
  claudeProvider.shutdown();
  codexProvider.shutdown();
});

function text(events: ChatEvent[]): string[] {
  const messages = new Map<string, string>();
  for (const event of events) {
    if (event.type === "delta")
      messages.set(event.id!, (messages.get(event.id!) ?? "") + event.text);
    else if (event.type === "text") messages.set(event.id, event.text);
  }
  return [...messages.values()].filter(Boolean);
}

describe("local agent transcripts", () => {
  it("keeps Claude's streamed preamble and later complete text blocks", async () => {
    fixture.claude = [
      { type: "stream_event", event: { type: "message_start" } },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "I'll check." } },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll check." },
            { type: "tool_use", id: "tool", name: "Bash", input: { command: "pwd" } },
          ],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool", content: "/workspace" }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "private" },
            { type: "text", text: "Done." },
            { type: "text", text: "\n[View screenshot](/tmp/image.png)" },
          ],
        },
      },
      { type: "result", subtype: "success" },
    ];
    const events: ChatEvent[] = [];
    await claudeProvider.sendTurn({ requestId: "claude", input: "Check" }, settings, (event) =>
      events.push(event),
    );
    expect(text(events)).toEqual(["I'll check.", "Done.\n[View screenshot](/tmp/image.png)"]);
    expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("keeps Codex commentary when a later message is delivered without deltas", async () => {
    fixture.codex = [
      {
        method: "item/started",
        params: { item: { type: "agentMessage", id: "intro", phase: "commentary" } },
      },
      { method: "item/agentMessage/delta", params: { delta: "I'll check.", itemId: "intro" } },
      {
        method: "item/completed",
        params: { item: { type: "agentMessage", id: "intro", text: "I'll check." } },
      },
      {
        method: "item/started",
        params: { item: { type: "commandExecution", id: "tool", command: "pwd" } },
      },
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            id: "tool",
            command: "pwd",
            aggregatedOutput: "/workspace",
          },
        },
      },
      { method: "item/started", params: { item: { type: "agentMessage", id: "answer" } } },
      {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: "answer",
            text: "Done.\n[View screenshot](/tmp/image.png)",
          },
        },
      },
      { method: "turn/completed", params: { turn: { id: "turn", status: "completed" } } },
    ];
    const events: ChatEvent[] = [];
    await codexProvider.sendTurn({ requestId: "codex", input: "Check" }, settings, (event) =>
      events.push(event),
    );
    expect(text(events)).toEqual(["I'll check.", "Done.\n[View screenshot](/tmp/image.png)"]);
    expect(events.at(-1)?.type).toBe("done");
  });
});
