/**
 * The IMAP provider against real servers in Docker, driven the way core
 * drives it (sync runs, the handlers' writes) on a Node platform: Dovecot
 * for the QRESYNC paths, GreenMail (no mod-sequences) for the plain ones,
 * and GreenMail's SMTP for sending. Skipped when Docker isn't running.
 */

import type { ImapSettings } from "@otter-mail/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { searchMail } from "../../../handlers/search.ts";
import { connectImap, type ImapClient } from "../../../protocols/index.ts";
import { nodeConnect } from "../../../protocols/test/node-stream.ts";
import {
  dockerAvailable,
  startDovecot,
  startGreenMail,
  type Container,
} from "../../../protocols/test/servers.ts";
import * as accounts from "../../../services/account-store.ts";
import { setImapPassword } from "../../../services/imap-passwords.ts";
import * as store from "../../../services/mail-store.ts";
import type { MessageSummary } from "../../../types.ts";
import type { SyncContext } from "../../provider.ts";
import { imapProvider } from "../index.ts";
import { threadIdOf } from "../messages.ts";
import { connectionCount, resumeNow, useNodePlatform } from "./node-platform.ts";

useNodePlatform();
const docker = dockerAvailable();
const provider = imapProvider;

let counter = 0;
function mail(opts: {
  subject: string;
  from?: string;
  to?: string;
  inReplyTo?: string;
  attachment?: boolean;
}): { id: string; raw: string } {
  const id = `<m${Date.now()}.${++counter}@example.com>`;
  const head = [
    `From: ${opts.from ?? "Bob <bob@example.com>"}`,
    `To: ${opts.to ?? "Me <me@example.com>"}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${id}`,
    `Date: ${new Date().toUTCString()}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`, `References: ${opts.inReplyTo}`] : []),
    "MIME-Version: 1.0",
  ];
  const body = `Hello, this is ${opts.subject}.`;
  if (!opts.attachment) {
    return {
      id,
      raw: [...head, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"),
    };
  }
  const raw = [
    ...head,
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "--b",
    'Content-Type: application/octet-stream; name="data.bin"',
    'Content-Disposition: attachment; filename="data.bin"',
    "Content-Transfer-Encoding: base64",
    "",
    "AAECAw==",
    "--b--",
    "",
  ].join("\r\n");
  return { id, raw };
}

async function sync(accountId: string): Promise<MessageSummary[]> {
  const newMail: MessageSummary[] = [];
  const ctx: SyncContext = {
    update: () => {},
    bumpRevision: () => {},
    assertActive: () => {},
    newMail: async (messages) => {
      newMail.push(...messages);
    },
  };
  await provider.sync(accountId, ctx);
  return newMail;
}

/** The cached message with this Message-ID header. */
function cachedByHeader(accountId: string, header: string) {
  const id = store
    .getMessageIdsWithPrefix(accountId, "")
    .find((m) => store.getStoredReplyHeaders(accountId, m).messageIdHeader === header);
  return id ? { id, labels: store.getMessageLabelIds(accountId, id) ?? [] } : null;
}

const pathOf = (id: string) => id.split(":").slice(2).join(":");

const waitFor = async <T>(check: () => T | undefined, ms = 15_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/** What every server should do; `seed` is a second client, as another device would be. */
function providerScenario(
  server: () => { accountId: string; settings: ImapSettings; password: string; smtp: boolean },
) {
  let accountId: string;
  let seed: ImapClient;
  const a = mail({ subject: "Lunch?", attachment: true });
  const b = mail({ subject: "Re: Lunch?", from: "Me <me@example.com>", inReplyTo: a.id });
  const w1 = mail({ subject: "Report" });
  const w2 = mail({ subject: "Old report" });
  const c = mail({ subject: "Tickets" });
  const lunch = threadIdOf(undefined, null, a.id, "Lunch?")!;

  const serverSearch = async (path: string, header: string) => {
    await seed.select(path);
    return seed.search({ messageId: header, deleted: false });
  };

  beforeAll(async () => {
    const { settings, password } = server();
    accountId = server().accountId;
    await accounts.addAccount({
      id: accountId,
      email: accountId,
      name: "Me",
      provider: "imap",
      imap: settings,
    });
    await setImapPassword(accountId, password);
    seed = await connectImap({
      ...settings.imap,
      auth: { user: settings.username, pass: password },
      connect: nodeConnect,
    });
    for (const path of ["Sent", "Work"]) await seed.createMailbox(path).catch(() => {});
    await seed.append("INBOX", a.raw);
    await seed.append("Sent", b.raw, { flags: ["\\Seen"] });
    await seed.append("Work", w1.raw, { flags: ["\\Seen"] });
    await seed.append("Work", w2.raw, { flags: ["\\Seen"] });
  });

  afterAll(async () => {
    await seed?.logout();
    await provider.removeAccount(accountId);
  });

  it("isn't signed in without a password", () => {
    expect(provider.isSignedIn(accountId)).toBe(true);
    expect(provider.isSignedIn("nobody@example.com")).toBe(false);
  });

  it("syncs the mailbox: folders as labels, a conversation across INBOX and Sent", async () => {
    expect(await sync(accountId)).toEqual([]);
    expect(store.getSyncState(accountId).fullSyncDone).toBe(true);

    const labels = store.getLabels(accountId);
    expect(labels.find((l) => l.id === "INBOX")).toMatchObject({
      type: "system",
      total: 1,
      unread: 1,
    });
    expect(labels.find((l) => l.id === "SENT")).toMatchObject({ type: "system" });
    expect(labels.find((l) => l.id === "Work")).toMatchObject({
      name: "Work",
      type: "user",
      total: 2,
    });

    const original = cachedByHeader(accountId, a.id)!;
    const reply = cachedByHeader(accountId, b.id)!;
    expect(original.labels.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(reply.labels).toEqual(["SENT"]);
    const thread = store.getThreadMessages(accountId, lunch);
    expect(thread.map((m) => m.id).sort()).toEqual([original.id, reply.id].sort());
    const summary = thread.find((m) => m.id === original.id)!;
    expect(summary).toMatchObject({
      subject: "Lunch?",
      fromEmail: "bob@example.com",
      hasAttachments: true,
    });
    expect(summary.snippet).toBe("Hello, this is Lunch?.");
    expect(cachedByHeader(accountId, w1.id)!.labels).toEqual(["Work"]);
  });

  it("reads a message and its attachment", async () => {
    const { id } = cachedByHeader(accountId, a.id)!;
    const detail = await provider.getMessage(accountId, id);
    expect(detail.bodyText).toContain("Hello, this is Lunch?.");
    expect(detail.attachments).toMatchObject([{ id: "0", filename: "data.bin", size: 4 }]);
    expect([...(await provider.fetchAttachment(accountId, id, "0"))]).toEqual([0, 1, 2, 3]);
    expect(await provider.getReplyHeaders(accountId, id)).toEqual({
      messageIdHeader: a.id,
      referencesHeader: null,
    });
    // Reading doesn't mark it read.
    expect((await provider.getSummaries(accountId, [id]))[0]!.unread).toBe(true);
  });

  it("searches the local index with Gmail's operators", async () => {
    const subjects = async (q: string) =>
      (await searchMail(q, [accountId])).messages.map((m) => m.subject).sort();
    expect(await subjects("report")).toEqual(["Old report", "Report"]);
    expect(await subjects("in:inbox report")).toEqual([]);
    expect(await subjects("label:work old")).toEqual(["Old report"]);
    expect(await subjects("in:inbox")).toEqual(["Lunch?"]);
    expect(await subjects("is:unread has:attachment")).toEqual(["Lunch?"]);
    expect(await subjects("is:flagged")).toEqual(await subjects("is:starred"));
    expect(await subjects("from:bob -in:inbox")).toEqual(["Old report", "Report"]);
    expect(await subjects("in:sent lunch")).toEqual(["Re: Lunch?"]);
  });

  it("catches up with another device: flags, new mail, expunged mail", async () => {
    await seed.select("INBOX");
    const [uid] = await seed.search({ messageId: a.id });
    await seed.store([uid!], { add: ["\\Seen", "\\Flagged"] });
    await seed.append("INBOX", c.raw);
    await seed.select("Work");
    const [old] = await seed.search({ messageId: w2.id });
    await seed.store([old!], { add: ["\\Deleted"] });
    await seed.expunge([old!]);

    const added = await sync(accountId);
    expect(added.map((m) => m.subject)).toEqual(["Tickets"]);
    expect(cachedByHeader(accountId, a.id)!.labels.sort()).toEqual(["INBOX", "STARRED"]);
    expect(cachedByHeader(accountId, c.id)!.labels.sort()).toEqual(["INBOX", "UNREAD"]);
    expect(cachedByHeader(accountId, w2.id)).toBeNull();
    expect(await sync(accountId)).toEqual([]);
  });

  it("keeps a stranger naming the conversation out of it, and junks only what's shown", async () => {
    const stranger = mail({ subject: "You won!", from: "Spam <spam@x.com>", inReplyTo: a.id });
    const lookalike = mail({ subject: "RE: lunch?", from: "Spam <spam@x.com>", inReplyTo: a.id });
    await seed.append("INBOX", stranger.raw);
    await seed.append("Work", lookalike.raw);
    await sync(accountId);
    const thread = () => store.getThreadMessages(accountId, lunch).map((m) => m.id);
    expect(thread()).not.toContain(cachedByHeader(accountId, stranger.id)!.id);
    expect(thread()).toContain(cachedByHeader(accountId, lookalike.id)!.id);

    // Reported from the Inbox: the Inbox's own go to Junk, the rest stays put.
    await provider.modifyThread(accountId, lunch, {
      addLabelIds: ["SPAM"],
      removeLabelIds: ["INBOX"],
    });
    expect(pathOf(cachedByHeader(accountId, lookalike.id)!.id)).toBe("Work");
    expect(pathOf(cachedByHeader(accountId, b.id)!.id)).toBe("Sent");
    const junked = cachedByHeader(accountId, a.id)!;
    expect(junked.labels).toContain("SPAM");
    await provider.modifyThread(accountId, lunch, {
      addLabelIds: ["INBOX"],
      removeLabelIds: ["SPAM"],
    });
    expect(pathOf(cachedByHeader(accountId, a.id)!.id)).toBe("INBOX");
    expect(pathOf(cachedByHeader(accountId, lookalike.id)!.id)).toBe("Work");
    await provider.deleteForever(accountId, [
      cachedByHeader(accountId, stranger.id)!.id,
      cachedByHeader(accountId, lookalike.id)!.id,
    ]);
    await sync(accountId);
  });

  it("marks read and unread", async () => {
    const { id } = cachedByHeader(accountId, c.id)!;
    await provider.modifyMessage(accountId, id, { removeLabelIds: ["UNREAD"] });
    expect(
      await seed.select("INBOX").then(() => seed.search({ messageId: c.id, seen: true })),
    ).toHaveLength(1);
  });

  it("archives a conversation, leaving your reply in Sent", async () => {
    const threadId = lunch;
    await provider.modifyThread(accountId, threadId, { removeLabelIds: ["INBOX"] });
    const original = cachedByHeader(accountId, a.id)!;
    expect(pathOf(original.id)).toBe("Archive");
    expect(original.labels.sort()).toEqual(["ARCHIVE", "STARRED"]);
    expect(pathOf(cachedByHeader(accountId, b.id)!.id)).toBe("Sent");
    expect(await serverSearch("INBOX", a.id)).toEqual([]);
    expect(await serverSearch("Archive", a.id)).toHaveLength(1);
    // The old id still finds it.
    expect(store.getThreadMessages(accountId, threadId)).toHaveLength(2);
    await sync(accountId);
    expect(pathOf(cachedByHeader(accountId, a.id)!.id)).toBe("Archive");
    expect(store.getLabels(accountId).find((l) => l.id === "ARCHIVE")).toMatchObject({
      type: "system",
      total: 1,
    });
  });

  it("gives ARCHIVE to archived mail cached before the Archive had a label", async () => {
    const { id } = cachedByHeader(accountId, a.id)!;
    // As an older version left it: no label for the Archive's mail, nor in its sync state.
    store.applyHistoryChanges(accountId, [{ kind: "labelsRemoved", id, labelIds: ["ARCHIVE"] }]);
    const key = `imapSync:${accountId}`;
    const state = JSON.parse(store.getKv(key)!) as Record<string, { label?: string | null }>;
    for (const folder of Object.values(state)) delete folder.label;
    store.setKv(key, JSON.stringify(state));

    await sync(accountId);
    expect(cachedByHeader(accountId, a.id)!.labels.sort()).toEqual(["ARCHIVE", "STARRED"]);
    expect(cachedByHeader(accountId, b.id)!.labels).toEqual(["SENT"]);
  });

  it("moves to a folder, and back to the inbox", async () => {
    const threadId = lunch;
    await provider.modifyThread(accountId, threadId, { addLabelIds: ["Work"] });
    const moved = cachedByHeader(accountId, a.id)!;
    expect(pathOf(moved.id)).toBe("Work");
    expect(moved.labels.sort()).toEqual(["STARRED", "Work"]);
    expect(pathOf(cachedByHeader(accountId, b.id)!.id)).toBe("Sent");

    await provider.modifyMessage(accountId, moved.id, {
      addLabelIds: ["INBOX"],
      removeLabelIds: ["Work"],
    });
    expect(pathOf(cachedByHeader(accountId, a.id)!.id)).toBe("INBOX");
    expect(await serverSearch("INBOX", a.id)).toHaveLength(1);
  });

  it("trashes a conversation and restores it where it was", async () => {
    const threadId = lunch;
    await provider.trashThread(accountId, threadId);
    expect(cachedByHeader(accountId, a.id)!.labels).toContain("TRASH");
    expect(pathOf(cachedByHeader(accountId, b.id)!.id)).toBe(
      pathOf(cachedByHeader(accountId, a.id)!.id),
    );
    const restored = await provider.untrashThread(accountId, threadId);
    expect(restored.map((m) => pathOf(m.id)).sort()).toEqual(["INBOX", "Sent"]);
    expect(pathOf(cachedByHeader(accountId, a.id)!.id)).toBe("INBOX");
    expect(pathOf(cachedByHeader(accountId, b.id)!.id)).toBe("Sent");
  });

  it("remembers where trashed mail came from across restarts", async () => {
    await provider.trashMessage(accountId, cachedByHeader(accountId, w1.id)!.id);
    const trashed = cachedByHeader(accountId, w1.id)!.id;
    // Kept in the cache's kv (nothing in memory), so a restart doesn't send it to the Inbox.
    expect(JSON.parse(store.getKv(`imapTrashedFrom:${accountId}`)!)).toEqual({ [trashed]: "Work" });
    const restored = await provider.untrashMessage(accountId, trashed);
    expect(restored.map((m) => pathOf(m.id))).toEqual(["Work"]);
    expect(JSON.parse(store.getKv(`imapTrashedFrom:${accountId}`)!)).toEqual({});
  });

  it("deletes forever, and empties the trash", async () => {
    await provider.trashMessage(accountId, cachedByHeader(accountId, c.id)!.id);
    const trashed = cachedByHeader(accountId, c.id)!;
    const trash = pathOf(trashed.id);
    await provider.deleteForever(accountId, [trashed.id]);
    expect(await serverSearch(trash, c.id)).toEqual([]);

    await provider.trashMessage(accountId, cachedByHeader(accountId, w1.id)!.id);
    const w1Id = cachedByHeader(accountId, w1.id)!.id;
    const deleted = await provider.emptyFolder(accountId, "TRASH", [w1Id]);
    expect(deleted).toContain(w1Id);
    expect((await seed.status(trash)).messages).toBe(0);
  });

  it("saves drafts, replacing each version, and deletes them", async () => {
    const first = await provider.saveDraft(accountId, {
      to: "ann@example.com",
      subject: "Draft",
      body: "One",
    });
    expect(first.messageId).toBeTruthy();
    expect(await provider.getDraftVersion(accountId, first.draftId)).toBe(first.messageId);
    const second = await provider.saveDraft(accountId, {
      to: "ann@example.com",
      subject: "Draft",
      body: "Two",
      draftId: first.draftId,
      threadId: first.threadId,
    });
    expect(second.draftId).toBe(first.draftId);
    // A new message's draft doesn't reference itself.
    expect(await provider.getReplyHeaders(accountId, second.messageId!)).toEqual({
      messageIdHeader: first.draftId,
      referencesHeader: null,
    });
    expect(second.messageId).not.toBe(first.messageId);
    expect(await provider.getDraftVersion(accountId, first.draftId)).toBe(second.messageId);
    expect((await provider.getMessage(accountId, second.messageId!)).bodyText).toContain("Two");

    await sync(accountId);
    const cached = cachedByHeader(accountId, first.draftId)!;
    expect(cached.labels).toContain("DRAFT");
    expect(await provider.findDraftId(accountId, cached.id)).toBe(first.draftId);

    expect(await provider.deleteDraft(accountId, first.draftId)).toEqual({
      messageId: second.messageId,
    });
    expect(await provider.getDraftVersion(accountId, first.draftId)).toBeNull();
  });

  it("replaces only the draft's own versions, whatever else mentions its id", async () => {
    const saved = await provider.saveDraft(accountId, { to: "", subject: "Mine", body: "1" });
    const drafts = pathOf(saved.messageId!);
    // SEARCH HEADER matches substrings: this one's Message-ID contains the draft's.
    const decoy = mail({ subject: "Decoy" }).raw.replace(
      /^Message-ID: .*$/m,
      `Message-ID: ${saved.draftId}x`,
    );
    await seed.append(drafts, decoy);
    await provider.saveDraft(accountId, {
      to: "",
      subject: "Mine",
      body: "2",
      draftId: saved.draftId,
    });
    await seed.select(drafts);
    expect(await seed.search({ header: { name: "Subject", value: "Decoy" } })).toHaveLength(1);
    await provider.deleteDraft(accountId, saved.draftId);
    expect(await seed.search({ header: { name: "Subject", value: "Decoy" } })).toHaveLength(1);
    // Not a whole Message-ID: nothing to find (or delete).
    expect(await provider.getDraftVersion(accountId, "")).toBeNull();
    expect(await provider.getDraftVersion(accountId, saved.draftId.slice(1, -1))).toBeNull();
  });

  it("creates, renames and deletes folders, keeping their mail", async () => {
    const label = await provider.createLabel(accountId, "Projects/2026");
    expect(label).toMatchObject({ name: "Projects/2026", type: "user" });
    const { id } = cachedByHeader(accountId, a.id)!;
    await provider.modifyMessage(accountId, id, {
      addLabelIds: [label.id],
      removeLabelIds: ["INBOX"],
    });
    await sync(accountId);

    await provider.updateLabel(accountId, { labelId: label.id, name: "Projects/Now" });
    const labels = await provider.listLabels(accountId);
    const renamed = labels.find((l) => l.name === "Projects/Now")!;
    expect(renamed).toBeTruthy();
    expect(cachedByHeader(accountId, a.id)!.labels).toContain(renamed.id);

    await provider.deleteLabel(accountId, renamed.id);
    expect(pathOf(cachedByHeader(accountId, a.id)!.id)).toBe("Archive");
    expect((await provider.listLabels(accountId)).some((l) => l.id === renamed.id)).toBe(false);
  });

  it("hears new mail while idling", async () => {
    let changes = 0;
    const stop = provider.watch!(accountId, () => changes++);
    try {
      // Every (re)connect reports once, to catch up.
      await waitFor(() => (changes > 0 ? true : undefined));
      changes = 0;
      await seed.append("INBOX", mail({ subject: "While idling" }).raw);
      await waitFor(() => (changes > 0 ? true : undefined));

      // Woken up (or a browser tab shown again): the same connection, checked, and a catch-up.
      changes = 0;
      const connections = connectionCount();
      resumeNow();
      await waitFor(() => (changes > 0 ? true : undefined));
      expect(connectionCount()).toBe(connections);
      changes = 0;
      await seed.append("INBOX", mail({ subject: "After waking" }).raw);
      await waitFor(() => (changes > 0 ? true : undefined));
    } finally {
      stop();
    }
  }, 20_000);

  it("starts a folder over when its UIDVALIDITY changes", async () => {
    await seed.select("INBOX");
    await seed.deleteMailbox("Work");
    await seed.createMailbox("Work");
    const w3 = mail({ subject: "Fresh report" });
    await seed.append("Work", w3.raw);
    const { uidValidity } = await seed.status("Work");

    await sync(accountId);
    const work = store.getMessageIdsWithPrefix(accountId, "").filter((id) => pathOf(id) === "Work");
    expect(work).toEqual([`${uidValidity}:${work[0]!.split(":")[1]}:Work`]);
    expect(cachedByHeader(accountId, w3.id)!.labels.sort()).toEqual(["UNREAD", "Work"]);
  });

  it("sends, filing it in Sent (and, sent to yourself, it arrives)", async ({ skip }) => {
    if (!server().smtp) skip();
    const subject = `Note to self ${counter++}`;
    const { messageId } = await provider.send(accountId, {
      to: accountId,
      bcc: "bob@example.com",
      subject,
      body: "Remember the milk.",
    });
    expect(pathOf(messageId!)).toBe("Sent");
    const [sent] = await provider.getSummaries(accountId, [messageId!]);
    expect(sent).toMatchObject({ subject, unread: false, labelIds: ["SENT"] });
    expect((await provider.getMessage(accountId, messageId!)).bcc).toBe("bob@example.com");

    let arrived: MessageSummary | undefined;
    for (let i = 0; i < 50 && !arrived; i++) {
      await sync(accountId);
      arrived = store
        .getThreadMessages(accountId, sent!.threadId)
        .find((m) => m.labelIds.includes("INBOX"));
      if (!arrived) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(arrived).toMatchObject({ subject });
  });

  it("sends a ready-made message without its Bcc", async ({ skip }) => {
    if (!server().smtp) skip();
    const subject = `Raw ${counter++}`;
    await provider.sendRaw(
      accountId,
      [
        `From: ${accountId}`,
        `To: ${accountId}`,
        "Bcc: bob@example.com,",
        " carol@example.com",
        `Subject: ${subject}`,
        "",
        "Hi",
        "",
      ].join("\r\n"),
    );
    await seed.select("Sent");
    const [uid] = await seed.search({ header: { name: "Subject", value: subject } });
    const [filed] = await seed.fetch([uid!], { headers: true });
    expect(Object.keys(filed!.headers!)).not.toContain("bcc");
    expect(filed!.headers!.subject).toBe(subject);
  });

  it("says what's wrong with a wrong password", async () => {
    const { settings, password } = server();
    await provider.removeAccount(accountId); // drops the logged-in connection
    await setImapPassword(accountId, "nope");
    try {
      const err = await sync(accountId).catch((e: unknown) => e);
      expect(provider.errorKind(err)).toBe("auth");
      expect(provider.describeError(err)).toBe(`Wrong password for ${settings.username}`);
      // Set aside, so nothing logs in with it again until the user enters one.
      expect(provider.isSignedIn(accountId)).toBe(false);
      await expect(sync(accountId)).rejects.toThrow(/Enter the password/);

      // IDLE gives up at once too, telling the engine (which then stops it).
      await setImapPassword(accountId, "nope");
      let told = 0;
      const stop = provider.watch!(accountId, () => told++);
      await waitFor(() => (told > 0 ? true : undefined));
      stop();
      expect(provider.isSignedIn(accountId)).toBe(false);
    } finally {
      await setImapPassword(accountId, password);
    }
  }, 30_000);
}

describe.skipIf(!docker)("IMAP provider on Dovecot (QRESYNC)", () => {
  let container: Container;
  beforeAll(async () => {
    container = await startDovecot();
  }, 300_000);
  afterAll(async () => {
    await container?.stop();
  });

  providerScenario(() => ({
    accountId: "ann@example.com",
    password: "pass",
    smtp: false,
    settings: {
      username: "ann@example.com",
      imap: { host: container.host, port: container.port(31993), security: "tls" },
      smtp: { host: container.host, port: 1, security: "tls" },
    },
  }));
});

describe.skipIf(!docker)("IMAP provider on GreenMail (no mod-sequences)", () => {
  let container: Container;
  beforeAll(async () => {
    container = await startGreenMail();
  }, 300_000);
  afterAll(async () => {
    await container?.stop();
  });

  providerScenario(() => ({
    accountId: "alice@example.com",
    password: "secret",
    smtp: true,
    settings: {
      username: "alice@example.com",
      imap: { host: container.host, port: container.port(3993), security: "tls" },
      smtp: { host: container.host, port: container.port(3465), security: "tls" },
    },
  }));
});
