import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChatEvent, ProviderSettings } from "./types.js";

vi.mock("./settings.js", () => ({ getHermesKey: async () => "test-key" }));
const { hermesProvider } = await import("./hermes.js");
const settings = {
  hermes: {
    baseUrl: "https://hermes.test/v1",
    agentModel: "hermes",
    sessions: true,
    model: "",
    reasoningEffort: "",
    serviceTier: "",
  },
} as ProviderSettings;

afterEach(() => {
  hermesProvider.shutdown();
  vi.unstubAllGlobals();
});

function replies(events: ChatEvent[]): string[] {
  const text = new Map<string, string>();
  for (const event of events) {
    if (event.type === "delta") text.set(event.id!, (text.get(event.id!) ?? "") + event.text);
    else if (event.type === "text") text.set(event.id, event.text);
  }
  return [...text.values()];
}

async function run(frames: [string, Record<string, unknown>][], sessionId?: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          frames
            .map(([event, payload]) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
            .join(""),
        ),
    ),
  );
  const events: ChatEvent[] = [];
  await hermesProvider.sendTurn(
    {
      requestId: "run",
      input: "Check",
      sessionId,
      previousResponseId: sessionId ? undefined : "legacy",
    },
    settings,
    (event) => events.push(event),
  );
  expect(events.at(-1)?.type).toBe("done");
  return replies(events);
}

describe("Hermes replies", () => {
  it("keeps commentary when the final reply has no deltas", async () => {
    expect(
      await run(
        [
          ["assistant.commentary", { text: "I'll check." }],
          ["tool.started", { tool_name: "browser" }],
          ["tool.completed", { tool_name: "browser" }],
          ["assistant.completed", { content: "Done." }],
          ["run.completed", {}],
        ],
        "session",
      ),
    ).toEqual(["I'll check.", "Done."]);
  });

  it("backfills a resolved image without duplicating streamed commentary or the final reply", async () => {
    expect(
      await run(
        [
          ["assistant.delta", { delta: "I'll check." }],
          ["assistant.commentary", { text: "I'll check.", already_streamed: true }],
          ["tool.started", { tool_name: "browser" }],
          ["assistant.delta", { delta: "Done.\nMEDIA:/tmp/image.png" }],
          ["assistant.completed", { content: "Done.\n![image](data:image/png;base64,aGVsbG8=)" }],
          ["run.completed", {}],
        ],
        "session",
      ),
    ).toEqual(["I'll check.", "Done.\n![image](data:image/png;base64,aGVsbG8=)"]);
  });

  it("preserves completed commentary items in legacy Responses chats", async () => {
    expect(
      await run([
        [
          "",
          {
            type: "response.output_item.added",
            item: {
              id: "intro",
              type: "message",
              phase: "commentary",
              content: [{ type: "output_text", text: "I'll check." }],
            },
          },
        ],
        [
          "",
          {
            type: "response.output_item.done",
            item: {
              id: "intro",
              type: "message",
              content: [{ type: "output_text", text: "I'll check." }],
            },
          },
        ],
        [
          "",
          {
            type: "response.output_item.added",
            item: { id: "answer", type: "message", content: [] },
          },
        ],
        ["", { type: "response.output_text.delta", delta: "Done." }],
        [
          "",
          {
            type: "response.output_item.done",
            item: {
              id: "answer",
              type: "message",
              content: [{ type: "output_text", text: "Done." }],
            },
          },
        ],
        ["", { type: "response.completed", response: { id: "response" } }],
      ]),
    ).toEqual(["I'll check.", "Done."]);
  });
});
