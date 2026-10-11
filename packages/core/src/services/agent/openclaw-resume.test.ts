import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatEvent, ProviderSettings } from "./types.js";

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  onEvent: (_event: { event: string; payload: unknown }) => {},
}));
vi.mock("../../platform.js", () => ({
  platform: () => ({ kind: "desktop", appVersion: "test", log: () => {} }),
}));
vi.mock("./settings.js", () => ({
  clearOpenClawBootstrapToken: vi.fn(),
  clearOpenClawDeviceToken: vi.fn(),
  getOpenClawBootstrapToken: async () => "",
  getOpenClawDeviceKey: async () => "",
  getOpenClawDeviceToken: async () => "",
  getOpenClawToken: async () => "test-token",
  setOpenClawDeviceKey: vi.fn(),
  setOpenClawDeviceToken: vi.fn(),
}));
vi.mock("@openclaw/gateway-client/browser", () => ({
  GatewayBrowserDeviceAuthLifecycle: class {
    buildPlan = vi.fn();
    acceptHello = vi.fn();
  },
  GatewayProtocolClient: class {
    constructor(private options: { onHello: () => void; onEvent: typeof fixture.onEvent }) {}
    start() {
      fixture.onEvent = this.options.onEvent;
      this.options.onHello();
    }
    stop() {}
    request = fixture.request;
  },
}));
const { openClawProvider } = await import("./openclaw.js");
const settings = { openclaw: { url: "wss://gateway.test" } } as ProviderSettings;
afterEach(() => {
  openClawProvider.shutdown();
  fixture.request.mockReset();
});

const earlier = [
  { role: "user", content: "First", __openclaw: { idempotencyKey: "req-0:user" } },
  { role: "assistant", content: [{ type: "text", text: "Earlier reply." }] },
];
const sent = {
  role: "user",
  content: "Check the build",
  __openclaw: { idempotencyKey: "req-1:user" },
};
const toolCall = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: { command: "make" } }],
};
const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "exec", content: "ok" };
const reply = { role: "assistant", content: [{ type: "text", text: "The build passes." }] };

function gateway(history: () => unknown, pending: unknown[] = []) {
  fixture.request.mockImplementation(async (method: string) => {
    if (method === "chat.history") return history();
    if (method === "exec.approval.list") return pending;
    throw new Error(`unexpected ${method}`);
  });
}

async function resume(requestId: string) {
  const events: ChatEvent[] = [];
  const ended = openClawProvider.resume!({ requestId, sessionId: "s" }, settings, (event) =>
    events.push(event),
  );
  return { events, ended };
}

describe("OpenClaw runs picked up again", () => {
  it("shows a run that finished while the app was closed, from the message that started it", async () => {
    gateway(() => ({
      messages: [...earlier, sent, toolCall, toolResult, reply],
      sessionInfo: { hasActiveRun: false, activeRunIds: [] },
    }));
    const { events, ended } = await resume("req-1");
    await ended;
    expect(events).toEqual([
      {
        requestId: "req-1",
        type: "transcript",
        messages: [
          { role: "assistant", text: "", toolCalls: [expect.objectContaining({ title: "Exec" })] },
          { role: "tool", text: "ok", toolName: "exec" },
          { role: "assistant", text: "The build passes." },
        ],
      },
      { requestId: "req-1", type: "done", responseId: null },
    ]);
  });

  it("follows a run that's still going, with the approvals it asked for meanwhile", async () => {
    let done = false;
    gateway(
      () =>
        done
          ? { messages: [sent, reply], sessionInfo: { hasActiveRun: false, activeRunIds: [] } }
          : { messages: [sent], sessionInfo: { hasActiveRun: true, status: "running" } },
      [
        { id: "ap-1", request: { sessionKey: "s", command: "make deploy" } },
        { id: "ap-2", request: { sessionKey: "another", command: "ls" } },
      ],
    );
    const { events, ended } = await resume("req-1");
    await vi.waitFor(() => expect(events.some((e) => e.type === "approval")).toBe(true));
    const run = { sessionKey: "s", runId: "req-1" };
    fixture.onEvent({
      event: "chat",
      payload: {
        ...run,
        state: "delta",
        deltaText: "The build",
        message: { role: "assistant", content: [{ type: "text", text: "The build" }] },
      },
    });
    done = true;
    fixture.onEvent({ event: "chat", payload: { ...run, state: "final", message: reply } });
    await ended;
    // The final completes the text; the end reads the transcript and drops the unanswered approval.
    expect(events.map((e) => e.type)).toEqual([
      "transcript",
      "approval",
      "delta",
      "delta",
      "transcript",
      "done",
      "approvalResolved",
    ]);
    expect(events[1]).toMatchObject({ approval: { id: "ap-1", detail: "make deploy" } });
    expect(events[4]).toMatchObject({
      messages: [{ role: "assistant", text: "The build passes." }],
    });
  });

  it("says so when the message never reached the gateway", async () => {
    gateway(() => ({ messages: earlier, sessionInfo: { hasActiveRun: false } }));
    const { events, ended } = await resume("req-1");
    await ended;
    expect(events).toEqual([{ requestId: "req-1", type: "error", message: "not_received" }]);
  });
});
