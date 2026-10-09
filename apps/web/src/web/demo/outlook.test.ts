/**
 * The demo's pretend Microsoft Graph: its delta links and $batch answered
 * directly, then core's Outlook provider syncing, reading and changing the
 * demo mailbox through it (core on node:sqlite, as core's own tests run).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Platform, SqlDatabase } from "@otter-mail/core";

const GRAPH = "https://graph.microsoft.com/v1.0";
const EMAIL = "jordan.lee@contoso.example";
const AUTH = { Authorization: `Bearer outlook-demo:${EMAIL}` };

type Item = Record<string, unknown> & { id: string };
type Page = { value: Item[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

function memoryFiles(): Platform["files"] {
  const files = new Map<string, Uint8Array>();
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, typeof data === "string" ? new TextEncoder().encode(data) : data);
    },
    remove: async (path) => {
      files.delete(path);
    },
    list: async () => [],
  };
}

/** What the fake doesn't answer: nothing in these tests reaches the network. */
const offline = async () =>
  new Response(JSON.stringify({ error: "offline in this test" }), { status: 401 });

async function install() {
  vi.resetModules();
  vi.stubGlobal("fetch", offline);
  const fake = await import("./outlook");
  await fake.installFakeOutlook(memoryFiles());
  return fake;
}

async function graph<T = Page>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith("https://") ? path : `${GRAPH}${path}`, {
    ...init,
    headers: { ...AUTH, "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Every page of a delta, following its links: the items and the delta link at the end. */
async function followDelta(link: string, pageSize = 5) {
  const items: Item[] = [];
  let next: string | undefined = link;
  let deltaLink = "";
  let pages = 0;
  while (next) {
    const page: Page = await graph(next, { headers: { Prefer: `odata.maxpagesize=${pageSize}` } });
    items.push(...page.value);
    next = page["@odata.nextLink"];
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
    pages++;
  }
  return { items, deltaLink, pages };
}

const folderId = async (name: string) =>
  (await graph<{ id: string }>(`/me/mailFolders/${name}?$select=id`)).id;

const select = "id,subject,isRead,parentFolderId,conversationId";

afterEach(() => vi.unstubAllGlobals());

describe("the pretend Graph", () => {
  beforeEach(install);

  it("answers well-known folders in a $batch, and 404 for ones it doesn't have", async () => {
    const answer = await graph<{ responses: { id: string; status: number; body: Item }[] }>(
      "/$batch",
      {
        method: "POST",
        body: JSON.stringify({
          requests: ["inbox", "archive", "scheduled"].map((name, i) => ({
            id: String(i),
            method: "GET",
            url: `/me/mailFolders/${name}?$select=id`,
          })),
        }),
      },
    );
    const byId = new Map(answer.responses.map((r) => [r.id, r]));
    expect(byId.get("0")).toMatchObject({ status: 200, body: { id: expect.any(String) } });
    expect(byId.get("1")?.status).toBe(200);
    expect(byId.get("2")?.status).toBe(404);
    expect(Object.keys(byId.get("0")!.body)).toEqual(["id"]);
  });

  it("lists a folder page by page, then answers what changed since", async () => {
    const inbox = await folderId("inbox");
    const archive = await folderId("archive");
    const first = await followDelta(`/me/mailFolders/${inbox}/messages/delta?$select=${select}`);
    const { value: listed } = await graph(`/me/mailFolders/${inbox}/messages?$top=100&$select=id`);
    expect(first.pages).toBeGreaterThan(1);
    expect(first.items.map((m) => m.id).sort()).toEqual(listed.map((m) => m.id).sort());
    expect(first.items.every((m) => m.parentFolderId === inbox && !("@removed" in m))).toBe(true);

    // Nothing changed: an empty delta, and a link to carry on from.
    const quiet = await followDelta(first.deltaLink);
    expect(quiet.items).toEqual([]);

    // Read one, archive another, delete a third.
    const [read, moved, gone] = first.items;
    await graph(`/me/messages/${read.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: !read.isRead }),
    });
    const movedTo = await graph<Item>(`/me/messages/${moved.id}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: "archive" }),
    });
    expect(movedTo).toMatchObject({ id: moved.id, parentFolderId: archive });
    await graph(`/me/messages/${gone.id}/permanentDelete`, { method: "POST" });

    const changes = await followDelta(quiet.deltaLink);
    expect(changes.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: read.id, isRead: !read.isRead }),
        { id: moved.id, "@removed": { reason: "deleted" } },
        { id: gone.id, "@removed": { reason: "deleted" } },
      ]),
    );
    expect(changes.items).toHaveLength(3);
    // The archive's own delta has the message that came in.
    const archived = await followDelta(`/me/mailFolders/${archive}/messages/delta`);
    expect(archived.items.map((m) => m.id)).toContain(moved.id);
    expect((await followDelta(changes.deltaLink)).items).toEqual([]);
  });

  it("filters and searches as core asks", async () => {
    const flagged = await graph(
      `/me/messages?$filter=${encodeURIComponent("flag/flagStatus eq 'flagged' and isRead eq false")}&$select=id,subject`,
    );
    expect(flagged.value.map((m) => m.subject)).toEqual(
      expect.arrayContaining([
        "Action needed: renew your VPN certificate by Friday",
        "RE: Reader redesign: phase 2 scope",
      ]),
    );
    const finance = await graph(
      `/me/messages?$filter=${encodeURIComponent("categories/any(c:c eq 'Finance')")}&$select=id,categories`,
    );
    expect(finance.value.length).toBe(2);
    const important = await graph(
      `/me/messages?$filter=${encodeURIComponent("importance eq 'high'")}&$select=id`,
    );
    expect(important.value).toHaveLength(1);
    const search = await graph(
      `/me/messages?$search=${encodeURIComponent('"from:priya hasattachments:true"')}&$select=id,subject`,
    );
    expect(search.value.map((m) => m.subject)).toEqual([expect.stringContaining("Sprint review")]);
    const words = await graph(
      `/me/messages?$search=${encodeURIComponent('"\\"ramen place\\""')}&$select=id,subject`,
    );
    expect(words.value.map((m) => m.subject)).toEqual(["Lunch on Thursday?"]);
  });

  it("replies, sends to itself, and accepts MIME through sendMail", async () => {
    const { value } = await graph(
      `/me/messages?$filter=${encodeURIComponent("isDraft eq false")}&$search=${encodeURIComponent('"subject:lunch"')}&$select=id,conversationId,internetMessageId`,
    );
    const lunch = value[0];
    const reply = await graph<Item>(`/me/messages/${lunch.id}/createReply`, { method: "POST" });
    expect(reply).toMatchObject({ isDraft: true, conversationId: lunch.conversationId });
    await graph(`/me/messages/${reply.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        toRecipients: [{ emailAddress: { address: EMAIL } }],
        body: { contentType: "html", content: "<p>See you there</p>" },
      }),
    });
    await graph(`/me/messages/${reply.id}/send`, { method: "POST" });
    const sent = await graph<Item>(`/me/messages/${reply.id}?$select=isDraft,parentFolderId`);
    expect(sent).toMatchObject({ isDraft: false, parentFolderId: await folderId("sentitems") });
    const thread = await graph(
      `/me/messages?$filter=${encodeURIComponent(`conversationId eq '${String(lunch.conversationId)}'`)}&$select=id,parentFolderId,isRead`,
    );
    const inbox = await folderId("inbox");
    // Diego's message, and the copy of the reply sent to yourself.
    expect(thread.value.filter((m) => m.parentFolderId === inbox && !m.isRead)).toHaveLength(2);

    const mime = [
      `From: Jordan Lee <${EMAIL}>`,
      "To: Diego <diego.ramirez@contoso.example>",
      "Subject: Accepted: lunch",
      `In-Reply-To: ${String(lunch.internetMessageId)}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Yes!",
    ].join("\r\n");
    await fetch(`${GRAPH}/me/sendMail`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "text/plain" },
      body: btoa(mime),
    });
    const after = await graph(
      `/me/messages?$filter=${encodeURIComponent(`conversationId eq '${String(lunch.conversationId)}'`)}&$select=subject`,
    );
    expect(after.value.map((m) => m.subject)).toContain("Accepted: lunch");
  });

  it("finds the invitation's event and answers it", async () => {
    const uid = "sprint-review-demo@acme.example";
    const found = await graph(
      `/me/events?$filter=${encodeURIComponent(`iCalUId eq '${uid}'`)}&$top=1`,
    );
    expect(found.value[0]).toMatchObject({ responseStatus: { response: "notResponded" } });
    await graph(`/me/events/${found.value[0].id}/accept`, {
      method: "POST",
      body: JSON.stringify({ sendResponse: true }),
    });
    const event = await graph<Item>(`/me/events/${found.value[0].id}`);
    expect(event).toMatchObject({ responseStatus: { response: "accepted" }, showAs: "busy" });
  });
});

// ── Core's Outlook provider against it ──────────────────────────────────────

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function boot() {
  const fake = await install();
  const core = await import("@otter-mail/core");
  // Core's own tests' SQLite; kept out of the web app's types.
  const sqlite = "node:sqlite";
  const { DatabaseSync } = (await import(/* @vite-ignore */ sqlite)) as {
    DatabaseSync: new (path: string) => SqlDatabase;
  };
  const database = new DatabaseSync(":memory:");
  const unused = () => {
    throw new Error("Not in this test.");
  };
  const platform: Platform = {
    kind: "web",
    appVersion: "test",
    log: () => {},
    database: () => database,
    files: memoryFiles(),
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
    microsoft: fake.demoMicrosoftAuth(),
    connect: unused,
    relayUrl: "https://relay.demo.invalid",
    relaySession: "cookie",
    broadcast: () => {},
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
  vi.spyOn(console, "log").mockImplementation(() => {});
  await core.startCore(platform);
  const invoke = <T>(channel: string, params?: unknown) =>
    core.registeredHandlers().get(channel)!(params) as Promise<T>;
  return { core, invoke };
}

type Row = { id: string; threadId: string; subject: string; labelIds: string[] };

describe("core's Outlook provider on the demo mailbox", () => {
  it("adds the mailbox, syncs it, and reads and changes its mail", async () => {
    const { core, invoke } = await boot();
    const accounts = await invoke<{ id: string; provider?: string }[]>("gmail:listAccounts");
    expect(accounts).toEqual([expect.objectContaining({ id: EMAIL, provider: "outlook" })]);

    const synced = async () => {
      await until(async () => {
        const status = await invoke<{ syncing: boolean; fullSyncDone: boolean; error?: string }>(
          "gmail:getSyncStatus",
          { accountId: EMAIL },
        );
        if (status.error) throw new Error(status.error);
        return status.fullSyncDone && !status.syncing;
      }, "a sync");
    };
    await synced();
    const ids = (label: string) => core.mailStore.getMessageIdsForLabel(EMAIL, label);
    expect(core.mailStore.countAllMessages(EMAIL)).toBe(25);
    expect(core.mailStore.getLabels(EMAIL).map((l) => l.name)).toEqual(
      expect.arrayContaining(["INBOX", "Clients", "Clients/Acme", "Finance", "Travel", "Urgent"]),
    );
    expect(ids("INBOX")).toHaveLength(11);
    expect(ids("SPAM")).toHaveLength(2);
    expect(ids("TRASH")).toHaveLength(1);
    expect(ids("DRAFT")).toHaveLength(1);
    expect(ids("IMPORTANT")).toHaveLength(1);
    expect(ids("category:Finance")).toHaveLength(2);

    const list = async (label: string) =>
      (
        await invoke<{ messages: Row[] }>("gmail:listMessages", {
          accountId: EMAIL,
          labelIds: [label],
          maxResults: 50,
        })
      ).messages;
    const inbox = await list("INBOX");
    // A received message of the inbox's conversations, by its subject.
    const find = (subject: string) =>
      inbox
        .flatMap((row) => core.mailStore.getThreadMessages(EMAIL, row.threadId))
        .find((m) => m.subject === subject && m.labelIds.includes("INBOX"))!;

    // Whole messages come from their MIME source: inline images, attachments.
    type Detail = {
      bodyHtml: string | null;
      attachments: { filename: string; contentId?: string }[];
    };
    const photos = await invoke<Detail>("gmail:getMessage", {
      accountId: EMAIL,
      messageId: find("Photos from Tuesday's workshop").id,
    });
    expect(photos.attachments).toEqual([
      expect.objectContaining({ filename: "whiteboard.svg", contentId: "whiteboard" }),
    ]);
    const invoice = await invoke<Detail>("gmail:getMessage", {
      accountId: EMAIL,
      messageId: find("Invoice INV-2041 from Fabrikam Print").id,
    });
    expect(invoice.attachments.map((a) => a.filename)).toEqual(["INV-2041.pdf"]);

    // The invitation's event is found in the calendar and answered there.
    const invite = inbox
      .flatMap((r) => core.mailStore.getThreadMessages(EMAIL, r.threadId))
      .find((m) => m.subject.startsWith("Sprint review"))!;
    type Invite = { uid: string; response: string; calendarAccess: boolean };
    expect(
      await invoke<Invite>("calendar:getInvite", { accountId: EMAIL, messageId: invite.id }),
    ).toMatchObject({
      uid: "sprint-review-demo@acme.example",
      response: "needsAction",
      calendarAccess: true,
    });
    expect(
      await invoke<Invite>("calendar:respond", {
        accountId: EMAIL,
        messageId: invite.id,
        response: "tentative",
      }),
    ).toMatchObject({ response: "tentative" });

    // The newsletter offers one-click unsubscribe from its headers.
    const newsletter = find("Design Weekly #58: Calm interfaces");
    expect(
      await invoke("gmail:getUnsubscribe", { accountId: EMAIL, messageId: newsletter.id }),
    ).toMatchObject({ method: "oneClick", target: "designweekly.example" });

    // Archive a conversation, flag and categorize a message, send one to yourself.
    const offsite = find("RE: Contoso offsite: venue shortlist");
    await invoke("gmail:modifyThread", {
      accountId: EMAIL,
      threadId: offsite.threadId,
      removeLabelIds: ["INBOX"],
    });
    const lunch = find("Lunch on Thursday?");
    await invoke("gmail:modifyMessage", {
      accountId: EMAIL,
      messageId: lunch.id,
      addLabelIds: ["STARRED", "category:Follow up"],
      removeLabelIds: ["UNREAD"],
    });
    await invoke("gmail:sendMessage", {
      accountId: EMAIL,
      to: EMAIL,
      subject: "Note to self",
      body: "Agenda for the design track",
    });
    const archive = await folderId("archive");
    const conversation = await graph(
      `/me/messages?$filter=${encodeURIComponent(`conversationId eq '${offsite.threadId}'`)}&$select=parentFolderId`,
    );
    // Archived from the inbox; the reply you sent stays in Sent Items.
    expect(conversation.value.filter((m) => m.parentFolderId === archive)).toHaveLength(2);
    expect(
      await graph<Item>(`/me/messages/${lunch.id}?$select=flag,categories,isRead`),
    ).toMatchObject({ flag: { flagStatus: "flagged" }, categories: ["Follow up"], isRead: true });

    // The next sync brings it all back from the delta links.
    await invoke("gmail:syncAccount", { accountId: EMAIL });
    await until(
      () => (core.mailStore.getAllMessageLabels(EMAIL).size ?? 0) === 27,
      "the sent message and its copy in the inbox",
    );
    await synced();
    const labelsOf = (id: string) => core.mailStore.getAllMessageLabels(EMAIL).get(id) ?? [];
    for (const m of core.mailStore.getThreadMessages(EMAIL, offsite.threadId)) {
      expect(labelsOf(m.id)).not.toContain("INBOX");
    }
    expect(labelsOf(lunch.id)).toEqual(
      expect.arrayContaining(["INBOX", "STARRED", "category:Follow up"]),
    );
    expect(labelsOf(lunch.id)).not.toContain("UNREAD");
    // Sent Items has what you sent; the inbox has its copy, unread.
    const row = (await list("INBOX")).find((m) => m.subject === "Note to self")!;
    expect(
      core.mailStore.getThreadMessages(EMAIL, row.threadId).map((m) => m.labelIds.sort()),
    ).toEqual(expect.arrayContaining([["SENT"], ["INBOX", "UNREAD"]]));
  });
});
