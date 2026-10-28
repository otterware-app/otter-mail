/**
 * Gmail sync's lanes, end to end inside core: startCore on a Node platform
 * (the Mac's: bodies kept for offline reading) against a pretend Gmail with a
 * history feed. What it locks in: new mail keeps coming while the first sync
 * fills a mailbox (the fill runs as a backfill beside the sync lane), each
 * message is fetched once (whole), a finished fill is corrected by replaying
 * the feed from where it began, an expired feed is caught up from Gmail's
 * listings instead of re-reading every message, and on the Mac a new
 * mailbox's rows come over IMAP (a pretend Gmail IMAP server) while bodies
 * follow through the API, the inbox first and whole threads at once.
 */

import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Platform, SqlDatabase } from "../../platform.ts";
import { FakeStream, tagOf } from "../../protocols/test/fake-stream.ts";
import type { MailAccount } from "../../types.ts";

const GMAIL = "gmail.googleapis.com";
const account: MailAccount = { id: "me@gmail.test", email: "me@gmail.test", name: "Me" };

// ── The pretend Gmail ───────────────────────────────────────────────────────

type Mail = { id: string; threadId: string; labelIds: string[]; date: number; subject: string };
type Ref = { message: { id: string; threadId: string; labelIds: string[] } };
type HistoryEntry = {
  id: string;
  messagesAdded?: Ref[];
  messagesDeleted?: Ref[];
  labelsAdded?: (Ref & { labelIds: string[] })[];
  labelsRemoved?: (Ref & { labelIds: string[] })[];
};

const SYSTEM_LABELS = ["INBOX", "UNREAD", "STARRED", "SENT", "SPAM", "TRASH", "DRAFT"];

let labels: { id: string; name: string; type: "system" | "user" }[];
let mail: Map<string, Mail>;
let historyId: number;
let history: HistoryEntry[];
/** History older than this is gone (Gmail keeps about a week). */
let historyFloor: number;
/** Message fetches, by id and format. */
let fetches: { id: string; format: string }[];
/** Thread fetches, by id. */
let threadFetches: string[];
/** Listings of the whole mailbox (no label), by the page asked for. */
let listings: (string | null)[];
/** Gmail answers pages of at most this many ids. */
let pageSize: number;
/** threads.modify calls: the thread, and what it was asked. */
let modifies: { threadId: string; body: unknown }[];
/** Messages whose next fetch Gmail refuses (once). */
let refuse: Set<string>;
/** While set, the first fetch of each of `ids` answers as of the request, but only once `until` resolves. */
let hold: { ids: string[]; until: Promise<void> } | null;
const held = new Set<string>();

const ref = (m: Mail): Ref => ({
  message: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] },
});

function deliver(id: string, labelIds: string[], date = Date.now(), threadId = id): Mail {
  const m: Mail = { id, threadId, labelIds, date, subject: `Subject ${id}` };
  mail.set(id, m);
  history.push({ id: String(++historyId), messagesAdded: [ref(m)] });
  return m;
}

function relabel(id: string, add: string[], remove: string[]): void {
  const m = mail.get(id)!;
  m.labelIds = [...m.labelIds.filter((l) => !remove.includes(l)), ...add];
  history.push({
    id: String(++historyId),
    ...(add.length ? { labelsAdded: [{ ...ref(m), labelIds: add }] } : {}),
    ...(remove.length ? { labelsRemoved: [{ ...ref(m), labelIds: remove }] } : {}),
  });
}

function remove(id: string): void {
  const m = mail.get(id)!;
  mail.delete(id);
  history.push({ id: String(++historyId), messagesDeleted: [ref(m)] });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const base64url = (text: string) => Buffer.from(text).toString("base64url");

/** A message as messages.get (and threads.get) answers it. */
function resource(m: Mail, format: string) {
  const headers = [
    { name: "From", value: "Sender <sender@example.test>" },
    { name: "Subject", value: m.subject },
  ];
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: [...m.labelIds],
    internalDate: String(m.date),
    snippet: m.subject,
    payload:
      format === "full"
        ? { mimeType: "text/plain", headers, body: { data: base64url(`Body of ${m.id}`) } }
        : { headers },
  };
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
  if (url.host !== GMAIL) return json({ error: "not in this test" }, 404);
  const path = url.pathname.replace("/gmail/v1/users/me", "");

  const modify = path.match(/^\/threads\/([^/]+)\/modify$/);
  if (modify && init?.method === "POST") {
    const body = JSON.parse(String(init.body)) as {
      addLabelIds: string[];
      removeLabelIds: string[];
    };
    modifies.push({ threadId: modify[1]!, body });
    for (const m of mail.values()) {
      if (m.threadId === modify[1]) relabel(m.id, body.addLabelIds, body.removeLabelIds);
    }
    return json({ id: modify[1] });
  }

  if (path === "/profile") {
    return json({ historyId: String(historyId), messagesTotal: mail.size });
  }
  if (path === "/history") {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (start < historyFloor)
      return json({ error: { message: "Requested entity was not found." } }, 404);
    return json({
      history: history.filter((h) => Number(h.id) > start),
      historyId: String(historyId),
    });
  }
  if (path === "/messages") {
    const labelIds = url.searchParams.getAll("labelIds");
    if (labelIds.length === 0) listings.push(url.searchParams.get("pageToken"));
    const all = [...mail.values()]
      .filter((m) => labelIds.every((l) => m.labelIds.includes(l)))
      .sort((a, b) => b.date - a.date);
    const size = Math.min(pageSize, Number(url.searchParams.get("maxResults") ?? 100));
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const page = all.slice(offset, offset + size);
    return json({
      messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
      nextPageToken: offset + size < all.length ? String(offset + size) : undefined,
      resultSizeEstimate: all.length,
    });
  }
  const message = path.match(/^\/messages\/([^/]+)$/);
  if (message) {
    const id = message[1]!;
    const format = url.searchParams.get("format") ?? "full";
    fetches.push({ id, format });
    if (refuse.delete(id)) return json({ error: { message: "Not now." } }, 403);
    const m = mail.get(id);
    if (!m) return json({ error: { message: "Not Found" } }, 404);
    // Answered as the message is now, delivered later.
    const body = resource(m, format);
    if (hold?.ids.includes(id) && !held.has(id)) {
      held.add(id);
      await hold.until;
    }
    return json(body);
  }
  const thread = path.match(/^\/threads\/([^/]+)$/);
  if (thread) {
    threadFetches.push(thread[1]!);
    const messages = [...mail.values()].filter((m) => m.threadId === thread[1]);
    const format = url.searchParams.get("format") ?? "full";
    return json({ id: thread[1], messages: messages.map((m) => resource(m, format)) });
  }
  if (path === "/labels") return json({ labels });
  const label = path.match(/^\/labels\/([^/]+)$/);
  if (label) return json({ id: label[1], messagesTotal: 0, messagesUnread: 0 });
  if (path === "/drafts") return json({ drafts: [] });
  if (path === "/settings/sendAs") return json({ sendAs: [] });
  return json({ error: { message: "not in this test" } }, 404);
}

// ── Gmail's IMAP ────────────────────────────────────────────────────────────
// The same mailbox over IMAP, as Gmail serves it: All Mail (everything but
// Spam and Trash) and those two folders, X-GM-MSGID/X-GM-THRID in decimal,
// labels in X-GM-LABELS (no categories), unread as a missing \Seen.

/** Whether Gmail lets this account in over IMAP (a Workspace admin can turn it off). */
let imapOpen: boolean;
let imapLogins: number;

const IMAP_NAMES: Record<string, string> = {
  INBOX: "\\\\Inbox",
  SENT: "\\\\Sent",
  STARRED: "\\\\Starred",
  DRAFT: "\\\\Draft",
};

function imapFolder(name: string): Mail[] {
  const inFolder =
    name === "[Gmail]/Spam"
      ? (m: Mail) => m.labelIds.includes("SPAM")
      : name === "[Gmail]/Trash"
        ? (m: Mail) => m.labelIds.includes("TRASH")
        : (m: Mail) => !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH");
  // UIDs in arrival order.
  return [...mail.values()].filter(inFolder).sort((a, b) => a.date - b.date);
}

/** IMAP's date-time: "29-Sep-2026 12:00:00 +0000". */
function internalDate(ms: number): string {
  const d = new Date(ms);
  const month = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}-${month}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;
}

function gmailImap(): FakeStream {
  let selected: Mail[] = [];
  return new FakeStream(
    "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2 X-GM-EXT-1] Gimap\r\n",
    (line) => {
      const tag = tagOf(line);
      const command = line.slice(tag.length + 1).trim();
      if (command.startsWith("AUTHENTICATE")) {
        if (!imapOpen) return `${tag} NO [AUTHENTICATIONFAILED] IMAP access is disabled\r\n`;
        imapLogins++;
        return `${tag} OK [CAPABILITY IMAP4rev1 X-GM-EXT-1] Success\r\n`;
      }
      if (command.startsWith("LIST")) {
        return (
          '* LIST (\\HasNoChildren) "/" "INBOX"\r\n' +
          '* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n' +
          '* LIST (\\HasNoChildren \\Junk) "/" "[Gmail]/Spam"\r\n' +
          '* LIST (\\HasNoChildren \\Trash) "/" "[Gmail]/Trash"\r\n' +
          `${tag} OK\r\n`
        );
      }
      if (command.startsWith("EXAMINE")) {
        selected = imapFolder(command.match(/"(.*)"/)![1]!);
        return `* ${selected.length} EXISTS\r\n* OK [UIDVALIDITY 1] UIDs\r\n${tag} OK [READ-ONLY]\r\n`;
      }
      if (command.startsWith("UID SEARCH")) {
        return `* SEARCH ${selected.map((_, i) => i + 1).join(" ")}\r\n${tag} OK\r\n`;
      }
      if (command.startsWith("UID FETCH")) {
        const uids = command
          .split(" ")[2]!
          .split(",")
          .flatMap((part) => {
            const [from, to = from] = part.split(":").map(Number);
            return Array.from({ length: to! - from! + 1 }, (_, i) => from! + i);
          });
        const lines = uids.map((uid) => {
          const m = selected[uid - 1]!;
          const header = `From: Sender <sender@example.test>\r\nSubject: ${m.subject}\r\n\r\n`;
          const names = m.labelIds
            .map((l) => IMAP_NAMES[l] ?? labels.find((x) => x.id === l && x.type === "user")?.name)
            .filter(Boolean)
            .map((name) => `"${name}"`);
          const flags = m.labelIds.includes("UNREAD") ? "()" : "(\\Seen)";
          return (
            `* ${uid} FETCH (UID ${uid} FLAGS ${flags} INTERNALDATE "${internalDate(m.date)}" ` +
            `X-GM-MSGID ${BigInt(`0x${m.id}`)} X-GM-THRID ${BigInt(`0x${m.threadId}`)} ` +
            `X-GM-LABELS (${names.join(" ")}) ` +
            `BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES)] {${header.length}}\r\n${header})\r\n`
          );
        });
        return `${lines.join("")}${tag} OK\r\n`;
      }
      if (command.startsWith("LOGOUT")) return `* BYE\r\n${tag} OK\r\n`;
      return `${tag} OK\r\n`;
    },
  );
}

// ── Core on Node ────────────────────────────────────────────────────────────

let notified: string[];

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Starts core fresh, signed in to the Gmail account, with `seed` run on the
 * cache first (what an earlier run left there).
 */
async function boot(
  seed?: (store: typeof import("../mail-store.ts")) => void,
  opts: { imap?: boolean } = {},
) {
  vi.resetModules();
  const { setPlatform } = await import("../../platform.ts");
  const { startCore } = await import("../../index.ts");
  const mailSync = await import("../mail-sync.ts");
  const mailStore = await import("../mail-store.ts");

  const files = new Map<string, Uint8Array>([
    ["accounts.json", new TextEncoder().encode(JSON.stringify([account]))],
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
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    userFiles: { open: unused, save: unused, pick: unused },
    google: {
      load: async () => {},
      addAccount: unused,
      cancelSignIn: () => {},
      isSignedIn: (accountId) => accountId === account.id,
      getAccessToken: async () => "token",
      getIdToken: unused,
      removeTokens: async () => {},
    },
    connect: opts.imap ? async () => gmailImap() : unused,
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
    offlineDownloads: true,
  };

  setPlatform(platform);
  seed?.(mailStore);
  await startCore(platform);
  mailSync.configureAutoSync(0);
  const status = () => mailSync.getSyncStatus(account.id);
  const labelsOf = (id: string) => mailStore.getAllMessageLabels(account.id).get(id);
  const { registeredHandlers } = await import("../../ipc.ts");
  /** What a window asks of the backend. */
  const invoke = (channel: string, params: unknown) => registeredHandlers().get(channel)!(params);
  return { mailSync, mailStore, status, labelsOf, invoke };
}

beforeEach(() => {
  mail = new Map();
  historyId = 100;
  history = [];
  historyFloor = 0;
  fetches = [];
  threadFetches = [];
  labels = SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" }));
  imapOpen = true;
  imapLogins = 0;
  listings = [];
  pageSize = 500;
  modifies = [];
  refuse = new Set();
  hold = null;
  held.clear();
  notified = [];
  vi.stubGlobal("fetch", fakeFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Gmail sync", () => {
  it("brings new mail while the first sync is still filling the mailbox", async () => {
    for (let i = 1; i <= 8; i++) deliver(`old${i}`, ["INBOX"], Date.now() - i * 60_000);
    let release!: () => void;
    hold = { ids: [...mail.keys()], until: new Promise((resolve) => (release = resolve)) };

    const { mailSync, mailStore, status } = await boot();
    await until(() => fetches.length > 0, "the fill to start");
    expect(status()).toMatchObject({ syncing: true, phase: "full", fullSyncDone: false });

    // Mail arrives mid-fill, a few times; each push syncs it in at once, and
    // the fill carries on where it is: not listed again, its progress kept.
    const progress = status().total;
    for (const id of ["new1", "new2", "new3"]) {
      deliver(id, ["INBOX", "UNREAD"]);
      mailSync.syncAccount(account.id, { force: true, trigger: "push" });
      await until(() => mailStore.getMessageDetail(account.id, id) !== null, `mail ${id}`);
      expect(status()).toMatchObject({ syncing: true, phase: "full", total: progress });
    }
    expect(notified).toEqual(["Subject new1", "Subject new2", "Subject new3"]);

    release();
    await until(() => status().fullSyncDone && !status().syncing, "the fill to finish");
    await until(() => status().download === null, "the downloads to finish");
    expect(listings).toEqual([null]);
    expect(mailStore.countAllMessages(account.id)).toBe(11);
    // Every message fetched once, whole: no metadata pass, no body pass after it.
    expect(fetches.every((f) => f.format === "full")).toBe(true);
    expect(new Set(fetches.map((f) => f.id)).size).toBe(fetches.length);
    expect(mailStore.getMessageDetail(account.id, "old8")?.bodyText).toBe("Body of old8");
  });

  it("picks a stopped first sync up where it was when new mail comes in, not from the start", async () => {
    for (let i = 1; i <= 7; i++) deliver(`old${i}`, ["INBOX"], Date.now() - i * 60_000);
    pageSize = 3;
    // The second page fails: the fill stops there, the first page kept.
    refuse.add("old5");

    const { mailSync, mailStore, status } = await boot();
    await until(() => status().error !== null && !status().syncing, "the fill to stop");
    expect(listings).toEqual([null, "3"]);
    expect(mailStore.countAllMessages(account.id)).toBe(3);

    // New mail comes in: synced at once, while the fill waits out its retry delay.
    deliver("new", ["INBOX", "UNREAD"]);
    mailSync.syncAccount(account.id, { force: true, trigger: "push" });
    await until(() => mailStore.getMessageDetail(account.id, "new") !== null, "the new mail");
    expect(listings).toEqual([null, "3"]);

    // Later mail finds the delay over: the fill goes on from the second page.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 60_000 });
    deliver("later", ["INBOX", "UNREAD"]);
    mailSync.syncAccount(account.id, { force: true, trigger: "push" });
    await until(() => status().fullSyncDone && !status().syncing, "the fill to finish");
    expect(listings).toEqual([null, "3", "3", "6"]);
    expect(mailStore.countAllMessages(account.id)).toBe(9);
    // The first page was never fetched again.
    expect(fetches.filter((f) => f.id === "old1")).toHaveLength(1);
  });

  it("replays what changed during the first sync over what it wrote", async () => {
    deliver("a", ["INBOX", "UNREAD"], Date.now() - 60_000);
    deliver("b", ["INBOX"], Date.now() - 120_000);
    deliver("c", ["INBOX"], Date.now() - 180_000);
    let release!: () => void;
    hold = { ids: ["a", "b", "c"], until: new Promise((resolve) => (release = resolve)) };

    const { mailSync, mailStore, status, labelsOf } = await boot();
    // The fill has all three in flight, as they were.
    await until(() => held.size === 3, "the fill's fetches");

    // Changed in Gmail meanwhile, and synced in: the feed moves past it.
    relabel("a", [], ["UNREAD"]);
    remove("b");
    relabel("c", ["STARRED"], []);
    mailSync.syncAccount(account.id, { force: true, trigger: "push" });
    await until(
      () => mailStore.getSyncState(account.id).historyId === String(historyId),
      "the push",
    );

    // Then the fill's older copies land.
    release();
    await until(() => status().fullSyncDone && !status().syncing, "the fill and its replay");
    await until(() => labelsOf("b") === undefined, "the replay");
    expect(labelsOf("a")).toEqual(["INBOX"]);
    expect(labelsOf("c")?.sort()).toEqual(["INBOX", "STARRED"]);
    expect(mailStore.countAllMessages(account.id)).toBe(2);
  });

  it("catches up an expired history feed from Gmail's listings, fetching only what's missing", async () => {
    const earlier = Date.now() - 3_600_000;
    const cached = [
      { id: "read", labelIds: ["INBOX", "UNREAD"] },
      { id: "archived", labelIds: ["INBOX"] },
      { id: "deleted", labelIds: ["INBOX"] },
    ];
    // In Gmail now: one read, one archived and starred, one deleted, one new.
    deliver("read", ["INBOX"], earlier);
    deliver("archived", ["STARRED"], earlier - 1);
    deliver("fresh", ["INBOX", "UNREAD"]);
    historyFloor = historyId;

    const { mailStore, status, labelsOf } = await boot((store) => {
      store.upsertMessageDetails(
        account.id,
        cached.map((m, i) => ({
          id: m.id,
          threadId: m.id,
          fromName: "Sender",
          fromEmail: "sender@example.test",
          to: "",
          subject: `Subject ${m.id}`,
          snippet: "",
          date: earlier - i,
          unread: m.labelIds.includes("UNREAD"),
          starred: false,
          labelIds: m.labelIds,
          hasAttachments: false,
          bodyHtml: null,
          bodyText: `Body of ${m.id}`,
          attachments: [],
        })),
      );
      store.setSyncState(account.id, { fullSyncDone: true, historyId: "50" });
      store.setKv(`spamTrashBackfilled:${account.id}`, "1");
    });

    await until(() => labelsOf("fresh") !== undefined, "the missing mail");
    await until(() => !status().syncing, "the refresh to finish");
    expect(labelsOf("read")).toEqual(["INBOX"]);
    expect(labelsOf("archived")).toEqual(["STARRED"]);
    expect(labelsOf("deleted")).toBeUndefined();
    expect(mailStore.getMessageDetail(account.id, "read")?.unread).toBe(false);
    // Only the message the cache lacked was read; the rest came from listings.
    expect(fetches.map((f) => f.id)).toEqual(["fresh"]);
    // The feed runs from now on.
    expect(mailStore.getSyncState(account.id).historyId).toBe(String(historyId));
  });

  it("fills a new mailbox over IMAP at once, then brings bodies inbox first, whole threads together", async () => {
    labels.push(
      { id: "Label_1", name: "Projects/Otter", type: "user" },
      { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
      { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
    );
    const hour = 3_600_000;
    // A thread with a reply, archived mail with a label, promotions, spam, trash.
    deliver("a1", ["INBOX", "UNREAD"], Date.now() - 5 * hour, "a1");
    deliver("a2", ["SENT"], Date.now() - 4 * hour, "a1");
    deliver("b0", ["Label_1", "CATEGORY_UPDATES", "STARRED"], Date.now() - 3 * hour);
    deliver("c0", ["INBOX", "CATEGORY_PROMOTIONS"], Date.now() - 6 * hour);
    deliver("d0", ["SPAM", "UNREAD"], Date.now() - 2 * hour);
    deliver("e0", ["TRASH"], Date.now() - hour);

    const { mailStore, status, labelsOf } = await boot(undefined, { imap: true });
    await until(() => status().fullSyncDone, "the fill");
    expect(imapLogins).toBe(1);
    expect(mailStore.countAllMessages(account.id)).toBe(6);
    expect(labelsOf("a1")?.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(labelsOf("a2")).toEqual(["SENT"]);
    expect(labelsOf("b0")?.sort()).toEqual(["CATEGORY_UPDATES", "Label_1", "STARRED"]);
    expect(labelsOf("c0")?.sort()).toEqual(["CATEGORY_PROMOTIONS", "INBOX"]);
    expect(labelsOf("d0")?.sort()).toEqual(["SPAM", "UNREAD"]);
    expect(labelsOf("e0")).toEqual(["TRASH"]);

    // Bodies (and Gmail's snippets) follow through the API: the inbox first,
    // the thread in one request.
    await until(() => status().download === null && threadFetches.length > 0, "the downloads");
    await until(() => mailStore.countUndownloaded(account.id) === 0, "every body");
    // Each message came through the API once, whole: the rows cost nothing.
    expect(threadFetches).toEqual(["a1"]);
    expect(fetches.map((f) => f.id).sort()).toEqual(["b0", "c0", "d0", "e0"]);
    expect(fetches.every((f) => f.format === "full")).toBe(true);
    expect(fetches[0]?.id).toBe("c0");
    expect(mailStore.getMessageDetail(account.id, "b0")?.snippet).toBe("Subject b0");
  });

  it("fills through the API when Gmail won't let the account in over IMAP", async () => {
    imapOpen = false;
    deliver("f1", ["INBOX"], Date.now() - 60_000);
    deliver("f2", ["INBOX", "UNREAD"], Date.now() - 120_000);
    const { mailStore, status } = await boot(undefined, { imap: true });
    await until(() => status().fullSyncDone && !status().syncing, "the fill");
    expect(imapLogins).toBe(0);
    expect(mailStore.countAllMessages(account.id)).toBe(2);
    expect(status().error).toBeNull();
  });

  it("archives by taking INBOX off the conversation: into All Mail, no Archive folder", async () => {
    deliver("a", ["INBOX", "UNREAD"], Date.now() - 60_000, "t");
    deliver("b", ["SENT"], Date.now(), "t");
    const { mailStore, status, labelsOf, invoke } = await boot();
    await until(() => status().fullSyncDone && !status().syncing, "the first sync");

    await invoke("gmail:modifyThread", {
      accountId: account.id,
      threadId: "t",
      removeLabelIds: ["INBOX"],
    });
    expect(modifies).toEqual([
      { threadId: "t", body: { addLabelIds: [], removeLabelIds: ["INBOX"] } },
    ]);
    expect(labelsOf("a")).toEqual(["UNREAD"]);
    expect(labelsOf("b")).toEqual(["SENT"]);
    expect(mailStore.getLabels(account.id).map((l) => l.id)).not.toContain("ARCHIVE");
    const listed = (labelId: string) =>
      mailStore.getThreadsPage(account.id, labelId, 0, 10).messages.map((m) => m.threadId);
    expect(listed("ALL_MAIL")).toEqual(["t"]);
    expect(listed("INBOX")).toEqual([]);

    // Undo puts INBOX back.
    await invoke("gmail:modifyThread", {
      accountId: account.id,
      threadId: "t",
      addLabelIds: ["INBOX"],
    });
    expect(modifies.at(-1)).toEqual({
      threadId: "t",
      body: { addLabelIds: ["INBOX"], removeLabelIds: [] },
    });
    expect(listed("INBOX")).toEqual(["t"]);
  });
});
