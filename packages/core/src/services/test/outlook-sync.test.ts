/**
 * Outlook, end to end inside core: startCore on a Node platform against a
 * pretend Microsoft Graph with per-folder delta queries. What it locks in: a
 * new mailbox shows its inbox first and then lists every folder; folders
 * (the Archive as ARCHIVE), flags, importance and categories become labels;
 * later syncs follow each folder's delta (new mail notified, a message moved
 * out of the inbox keeps its id and lands in ARCHIVE, a deleted one leaves the
 * cache); and label changes become the right Graph writes (archive moves only
 * what's in the inbox, to the Archive folder, and undo moves it back).
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

const FOLDERS = [
  "inbox",
  "archive",
  "sentitems",
  "drafts",
  "deleteditems",
  "junkemail",
  "scheduled",
];

type Message = {
  id: string;
  folder: string;
  conversationId: string;
  subject: string;
  isRead: boolean;
  flagged: boolean;
  importance: "normal" | "high";
  categories: string[];
  /** Focused Inbox sorted it as Other. */
  other?: boolean;
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
let sparseDeltas: boolean;
let failedReads: boolean;

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
  inferenceClassification: m.other ? "other" : "focused",
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
      .map((m) =>
        since >= 0 && sparseDeltas
          ? { id: m.id, parentFolderId: m.folder, isRead: m.isRead }
          : resource(m),
      );
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
    const otherOnly = /inferenceClassification eq 'other'/.test(
      url.searchParams.get("$filter") ?? "",
    );
    return json({
      value: [...messages.values()]
        .filter((m) => m.folder === list[1] && (!otherOnly || m.other))
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
    if (method === "GET" && failedReads)
      return json({ error: { code: "ErrorInternalServerError", message: "Test failure." } }, 500);
    if (one[2]) {
      move(m.id, (body as { destinationId: string }).destinationId);
      return json(resource(m));
    }
    if (method === "PATCH") {
      const patch = body as {
        isRead?: boolean;
        flag?: { flagStatus: string };
        categories?: string[];
        inferenceClassification?: string;
      };
      if (patch.isRead !== undefined) m.isRead = patch.isRead;
      if (patch.inferenceClassification) m.other = patch.inferenceClassification === "other";
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
  const { registeredHandlers } = await import("../../ipc.ts");

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
  /** What a window asks of the backend. */
  const invoke = (channel: string, params: unknown) => registeredHandlers().get(channel)!(params);
  return { mailStore, status, labelsOf, sync, invoke, provider: providerFor(account.id) };
}

beforeEach(() => {
  messages = new Map();
  version = 0;
  leftFolder = [];
  writes = [];
  searches = [];
  notified = [];
  sparseDeltas = false;
  failedReads = false;
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
    expect(labelsOf("b")?.sort()).toEqual(["ARCHIVE", "IMPORTANT"]);
    expect(labelsOf("c")).toEqual(["SENT"]);
    expect(labelsOf("d")?.sort()).toEqual(["SPAM", "UNREAD"]);
    const labels = mailStore.getLabels(account.id);
    expect(labels.find((l) => l.id === "category:Finance")).toMatchObject({
      name: "Finance",
      type: "user",
      color: { backgroundColor: expect.any(String) },
    });
    expect(labels.find((l) => l.id === "INBOX")).toMatchObject({ type: "system", unread: 1 });
    // The Archive is a folder, with Outlook's counts, as Outlook shows it.
    expect(labels.find((l) => l.id === "ARCHIVE")).toMatchObject({
      type: "system",
      total: 1,
      unread: 0,
    });
  });

  it("follows each folder's delta: new mail, moves and deletions", async () => {
    deliver("a", "inbox");
    deliver("b", "inbox");
    deliver("c", "archive");
    const { status, labelsOf, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    sparseDeltas = true;
    deliver("new", "inbox");
    move("a", "archive");
    remove("c");
    await sync();

    expect(labelsOf("new")).toEqual(["INBOX", "UNREAD"]);
    expect(notified).toEqual(["Subject new"]);
    // Moved: the same id, out of the inbox and into the Archive.
    expect(labelsOf("a")?.sort()).toEqual(["ARCHIVE", "UNREAD"]);
    expect(labelsOf("c")).toBeUndefined();
    expect(labelsOf("b")).toEqual(["INBOX", "UNREAD"]);
  });

  it("keeps headers, conversation and list position when marking read produces a sparse delta", async () => {
    const latest = deliver("latest", "inbox", {
      date: Date.parse("2026-10-13T08:00:00Z"),
      flagged: true,
      categories: ["Finance"],
    });
    deliver("older", "inbox", { date: latest.date - 60_000 });
    const { status, provider, mailStore, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    const before = mailStore
      .getThreadsPage(account.id, "INBOX", 0, 10)
      .messages.find((m) => m.id === "latest")!;
    mailStore.upsertMessageDetail(account.id, {
      ...before,
      bodyText: "Cached message body",
      bodyHtml: "<p>Cached message body</p>",
      attachments: [],
    });
    sparseDeltas = true;
    await provider.modifyThread(account.id, latest.conversationId, { removeLabelIds: ["UNREAD"] });
    await sync();
    expect(mailStore.getMessageDetail(account.id, "latest")).toMatchObject({
      subject: before.subject,
      date: before.date,
      threadId: before.threadId,
      fromEmail: before.fromEmail,
      unread: false,
      starred: true,
      labelIds: expect.arrayContaining(["INBOX", "STARRED", "category:Finance"]),
      bodyText: "Cached message body",
    });
    expect(mailStore.getAllMessageLabels(account.id).get("latest")).not.toContain("UNREAD");
    expect(mailStore.getThreadsPage(account.id, "INBOX", 0, 10).messages.map((m) => m.id)).toEqual([
      "latest",
      "older",
    ]);
    expect(notified).toEqual([]);
  });

  it("keeps the cache and delta cursor intact when resolving a sparse update fails", async () => {
    deliver("a", "inbox");
    const { status, provider, mailStore, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    const before = mailStore.getThreadsPage(account.id, "INBOX", 0, 10).messages;
    const cursor = mailStore.getKv(`outlookDelta:${account.id}`);
    sparseDeltas = true;
    await provider.modifyMessage(account.id, "a", { removeLabelIds: ["UNREAD"] });
    failedReads = true;
    await expect(
      provider.sync(account.id, {
        update: () => {},
        assertActive: () => {},
        bumpRevision: () => {},
        newMail: async () => {},
      }),
    ).rejects.toThrow("Test failure");
    expect(mailStore.getKv(`outlookDelta:${account.id}`)).toBe(cursor);
    expect(mailStore.getThreadsPage(account.id, "INBOX", 0, 10).messages).toEqual(before);
    failedReads = false;
    await sync();
    expect(mailStore.getThreadsPage(account.id, "INBOX", 0, 10).messages[0]).toMatchObject({
      subject: "Subject a",
      unread: false,
    });
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

  it("archives from the app: the inbox's mail lands in the Archive at once, and undo brings it back", async () => {
    deliver("in", "inbox", { conversationId: "t" });
    deliver("sent", "sentitems", { conversationId: "t", isRead: true });
    const { status, labelsOf, invoke, mailStore, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    writes = [];

    // What the Archive button, e, a swipe or a bulk archive send: INBOX off the conversation.
    await invoke("gmail:modifyThread", {
      accountId: account.id,
      threadId: "t",
      removeLabelIds: ["INBOX"],
    });
    expect(writes).toEqual([
      { method: "POST", path: "/me/messages/in/move", body: { destinationId: "archive" } },
    ]);
    expect(messages.get("in")?.folder).toBe("archive");
    expect(messages.get("sent")?.folder).toBe("sentitems");
    // The cache has it in the Archive before any sync, the reply still in Sent.
    expect(labelsOf("in")?.sort()).toEqual(["ARCHIVE", "UNREAD"]);
    expect(labelsOf("sent")).toEqual(["SENT"]);
    const listed = (labelId: string) =>
      mailStore.getThreadsPage(account.id, labelId, 0, 10).messages.map((m) => m.threadId);
    expect(listed("ARCHIVE")).toEqual(["t"]);
    expect(listed("INBOX")).toEqual([]);
    await sync();
    expect(labelsOf("in")?.sort()).toEqual(["ARCHIVE", "UNREAD"]);

    // Undo: INBOX back on, which moves it out of the Archive.
    await invoke("gmail:modifyThread", {
      accountId: account.id,
      threadId: "t",
      addLabelIds: ["INBOX"],
    });
    expect(messages.get("in")?.folder).toBe("inbox");
    expect(messages.get("sent")?.folder).toBe("sentitems");
    expect(labelsOf("in")?.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(listed("ARCHIVE")).toEqual([]);
  });

  it("takes mail out of the Archive, and lists and searches it from Outlook", async () => {
    deliver("old", "archive", { conversationId: "o", subject: "Lunch" });
    const { status, labelsOf, provider } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    expect((await provider.listIds!(account.id, { labelIds: ["ARCHIVE"] })).ids).toEqual(["old"]);
    await provider.search!(account.id, "in:archive lunch", undefined, 50);
    expect(searches).toEqual([{ path: "/me/mailFolders/archive/messages", search: '"lunch"' }]);

    await provider.modifyThread(account.id, "o", { removeLabelIds: ["ARCHIVE"] });
    expect(messages.get("old")?.folder).toBe("inbox");
    await provider.modifyThread(account.id, "o", { addLabelIds: ["ARCHIVE"] });
    expect(messages.get("old")?.folder).toBe("archive");
    expect(labelsOf("old")).toContain("ARCHIVE");
  });

  it("gives ARCHIVE to archived mail cached before the Archive had a label", async () => {
    deliver("old", "archive", { isRead: true });
    deliver("in", "inbox");
    const { status, labelsOf, mailStore, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    // As an older version left it: no label on the Archive's mail, none kept for its folders.
    mailStore.applyHistoryChanges(account.id, [
      { kind: "labelsRemoved", id: "old", labelIds: ["ARCHIVE"] },
    ]);
    const key = `outlookDelta:${account.id}`;
    const delta = JSON.parse(mailStore.getKv(key)!) as Record<string, { label?: string | null }>;
    for (const folder of Object.values(delta)) delete folder.label;
    mailStore.setKv(key, JSON.stringify(delta));

    await sync();
    expect(labelsOf("old")).toEqual(["ARCHIVE"]);
    expect(labelsOf("in")?.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(mailStore.getThreadsPage(account.id, "ARCHIVE", 0, 10).messages).toHaveLength(1);
  });

  it("keeps Focused Inbox's Other as OTHER, and moves mail between Focused and Other", async () => {
    deliver("other", "inbox", { other: true });
    deliver("focused", "inbox");
    const { status, labelsOf, provider, mailStore, sync } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    expect(labelsOf("other")?.sort()).toEqual(["INBOX", "OTHER", "UNREAD"]);
    expect(labelsOf("focused")?.sort()).toEqual(["INBOX", "UNREAD"]);

    await provider.modifyMessage(account.id, "focused", { addLabelIds: ["OTHER"] });
    expect(messages.get("focused")?.other).toBe(true);
    await provider.modifyMessage(account.id, "other", { removeLabelIds: ["OTHER"] });
    expect(messages.get("other")?.other).toBe(false);

    // Mail cached before its sorting was kept gets OTHER once.
    mailStore.applyHistoryChanges(account.id, [
      { kind: "labelsRemoved", id: "focused", labelIds: ["OTHER"] },
    ]);
    mailStore.setKv(`outlookOther:${account.id}`, "");
    await sync();
    expect(labelsOf("focused")).toContain("OTHER");
  });

  it("shows Outlook's Scheduled folder, where its Snooze keeps mail, as SNOOZED", async () => {
    deliver("later", "scheduled", { conversationId: "s" });
    const { status, labelsOf, provider, mailStore } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");
    expect(labelsOf("later")).toContain("SNOOZED");
    expect(mailStore.getLabels(account.id).find((l) => l.id === "SNOOZED")).toMatchObject({
      type: "system",
      total: 1,
    });
    // Back to the inbox early.
    await provider.modifyThread(account.id, "s", { addLabelIds: ["INBOX"] });
    expect(messages.get("later")?.folder).toBe("inbox");
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
