/**
 * Outlook, end to end inside core: startCore on a Node platform against a
 * pretend Microsoft Graph with per-folder delta queries. What it locks in: a
 * new mailbox shows its inbox first and then lists every folder; folders,
 * flags, importance and categories become labels; later syncs follow each
 * folder's delta (new mail notified, a message moved out of the inbox keeps
 * its id and loses INBOX, a deleted one leaves the cache); and label changes
 * become the right Graph writes (archive moves only what's in the inbox).
 */

import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Platform, SqlDatabase } from "../../platform.ts";
import type { GmailAccount } from "../../types.ts";

const account: GmailAccount = {
  id: "me@contoso.test",
  email: "me@contoso.test",
  name: "Me",
  provider: "outlook",
};

// ── The pretend Graph ───────────────────────────────────────────────────────

const FOLDERS = ["inbox", "archive", "sentitems", "drafts", "deleteditems", "junkemail"];

type Message = {
  id: string;
  folder: string;
  conversationId: string;
  subject: string;
  isRead: boolean;
  flagged: boolean;
  importance: "normal" | "high";
  categories: string[];
  /** Sent by the mailbox itself. */
  fromMe: boolean;
  date: number;
  /** Bumped on every change; delta links remember the last one they saw. */
  version: number;
};

let messages: Map<string, Message>;
let version: number;
/** Messages that were in each folder at each version, for `@removed`. */
let leftFolder: { id: string; folder: string; version: number }[];
let writes: { method: string; path: string; body?: unknown }[];
/** Every `$search` Graph was asked, with where. */
let searches: { path: string; search: string }[];
let notified: string[];

function deliver(id: string, folder: string, patch: Partial<Message> = {}): Message {
  const m: Message = {
    id,
    folder,
    conversationId: `conv-${id}`,
    subject: `Subject ${id}`,
    isRead: false,
    flagged: false,
    importance: "normal",
    categories: [],
    fromMe: folder === "sentitems",
    date: Date.now(),
    version: ++version,
    ...patch,
  };
  messages.set(id, m);
  return m;
}

function move(id: string, folder: string): void {
  const m = messages.get(id)!;
  leftFolder.push({ id, folder: m.folder, version: ++version });
  m.folder = folder;
  m.version = version;
}

function remove(id: string): void {
  const m = messages.get(id)!;
  leftFolder.push({ id, folder: m.folder, version: ++version });
  messages.delete(id);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const notFound = () => json({ error: { code: "ErrorItemNotFound", message: "Not found." } }, 404);

const resource = (m: Message) => ({
  id: m.id,
  conversationId: m.conversationId,
  subject: m.subject,
  bodyPreview: `Preview of ${m.id}`,
  from: {
    emailAddress: m.fromMe
      ? { name: "Me", address: account.email }
      : { name: "Sender", address: "sender@example.test" },
  },
  toRecipients: [{ emailAddress: { name: "Me", address: account.email } }],
  receivedDateTime: new Date(m.date).toISOString(),
  isRead: m.isRead,
  isDraft: m.folder === "drafts",
  flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
  importance: m.importance,
  categories: m.categories,
  hasAttachments: false,
  parentFolderId: m.folder,
  internetMessageId: `<${m.id}@example.test>`,
});

function handle(method: string, url: URL, body: unknown): Response {
  const path = url.pathname.replace(/^\/v1\.0/, "");
  if (method !== "GET") writes.push({ method, path, body });

  const wellKnown = /^\/me\/mailFolders\/([a-z]+)$/.exec(path);
  if (wellKnown && FOLDERS.includes(wellKnown[1]!)) return json({ id: wellKnown[1] });
  if (wellKnown) return notFound();
  if (path === "/me/mailFolders") {
    return json({
      value: FOLDERS.map((id) => ({
        id,
        displayName: id,
        childFolderCount: 0,
        unreadItemCount: [...messages.values()].filter((m) => m.folder === id && !m.isRead).length,
        totalItemCount: [...messages.values()].filter((m) => m.folder === id).length,
      })),
    });
  }
  if (path === "/me/outlook/masterCategories") {
    return json({ value: [{ id: "c1", displayName: "Finance", color: "preset4" }] });
  }

  const delta = /^\/me\/mailFolders\/([a-z]+)\/messages\/delta$/.exec(path);
  if (delta) {
    const folder = delta[1]!;
    const since = Number(url.searchParams.get("since") ?? -1);
    const present = [...messages.values()]
      .filter((m) => m.folder === folder && m.version > since)
      .map(resource);
    const removed =
      since < 0
        ? []
        : leftFolder
            .filter((l) => l.folder === folder && l.version > since)
            .map((l) => ({ id: l.id, "@removed": { reason: "deleted" } }));
    return json({
      value: [...present, ...removed],
      "@odata.deltaLink": `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?since=${version}`,
    });
  }

  const list = /^\/me\/mailFolders\/([a-z]+)\/messages$/.exec(path);
  const search = url.searchParams.get("$search");
  if (search) searches.push({ path, search });
  if (list) {
    return json({
      value: [...messages.values()]
        .filter((m) => m.folder === list[1])
        .sort((a, b) => b.date - a.date)
        .map(resource),
    });
  }
  if (path === "/me/messages") {
    const conversation = /conversationId eq '([^']+)'/.exec(url.searchParams.get("$filter") ?? "");
    return json({
      value: [...messages.values()]
        .filter((m) => !conversation || m.conversationId === conversation[1])
        .map(resource),
    });
  }

  const one = /^\/me\/messages\/([^/]+)(\/move)?$/.exec(path);
  if (one) {
    const m = messages.get(decodeURIComponent(one[1]!));
    if (!m) return notFound();
    if (one[2]) {
      move(m.id, (body as { destinationId: string }).destinationId);
      return json(resource(m));
    }
    if (method === "PATCH") {
      const patch = body as {
        isRead?: boolean;
        flag?: { flagStatus: string };
        categories?: string[];
      };
      if (patch.isRead !== undefined) m.isRead = patch.isRead;
      if (patch.flag) m.flagged = patch.flag.flagStatus === "flagged";
      if (patch.categories) m.categories = patch.categories;
      m.version = ++version;
    }
    return json(resource(m));
  }
  return json({ error: { code: "NotInThisTest", message: path } }, 400);
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.host !== "graph.microsoft.com") return json({ error: "not in this test" }, 404);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
  if (url.pathname === "/v1.0/$batch") {
    const requests = (
      body as { requests: { id: string; method: string; url: string; body?: unknown }[] }
    ).requests;
    const responses = await Promise.all(
      requests.map(async (r) => {
        const answer = handle(
          r.method,
          new URL(`https://graph.microsoft.com/v1.0${r.url}`),
          r.body,
        );
        return { id: r.id, status: answer.status, body: await answer.json() };
      }),
    );
    return json({ responses });
  }
  return handle(init?.method ?? "GET", url, body);
}

// ── Core ────────────────────────────────────────────────────────────────────

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function boot() {
  vi.resetModules();
  const { setPlatform } = await import("../../platform.ts");
  const { startCore } = await import("../../index.ts");
  const mailSync = await import("../mail-sync.ts");
  const mailStore = await import("../mail-store.ts");
  const { providerFor } = await import("../../providers/index.ts");

  const files = new Map<string, Uint8Array>([
    ["accounts.json", new TextEncoder().encode(JSON.stringify([account]))],
  ]);
  const database = new DatabaseSync(":memory:") as unknown as SqlDatabase;
  const unused = () => {
    throw new Error("Not in this test.");
  };
  const platform: Platform = {
    kind: "web",
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
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    userFiles: { open: unused, save: unused, pick: unused },
    google: {
      load: async () => {},
      addAccount: unused,
      cancelSignIn: () => {},
      isSignedIn: () => false,
      getAccessToken: unused,
      getIdToken: unused,
      removeTokens: async () => {},
    },
    microsoft: {
      available: async () => true,
      load: async () => {},
      addAccount: unused,
      cancelSignIn: () => {},
      isSignedIn: (accountId) => accountId === account.id,
      getAccessToken: async () => "token",
      getIdToken: unused,
      removeTokens: async () => {},
    },
    connect: unused,
    relayUrl: "http://relay.test",
    relaySession: "bearer",
    broadcast: () => {},
    notify: ({ body }) => notified.push(body ?? ""),
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

  setPlatform(platform);
  await startCore(platform);
  mailSync.configureAutoSync(0);
  const status = () => mailSync.getSyncStatus(account.id);
  const labelsOf = (id: string) => mailStore.getAllMessageLabels(account.id).get(id);
  const sync = async () => {
    const before = status().lastSyncAt;
    mailSync.syncAccount(account.id, { force: true, trigger: "push" });
    await until(() => status().lastSyncAt !== before && !status().syncing, "a sync");
  };
  return { mailStore, status, labelsOf, sync, provider: providerFor(account.id) };
}

beforeEach(() => {
  messages = new Map();
  version = 0;
  leftFolder = [];
  writes = [];
  searches = [];
  notified = [];
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Outlook sync", () => {
  it("lists every folder of a new mailbox, as labels", async () => {
    deliver("a", "inbox", { flagged: true, categories: ["Finance"] });
    deliver("b", "archive", { isRead: true, importance: "high" });
    deliver("c", "sentitems", { isRead: true });
    deliver("d", "junkemail");

    const { status, labelsOf, mailStore } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    expect(labelsOf("a")?.sort()).toEqual(["INBOX", "STARRED", "UNREAD", "category:Finance"]);
    expect(labelsOf("b")).toEqual(["IMPORTANT"]);
    expect(labelsOf("c")).toEqual(["SENT"]);
    expect(labelsOf("d")?.sort()).toEqual(["SPAM", "UNREAD"]);
    const labels = mailStore.getLabels(account.id);
    expect(labels.find((l) => l.id === "category:Finance")).toMatchObject({
      name: "Finance",
      type: "user",
      color: { backgroundColor: expect.any(String) },
    });
    expect(labels.find((l) => l.id === "INBOX")).toMatchObject({ type: "system", unread: 1 });
  });

  it("follows each folder's delta: new mail, moves and deletions", async () => {
    deliver("a", "inbox");
    deliver("b", "inbox");
    deliver("c", "archive");
    const { status, labelsOf, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    deliver("new", "inbox");
    move("a", "archive");
    remove("c");
    await sync();

    expect(labelsOf("new")).toEqual(["INBOX", "UNREAD"]);
    expect(notified).toEqual(["Subject new"]);
    // Moved: the same id, out of the inbox (archived mail carries no folder label).
    expect(labelsOf("a")).toEqual(["UNREAD"]);
    expect(labelsOf("c")).toBeUndefined();
    expect(labelsOf("b")).toEqual(["INBOX", "UNREAD"]);
  });

  it("turns label changes into Graph's writes", async () => {
    deliver("in", "inbox", { conversationId: "t" });
    deliver("sent", "sentitems", { conversationId: "t", isRead: true });
    const { status, provider } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    writes = [];

    // Archiving the conversation moves what's in the inbox; the sent reply stays.
    await provider.modifyThread(account.id, "t", { removeLabelIds: ["INBOX"] });
    expect(messages.get("in")?.folder).toBe("archive");
    expect(messages.get("sent")?.folder).toBe("sentitems");

    await provider.modifyMessage(account.id, "in", {
      addLabelIds: ["STARRED", "category:Finance"],
      removeLabelIds: ["UNREAD"],
    });
    expect(messages.get("in")).toMatchObject({
      flagged: true,
      isRead: true,
      categories: ["Finance"],
    });

    await provider.trashThread(account.id, "t");
    expect(messages.get("in")?.folder).toBe("deleteditems");
    expect(messages.get("sent")?.folder).toBe("deleteditems");
    await provider.untrashThread(account.id, "t");
    expect(messages.get("in")?.folder).toBe("inbox");
    expect(messages.get("sent")?.folder).toBe("sentitems");
  });

  it("searches with Outlook's engine, Gmail's operators translated", async () => {
    deliver("unread", "inbox");
    deliver("read", "inbox", { isRead: true });
    const { status, provider } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    const page = await provider.search!(
      account.id,
      "invoice from:bob has:attachment in:inbox is:unread",
      undefined,
      50,
    );
    // KQL in the inbox; is:unread, which KQL can't say, checked on each result.
    expect(searches).toEqual([
      { path: "/me/mailFolders/inbox/messages", search: '"invoice from:bob hasattachments:true"' },
    ]);
    expect(page.refs.map((r) => r.id)).toEqual(["unread"]);
  });
});
