/**
 * Gmail's live mail, end to end inside core: startCore on a Node platform, a
 * pretend relay (its HTTP routes, and the `/v1/events` WebSocket) and a
 * pretend Gmail answering the calls a sync and `users.watch` make. What it
 * locks in is how Gmail behaved before IMAP arrived: a relay `mail` event
 * syncs that account at once as a push, watches cover the linked, signed-in
 * Gmail accounts, pushed accounts skip timer ticks, and an IMAP mailbox's
 * IDLE watch next to them changes none of that.
 */

import { DatabaseSync } from "node:sqlite";

import type { RelayAccount, RelayEvent } from "@otter-mail/contracts/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Platform, SqlDatabase } from "../../platform.ts";
import type { GmailAccount } from "../../types.ts";

const GMAIL = "gmail.googleapis.com";
const RELAY = "http://relay.test";
const TOPIC = "projects/test/topics/gmail-push";

const gmail: GmailAccount = { id: "Live@Gmail.test", email: "Live@Gmail.test", name: "Live" };
const signedOut: GmailAccount = { id: "out@gmail.test", email: "out@gmail.test", name: "Out" };
const imapSettings = {
  username: "me@fastmail.test",
  imap: { host: "imap.fastmail.test", port: 993, security: "tls" as const },
  smtp: { host: "smtp.fastmail.test", port: 465, security: "tls" as const },
};
const imap: GmailAccount = {
  id: "me@fastmail.test",
  email: "me@fastmail.test",
  name: "Fastmail",
  provider: "imap",
  imap: imapSettings,
};

const relayAccount = (account: GmailAccount): RelayAccount => ({
  email: account.email.toLowerCase(),
  provider: account.provider ?? "gmail",
  imap: account.imap ?? null,
  name: account.name,
  picture: null,
  displayName: null,
  color: null,
});

// ── The relay's event stream ────────────────────────────────────────────────

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(): void {}

  close(code = 1000): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.emit("close", { code });
  }

  // What the relay does:
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }

  event(event: RelayEvent): void {
    this.emit("message", { data: JSON.stringify(event) });
  }
}

const socket = () => FakeSocket.all.at(-1)!;

// ── The relay's HTTP API and Gmail ──────────────────────────────────────────

type Call = { method: string; host: string; path: string; account: string | null; body?: unknown };

let calls: Call[];
let relayAccounts: RelayAccount[];
/** A Gmail history call waits on this while it's set (a sync still running). */
let historyGate: Promise<void> | null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  const method = init?.method ?? "GET";
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  const account = auth.startsWith("Bearer gmail:") ? auth.slice("Bearer gmail:".length) : null;
  calls.push({
    method,
    host: url.host,
    path: url.pathname,
    account,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });

  if (url.origin === RELAY) {
    const route = `${method} ${url.pathname}`;
    if (route === "GET /v1/me") {
      return json({
        user: { id: "u1", email: "me@otter.test", name: null, picture: null },
        pushTopic: TOPIC,
      });
    }
    if (route === "GET /v1/accounts") return json({ accounts: relayAccounts });
    if (route === "GET /v1/preferences") return json({ preferences: {}, hermesKey: null });
    if (method === "PUT" || method === "DELETE") return new Response(null, { status: 204 });
    return json({ error: "not found" }, 404);
  }

  if (url.host === GMAIL) {
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    if (path === "/watch") {
      return json({ historyId: "100", expiration: String(Date.now() + 7 * 24 * 60 * 60_000) });
    }
    if (path === "/history") {
      if (historyGate) await historyGate;
      return json({ historyId: "101" });
    }
    if (path === "/labels") return json({ labels: [] });
    if (path === "/drafts") return json({ drafts: [] });
    if (path === "/settings/sendAs") return json({ sendAs: [] });
  }
  return json({ error: { message: "not in this test" } }, 404);
}

const gmailCalls = (path: string, account?: string) =>
  calls.filter(
    (c) =>
      c.host === GMAIL && c.path.endsWith(path) && (account === undefined || c.account === account),
  );
const relayCalls = (route: string) =>
  calls.filter((c) => c.host === "relay.test" && `${c.method} ${c.path}` === route);

// ── Core on Node ────────────────────────────────────────────────────────────

let broadcasts: { channel: string; params?: unknown }[];
let imapWatch: { accountId: string; onChange: () => void; stopped: boolean } | null;
let imapSyncs: string[];

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Lets pending work (a sync's promise chain) run; what it didn't start by then, it won't. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/**
 * Starts core fresh (module state and all) the way the apps do, signed in to
 * the Otter account, with a linked Gmail account signed in on this device, a
 * linked Gmail account signed out, and a linked IMAP mailbox with its
 * password. The IMAP provider's sync and IDLE are stood in for.
 */
async function boot() {
  vi.resetModules();
  const { setPlatform } = await import("../../platform.ts");
  const { startCore } = await import("../../index.ts");
  const mailSync = await import("../mail-sync.ts");
  const mailStore = await import("../mail-store.ts");
  const { imapProvider } = await import("../../providers/imap/index.ts");

  imapProvider.sync = async (accountId) => {
    imapSyncs.push(accountId);
  };
  imapProvider.watch = (accountId, onChange) => {
    imapWatch = { accountId, onChange, stopped: false };
    const watch = imapWatch;
    return () => {
      watch.stopped = true;
    };
  };

  const files = new Map<string, Uint8Array>([
    ["accounts.json", new TextEncoder().encode(JSON.stringify([gmail, signedOut, imap]))],
  ]);
  const secrets = new Map<string, string>([
    [
      "otter-session",
      JSON.stringify({ token: "otter-token", user: { id: "u1", email: "me@otter.test" } }),
    ],
    [`imap-password:${imap.id}`, "secret"],
  ]);
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  const unused = () => {
    throw new Error("Not in this test.");
  };
  const platform: Platform = {
    kind: "desktop",
    appVersion: "test",
    log: () => {},
    database: () => database,
    files: {
      read: async (path) => files.get(path) ?? null,
      write: async (path, data) => {
        files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
      },
      remove: async (path) => {
        files.delete(path);
      },
      list: async () => [],
    },
    secrets: {
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => {
        secrets.delete(name);
      },
    },
    userFiles: { open: unused, save: unused, pick: unused },
    google: {
      load: async () => {},
      addAccount: unused,
      cancelSignIn: () => {},
      isSignedIn: (accountId) => accountId === gmail.id,
      getAccessToken: async (accountId) => `gmail:${accountId}`,
      getIdToken: unused,
      removeTokens: async () => {},
    },
    connect: unused,
    relayUrl: RELAY,
    relaySession: "bearer",
    broadcast: (channel, params) => broadcasts.push({ channel, params }),
    notify: () => {},
    setUnreadCount: () => {},
    onResume: () => () => {},
    asyncContext: () => {
      let current: unknown;
      return {
        run: (value, fn) => {
          const before = current;
          current = value;
          try {
            return fn();
          } finally {
            current = before;
          }
        },
        get: () => current as never,
      };
    },
    offlineDownloads: false,
  };

  // The Gmail account synced before: its next runs replay the history feed.
  setPlatform(platform);
  mailStore.setSyncState(gmail.id, { fullSyncDone: true, historyId: "50" });
  mailStore.setKv(`spamTrashBackfilled:${gmail.id}`, "1");
  // Linked on an earlier run.
  mailStore.setKv(
    "otter:linkedAccounts",
    JSON.stringify([gmail, signedOut, imap].map((a) => a.email.toLowerCase())),
  );

  await startCore(platform);
  mailSync.configureAutoSync(0);
  return { mailSync, mailStore };
}

/** Connects the event stream and waits for what connecting starts to finish. */
async function goLive(): Promise<void> {
  await until(() => FakeSocket.all.length > 0, "the event stream");
  socket().open();
  await until(() => gmailCalls("/watch").length > 0, "the watch");
  await until(() => gmailCalls("/history", gmail.id).length >= 2, "the catch-up sync");
  await settle();
}

beforeEach(() => {
  calls = [];
  broadcasts = [];
  imapWatch = null;
  imapSyncs = [];
  historyGate = null;
  relayAccounts = [gmail, signedOut, imap].map(relayAccount);
  FakeSocket.all = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(async () => {
  const { stopRealtime } = await import("../realtime.ts");
  stopRealtime();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Gmail realtime", () => {
  it("opens the event stream with the session, and reports it live", async () => {
    await boot();
    await goLive();
    expect(socket().url).toBe("ws://relay.test/v1/events");
    const states = broadcasts
      .filter((b) => b.channel === "otter:state")
      .map((b) => (b.params as { realtime: string }).realtime);
    expect(states.at(-1)).toBe("live");
    // Connecting catches up: the linked accounts, the preferences, and every mailbox.
    expect(relayCalls("GET /v1/me").length).toBeGreaterThan(0);
    expect(relayCalls("GET /v1/accounts").length).toBeGreaterThan(0);
    expect(relayCalls("GET /v1/preferences").length).toBeGreaterThan(0);
  });

  it("watches exactly the linked, signed-in Gmail accounts, once a day", async () => {
    await boot();
    await goLive();
    expect(gmailCalls("/watch").map((c) => c.account)).toEqual([gmail.id]);

    // Within the day, a refresh reuses the watch.
    socket().event({ type: "accounts" });
    await until(() => relayCalls("GET /v1/accounts").length >= 2, "the refresh");
    await settle();
    expect(gmailCalls("/watch")).toHaveLength(1);

    // A day later it's renewed.
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    socket().event({ type: "accounts" });
    await until(() => gmailCalls("/watch").length === 2, "the renewal");
    expect(gmailCalls("/watch").map((c) => c.account)).toEqual([gmail.id, gmail.id]);
  });

  it("syncs the account a mail event names, at once, as a push", async () => {
    await boot();
    await goLive();
    const before = gmailCalls("/history", gmail.id).length;
    const started = broadcasts.filter((b) => b.channel === "gmail:sync-started").length;
    const imapBefore = imapSyncs.length;

    // The relay sends the address lower-cased; the account keeps its own case.
    socket().event({ type: "mail", email: "live@gmail.test", historyId: "101" });
    await until(() => gmailCalls("/history", gmail.id).length === before + 1, "the push sync");
    expect(broadcasts.filter((b) => b.channel === "gmail:sync-started").length).toBe(started + 1);
    await settle();
    expect(imapSyncs.length).toBe(imapBefore);

    // Even right after a sync (no read-path cooldown for pushes).
    socket().event({ type: "mail", email: "live@gmail.test", historyId: "102" });
    await until(() => gmailCalls("/history", gmail.id).length === before + 2, "the next push");

    // A mailbox this device doesn't have is ignored.
    socket().event({ type: "mail", email: "elsewhere@gmail.test", historyId: "1" });
    await settle();
    expect(gmailCalls("/history").length).toBe(before + 2);
  });

  it("runs once more after the running sync when pushes arrive during it", async () => {
    await boot();
    await goLive();
    const before = gmailCalls("/history", gmail.id).length;
    let release!: () => void;
    historyGate = new Promise((resolve) => (release = resolve));

    socket().event({ type: "mail", email: "live@gmail.test", historyId: "101" });
    await until(() => gmailCalls("/history", gmail.id).length === before + 1, "the push sync");
    socket().event({ type: "mail", email: "live@gmail.test", historyId: "102" });
    socket().event({ type: "mail", email: "live@gmail.test", historyId: "103" });
    await settle();
    expect(gmailCalls("/history", gmail.id).length).toBe(before + 1);

    historyGate = null;
    release();
    await until(() => gmailCalls("/history", gmail.id).length === before + 2, "the rerun");
    await settle();
    expect(gmailCalls("/history", gmail.id).length).toBe(before + 2);
  });

  it("leaves pushed Gmail accounts to their pushes on timer ticks, with an IMAP watch alongside", async () => {
    const { mailSync } = await boot();
    await goLive();
    await until(() => imapWatch !== null, "the IMAP watch");
    const history = () => gmailCalls("/history", gmail.id).length;
    const before = history();

    // IDLE reports: the IMAP mailbox syncs as a push, and counts as pushed too.
    imapWatch!.onChange();
    await until(() => imapSyncs.length >= 2, "the IMAP push sync");
    await settle();

    // A tick soon after: neither is polled (the Gmail account is still pushed).
    const imapBefore = imapSyncs.length;
    void mailSync.syncAllAccounts({ force: true, trigger: "timer" });
    await settle();
    expect(history()).toBe(before);
    expect(imapSyncs.length).toBe(imapBefore);

    // A refresh sets the Gmail pushed set again; the IMAP watch still counts.
    socket().event({ type: "accounts" });
    await until(() => relayCalls("GET /v1/accounts").length >= 2, "the refresh");
    await settle();
    void mailSync.syncAllAccounts({ force: true, trigger: "timer" });
    await settle();
    expect(history()).toBe(before);
    expect(imapSyncs.length).toBe(imapBefore);

    // Five minutes on, the timer checks on both in case a push got lost.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    void mailSync.syncAllAccounts({ force: true, trigger: "timer" });
    await until(() => history() === before + 1, "the fallback poll");
    await until(() => imapSyncs.length === imapBefore + 1, "the IMAP fallback poll");
  });

  it("polls Gmail on every tick again once the event stream drops", async () => {
    const { mailSync } = await boot();
    await goLive();
    await until(() => imapWatch !== null, "the IMAP watch");
    imapWatch!.onChange();
    await until(() => imapSyncs.length >= 2, "the IMAP push sync");
    await settle();
    const before = gmailCalls("/history", gmail.id).length;
    const imapBefore = imapSyncs.length;

    socket().close(1006);
    await settle();
    const states = broadcasts
      .filter((b) => b.channel === "otter:state")
      .map((b) => (b.params as { realtime: string }).realtime);
    expect(states.at(-1)).toBe("connecting");

    void mailSync.syncAllAccounts({ force: true, trigger: "timer" });
    await until(() => gmailCalls("/history", gmail.id).length === before + 1, "the poll");
    // IDLE doesn't go through the relay: the IMAP mailbox is still pushed.
    await settle();
    expect(imapSyncs.length).toBe(imapBefore);
  });

  it("refreshes the linked accounts and pulls preferences when the relay says they changed", async () => {
    await boot();
    await goLive();
    const accounts = relayCalls("GET /v1/accounts").length;
    const preferences = relayCalls("GET /v1/preferences").length;

    // Linked on another device: it arrives here, signed out.
    const added: GmailAccount = { id: "new@gmail.test", email: "new@gmail.test", name: "New" };
    relayAccounts = [...relayAccounts, relayAccount(added)];
    const changed = broadcasts.filter((b) => b.channel === "gmail:accounts-changed").length;
    socket().event({ type: "accounts" });
    await until(() => relayCalls("GET /v1/accounts").length === accounts + 1, "the refresh");
    await until(
      () => broadcasts.filter((b) => b.channel === "gmail:accounts-changed").length > changed,
      "accounts-changed",
    );

    socket().event({ type: "preferences" });
    await until(() => relayCalls("GET /v1/preferences").length === preferences + 1, "the pull");
  });
});
