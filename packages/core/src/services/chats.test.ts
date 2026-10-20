import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CHAT_LIMITS, chatForSync, type Chat, type ChatSummary } from "@otter-mail/contracts/chats";

/** The relay, as far as chats go: its chats (deleted ones without turns), and every call made to it. */
const relay = {
  chats: new Map<string, Chat & { deletedAt: number | null }>(),
  calls: [] as string[],
  /** Fails calls (the relay unreachable) while set. */
  down: false,
};

class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

vi.mock("./otter-account.js", () => ({
  RelayError,
  getOtterUser: () => ({ id: "u1", email: "me@example.com", name: null, picture: null }),
  async relayRequest(method: string, route: string, body?: Chat) {
    if (relay.down) throw new RelayError(0, "offline");
    relay.calls.push(`${method} ${route}`);
    const id = route.split("/")[3];
    if (method === "GET" && !id) {
      const chats: ChatSummary[] = [...relay.chats.values()].map(({ turns: _t, ...c }) => c);
      return { chats: structuredClone(chats) };
    }
    const chat = relay.chats.get(id);
    if (method === "GET") {
      if (!chat || chat.deletedAt) throw new RelayError(404, "No such chat.");
      const { deletedAt: _d, ...rest } = chat;
      return { chat: structuredClone(rest) };
    }
    if (method === "DELETE") {
      if (chat) relay.chats.set(id, { ...chat, turns: [], deletedAt: 2 });
      return null;
    }
    if (chat && chat.updatedAt > body!.updatedAt) throw new RelayError(409, "A later write.");
    relay.chats.set(id, { ...structuredClone(body!), deletedAt: null });
    return null;
  },
}));

const files = new Map<string, string>();
const broadcasts: unknown[] = [];
const { setPlatform } = await import("../platform.ts");
setPlatform({
  broadcast: (channel: string, params: unknown) => broadcasts.push([channel, params]),
  log: () => {},
  deviceName: "Robin's Mac",
  files: {
    read: async (name: string) =>
      files.has(name) ? new TextEncoder().encode(files.get(name)) : null,
    write: async (name: string, data: Uint8Array | string) => void files.set(name, String(data)),
  },
} as never);

const chats = await import("./chats.ts");

const chat = (id: string, patch: Partial<Chat> = {}): Chat => ({
  id,
  title: "Plan the offsite",
  provider: "openrouter",
  sessionId: null,
  sessionOwned: false,
  lastResponseId: null,
  device: null,
  createdAt: 1,
  updatedAt: 10,
  tabs: [],
  turns: [{ id: "u-1", role: "user", text: "Find a venue" }],
  ...patch,
});

/** Lets the debounced push run (short of a retry, 30 seconds on). */
async function settle() {
  await vi.advanceTimersByTimeAsync(1_000);
  await chats.listChats();
}

beforeEach(() => {
  vi.useFakeTimers();
  relay.calls = [];
  relay.down = false;
  broadcasts.length = 0;
});

describe("chats", () => {
  it("writes a saved chat to the relay, whole, and tells the windows", async () => {
    await chats.saveChat(chat("c1"));
    await settle();

    expect(relay.calls).toEqual(["PUT /v1/chats/c1"]);
    expect(relay.chats.get("c1")).toMatchObject({
      title: "Plan the offsite",
      turns: [{ id: "u-1" }],
    });
    expect(broadcasts).toEqual([["chats:changed", { ids: ["c1"] }]]);
    const { chats: listed } = await chats.listChats();
    expect(listed.find((c) => c.id === "c1")).not.toHaveProperty("turns");
  });

  it("marks a Claude or Codex chat as this device's", async () => {
    await chats.saveChat(chat("c2", { provider: "claude" }));
    await settle();

    const { device } = await chats.listChats();
    expect(device.name).toBe("Robin's Mac");
    expect(relay.chats.get("c2")?.device).toEqual(device);
    expect((await chats.getChat("c2"))?.device).toEqual(device);
  });

  it("keeps changes made offline and writes them once the relay is back", async () => {
    relay.down = true;
    await chats.saveChat(chat("c3", { updatedAt: 20 }));
    await settle();
    expect(relay.chats.has("c3")).toBe(false);

    relay.down = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(relay.chats.get("c3")?.updatedAt).toBe(20);
  });

  it("takes chats written elsewhere, and lets go of ones deleted elsewhere", async () => {
    relay.chats.set("c4", {
      ...chat("c4", { title: "From the iPhone", updatedAt: 50 }),
      deletedAt: null,
    });
    await chats.saveChat(chat("c5"));
    await settle();
    relay.chats.set("c5", { ...chat("c5"), turns: [], deletedAt: 60 });
    broadcasts.length = 0;

    await chats.pullChats();

    expect((await chats.getChat("c4"))?.title).toBe("From the iPhone");
    expect(await chats.getChat("c5")).toBeNull();
    expect(broadcasts).toEqual([["chats:changed", { ids: ["c4", "c5"] }]]);
  });

  it("keeps this device's change over the relay's older copy until it's written", async () => {
    await chats.saveChat(chat("c6", { title: "Mine", updatedAt: 100 }));
    relay.chats.set("c6", { ...chat("c6", { title: "Theirs", updatedAt: 90 }), deletedAt: null });

    await chats.pullChats();
    expect((await chats.getChat("c6"))?.title).toBe("Mine");

    await settle();
    expect(relay.chats.get("c6")?.title).toBe("Mine");
  });

  it("keeps the older turns and whole outputs the relay leaves out when another device writes", async () => {
    const long = "x".repeat(5000);
    const turns = Array.from({ length: 90 }, (_, i) => ({
      id: `t${i}`,
      role: "assistant" as const,
      text: "",
      items: [
        { kind: "step" as const, step: { kind: "tool" as const, title: "Read" }, output: long },
      ],
    }));
    await chats.saveChat(chat("c8", { turns, updatedAt: 100 }));
    await settle();
    const synced = relay.chats.get("c8")!;
    expect(synced.turns).toHaveLength(80);
    // Another device adds a turn to what the relay has.
    relay.chats.set("c8", {
      ...synced,
      updatedAt: 200,
      turns: [...synced.turns, { id: "t90", role: "user", text: "And then?" }],
    });

    await chats.pullChats();

    const here = (await chats.getChat("c8"))!;
    expect(here.turns.map((t) => t.id)).toEqual([...turns.map((t) => t.id), "t90"]);
    const step = here.turns[50].items?.[0];
    expect(step?.kind === "step" && step.output).toBe(long);
  });

  it("lets the oldest chats go everywhere past the limit", async () => {
    for (let i = 0; i < 500; i++) await chats.saveChat(chat(`old${i}`, { updatedAt: 1000 + i }));
    await chats.saveChat(chat("newest", { updatedAt: 5000 }));
    await settle();

    expect(await chats.getChat("old0")).toBeNull();
    expect(relay.calls).toContain("DELETE /v1/chats/old0");
    expect(await chats.getChat("newest")).not.toBeNull();
  });

  it("deletes on the relay what's deleted here", async () => {
    await chats.saveChat(chat("c7"));
    await settle();
    await chats.deleteChat("c7");
    await settle();

    expect(relay.calls.at(-1)).toBe("DELETE /v1/chats/c7");
    expect(relay.chats.get("c7")?.deletedAt).not.toBeNull();
  });
});

describe("chatForSync", () => {
  it("leaves out tabs the relay wouldn't keep", () => {
    const synced = chatForSync(
      chat("c9", {
        tabs: [
          {
            id: "page:a",
            title: "Short",
            ref: { kind: "page", url: "https://a.example" },
            addedAt: 1,
          },
          {
            id: "page:b",
            title: "Long",
            ref: { kind: "page", url: `https://t.example/?${"x".repeat(3000)}` },
            addedAt: 1,
          },
        ],
      }),
    );
    expect(synced.tabs.map((t) => t.title)).toEqual(["Short"]);
  });

  it("fits the relay in bytes, even a single long turn", () => {
    const items = Array.from({ length: 200 }, () => ({
      kind: "step" as const,
      step: { kind: "tool" as const, title: "Read" },
      output: "猫".repeat(3000),
    }));
    const synced = chatForSync(
      chat("c10", { turns: [{ id: "a", role: "assistant", text: "", items }] }),
    );
    expect(new TextEncoder().encode(JSON.stringify(synced)).length).toBeLessThanOrEqual(
      CHAT_LIMITS.bytes,
    );
    expect(synced.turns).toHaveLength(1);
  });
});
