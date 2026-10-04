import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OpenRouterEvent, OpenRouterTurn } from "@otter-mail/contracts/openrouter";
import { OpenRouterAgentServer, type AgentStorage } from "./server.js";

const KEY = "sk-or-test-server-only-key";
const MODEL = "test/tool-model";

function storage(): AgentStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(name) {
      return files.get(name) ?? null;
    },
    async write(name, text) {
      files.set(name, text);
    },
    async remove(name) {
      files.delete(name);
    },
    async list(prefix) {
      return [...files.keys()].filter((name) => name.startsWith(prefix));
    },
  };
}

function completion(delta: Record<string, unknown>, finish = "stop"): Response {
  const chunk = (value: unknown, reason: string | null) => ({
    id: "completion-test",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta: value, finish_reason: reason }],
  });
  return new Response(
    [chunk(delta, null), chunk({}, finish)].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function turn(patch: Partial<OpenRouterTurn> = {}): OpenRouterTurn {
  return {
    requestId: crypto.randomUUID(),
    input: "Summarize my inbox",
    model: MODEL,
    tools: [],
    ...patch,
  };
}

describe("the server OpenRouter agent", () => {
  let files: ReturnType<typeof storage>;
  let server: OpenRouterAgentServer;
  let responses: Response[];
  let requests: Record<string, unknown>[];
  let fetcher: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    files = storage();
    server = new OpenRouterAgentServer(files);
    responses = [];
    requests = [];
    fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
      if (input.endsWith("/key")) return Response.json({ data: { label: "test", limit: null } });
      if (input.endsWith("/models/user"))
        return Response.json({
          data: [
            {
              id: MODEL,
              name: "Tools model",
              supported_parameters: ["tools"],
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
            },
            { id: "test/no-tools", name: "No tools", supported_parameters: [] },
          ],
        });
      expect(input).toBe("https://openrouter.ai/api/v1/chat/completions");
      requests.push(JSON.parse(init!.body as string));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model call");
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    server.disconnectRuns();
    vi.unstubAllGlobals();
  });

  it("keeps the validated key on the server and reports only tool-capable models", async () => {
    expect(await server.connection()).toEqual({ connected: false, models: [] });
    const response = await server.fetch(
      new Request("https://relay/v1/agent/connection", {
        method: "PUT",
        body: JSON.stringify({ apiKey: KEY }),
      }),
      "device-a",
    );
    const connection = await response.text();
    expect(connection).not.toContain(KEY);
    expect(JSON.parse(connection).models.map((m: { slug: string }) => m.slug)).toEqual([MODEL]);
    expect(files.files.get("api-key")).toBe(KEY);
    const calls = fetcher.mock.calls.length;
    await server.connection();
    expect(fetcher.mock.calls).toHaveLength(calls);
  });

  it("keeps the old working key when its replacement is rejected", async () => {
    await server.connect(KEY);
    fetcher.mockImplementation(async () => new Response(null, { status: 401 }));
    await expect(server.connect("sk-or-invalid-replacement")).rejects.toThrow("rejected");
    expect(files.files.get("api-key")).toBe(KEY);
  });

  it("runs real SDK tool steps on the server, bridges a tool to the initiating device, and resumes on another device", async () => {
    await server.connect(KEY);
    responses.push(
      completion(
        {
          tool_calls: [
            {
              index: 0,
              id: "mail-call",
              type: "function",
              function: { name: "list_threads", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      ),
    );
    responses.push(completion({ content: "You have one unread message." }));
    const events: OpenRouterEvent[] = [];
    const input = turn({
      tools: [
        {
          name: "list_threads",
          title: "List conversations",
          description: "List inbox mail",
          input: { type: "object", properties: {} },
        },
      ],
    });
    await server.turn(input, "device-a", (event) => {
      events.push(event);
      if (event.type === "toolRequest") {
        expect(() =>
          server.answer(input.requestId, event.id, "device-b", {
            text: "Wrong device",
            isError: false,
          }),
        ).toThrow();
        server.answer(input.requestId, event.id, "device-a", {
          text: '{"subject":"Hello","unread":true}',
          isError: false,
        });
      }
    });
    expect(events.at(-1)?.type).toBe("done");
    expect(
      events
        .filter((e) => e.type === "delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("You have one unread message.");
    expect(
      requests.every(
        (request) => (request.provider as { data_collection: string }).data_collection === "deny",
      ),
    ).toBe(true);
    expect(JSON.stringify(requests[1])).toContain("Hello");
    expect(JSON.stringify(requests)).not.toContain(KEY);
    const sessionID = (events.find((e) => e.type === "session") as { sessionId: string }).sessionId;
    expect(await server.messages(sessionID)).toContainEqual({
      role: "tool",
      text: '{"subject":"Hello","unread":true}',
      toolName: "list_threads",
    });
    // A fresh server instance reads shared history rather than a device's local conversation.
    const resumed = new OpenRouterAgentServer(files);
    responses.push(completion({ content: "The subject was Hello." }));
    await resumed.turn(
      turn({ sessionId: sessionID, input: "What was its subject?" }),
      "device-b",
      () => {},
    );
    expect(JSON.stringify(requests[2])).toContain("You have one unread message.");
    expect(await resumed.sessions()).toMatchObject([{ id: sessionID, messageCount: 2 }]);
  });

  it("can stop while waiting for approval without accepting a late tool result", async () => {
    await server.connect(KEY);
    responses.push(
      completion(
        {
          tool_calls: [
            {
              index: 0,
              id: "send-call",
              type: "function",
              function: { name: "send_email", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      ),
    );
    const input = turn({
      tools: [
        {
          name: "send_email",
          title: "Send email",
          description: "Send after approval",
          input: { type: "object", properties: {} },
        },
      ],
    });
    const events: OpenRouterEvent[] = [];
    await server.turn(input, "device-a", (event) => {
      events.push(event);
      if (event.type === "toolRequest") {
        server.cancel(input.requestId, "device-b");
        server.cancel(input.requestId, "device-a");
      }
    });
    expect(events.at(-1)).toMatchObject({ type: "error", message: "cancelled" });
    expect(() =>
      server.answer(input.requestId, "send-call", "device-a", { text: "sent", isError: false }),
    ).toThrow();
    expect(requests).toHaveLength(1);
  });

  it("does not expose another account's chats", async () => {
    await server.connect(KEY);
    responses.push(completion({ content: "Private answer" }));
    await server.turn(turn(), "device-a", () => {});
    const other = new OpenRouterAgentServer(storage());
    expect(await other.sessions()).toEqual([]);
    const [session] = await server.sessions();
    expect(await other.messages(session.id)).toEqual([]);
    await server.deleteSession(session.id);
    expect(await server.sessions()).toEqual([]);
  });

  it("sends supported attachments to the model and rejects an unavailable model before calling it", async () => {
    await server.connect(KEY);
    responses.push(completion({ content: "The document says hello." }));
    await server.turn(
      turn({ attachments: [{ name: "note.txt", mime: "text/plain", data: btoa("hello") }] }),
      "device-a",
      () => {},
    );
    expect(JSON.stringify(requests[0])).toContain("Attached note.txt:\\nhello");
    const events: OpenRouterEvent[] = [];
    await server.turn(turn({ model: "unknown/model" }), "device-a", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("available OpenRouter model"),
    });
    expect(requests).toHaveLength(1);
  });

  it("reads text tool attachments as model text rather than unsupported binary file parts", async () => {
    await server.connect(KEY);
    responses.push(
      completion(
        {
          tool_calls: [
            {
              index: 0,
              id: "file-call",
              type: "function",
              function: { name: "get_attachment", arguments: "{}" },
            },
          ],
        },
        "tool_calls",
      ),
    );
    responses.push(completion({ content: "The invoice total is 42." }));
    const input = turn({
      tools: [
        {
          name: "get_attachment",
          title: "Read attachment",
          description: "Read a file",
          input: { type: "object", properties: {} },
        },
      ],
    });
    await server.turn(input, "device-a", (event) => {
      if (event.type === "toolRequest")
        server.answer(input.requestId, event.id, "device-a", {
          text: "invoice.json",
          isError: false,
          file: { name: "invoice.json", mime: "application/json", data: btoa('{"total":42}') },
        });
    });
    expect(JSON.stringify(requests[1])).toContain("total");
    expect(JSON.stringify(requests[1])).not.toContain("file_data");
  });

  it("reports credits and truncated responses as failures", async () => {
    await server.connect(KEY);
    responses.push(
      new Response('{"error":{"message":"Credits exhausted","code":402}}', {
        status: 402,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const events: OpenRouterEvent[] = [];
    await server.turn(turn(), "device-a", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("credits"),
    });
    responses.push(completion({ content: "Partial" }, "length"));
    await server.turn(turn(), "device-a", (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("interrupted"),
    });
  });
});
