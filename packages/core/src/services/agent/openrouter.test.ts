import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatEvent, ProviderSettings } from "./types.js";

const state = vi.hoisted(() => ({ token: "device-session", toolTurns: [] as string[] }));
vi.mock("../../platform.ts", () => ({
  platform: () => ({ relayUrl: "https://relay.test", relaySession: "bearer" }),
}));
vi.mock("../otter-account.ts", () => ({
  getOtterUser: () => ({ id: "user" }),
  getSessionToken: () => state.token,
}));
vi.mock("./attachments.ts", () => ({
  ATTACHMENTS_DIR: "assistant-attachments",
  readAttachment: vi.fn(),
  stageAttachment: vi.fn(),
}));
vi.mock("./tools/index.ts", () => ({
  agentTools: () => [
    {
      name: "list_threads",
      title: "List conversations",
      description: "List inbox",
      input: { type: "object", properties: {} },
    },
  ],
  cancelToolApprovals: vi.fn(),
  runAgentTool: async (caller: { turn(): { requestId: string } }, name: string) => {
    expect(name).toBe("list_threads");
    state.toolTurns.push(caller.turn().requestId);
    return { text: '{"threads":[]}', isError: false };
  },
}));

const { openRouterProvider } = await import("./openrouter.js");
const settings = {
  openrouter: { model: "test/model", runtimeMode: "approval-required", enabled: true },
} as ProviderSettings;

describe("the desktop/web server agent client", () => {
  beforeEach(() => {
    state.token = "device-session";
    state.toolTurns = [];
  });
  afterEach(() => {
    openRouterProvider.shutdown();
    vi.unstubAllGlobals();
  });

  it("sends tools to the server, executes them locally and reuses the right turn when resuming", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        if (!url.endsWith("/turn")) return Response.json({ ok: true });
        const body = JSON.parse(init.body as string);
        expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["list_threads"]);
        expect(body.model).toBe("test/model");
        // Account switching must not cause the old turn's tool results to use a new session.
        state.token = "another-device-session";
        const events = [
          { type: "session", sessionId: "shared-chat" },
          { type: "toolRequest", id: "mail-call", name: "list_threads", input: {} },
          { type: "delta", text: "Your inbox is empty." },
          { type: "done", responseId: null },
        ]
          .map((e) => `data: ${JSON.stringify({ requestId: body.requestId, ...e })}\n\n`)
          .join("");
        return new Response(events, { headers: { "Content-Type": "text/event-stream" } });
      }),
    );
    const events: ChatEvent[] = [];
    await openRouterProvider.sendTurn(
      { requestId: "turn-one", input: "Check inbox" },
      settings,
      (event) => events.push(event),
    );
    const toolResult = requests.find((r) => r.url.endsWith("/tool-result"))!;
    expect(new Headers(toolResult.init.headers).get("Authorization")).toBe("Bearer device-session");
    expect(JSON.parse(toolResult.init.body as string)).toMatchObject({
      requestId: "turn-one",
      id: "mail-call",
      output: { text: '{"threads":[]}', isError: false },
    });
    expect(events.map((e) => e.type)).toEqual(["session", "delta", "done"]);
    await openRouterProvider.sendTurn(
      { requestId: "turn-two", sessionId: "shared-chat", input: "Check again" },
      settings,
      () => {},
    );
    expect(state.toolTurns).toEqual(["turn-one", "turn-two"]);
    expect(JSON.stringify(requests)).not.toContain("apiKey");
  });

  it("reports an interrupted connection instead of marking a turn complete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/turn")
          ? new Response('data: {"requestId":"turn-one","type":"delta","text":"Partial"}\n\n')
          : Response.json({ ok: true }),
      ),
    );
    const events: ChatEvent[] = [];
    await openRouterProvider.sendTurn(
      { requestId: "turn-one", input: "Check inbox" },
      settings,
      (event) => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("interrupted"),
    });
  });
});
