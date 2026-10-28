/**
 * Archiving on every kind of IMAP server, against a pretend one (no Docker):
 * the Archive found by its special use or its name, made (flagged \Archive)
 * where there's none, Gmail's archive being All Mail (out of the inbox, never
 * a copy, and back with a copy only; only its archived mail synced), and
 * moves with MOVE or, without it, COPY + \Deleted + EXPUNGE. Archived mail
 * carries ARCHIVE, except Gmail's, which is All Mail's as in Gmail.
 */

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ImapFolder, SpecialUse } from "../../../protocols/index.ts";
import { FakeStream, tagOf } from "../../../protocols/test/fake-stream.ts";
import * as accounts from "../../../services/account-store.ts";
import { setImapPassword } from "../../../services/imap-passwords.ts";
import * as store from "../../../services/mail-store.ts";
import { Folders } from "../folders.ts";
import { imapProvider } from "../index.ts";
import { useNodePlatform } from "./node-platform.ts";

const platform = useNodePlatform();
const provider = imapProvider;

type Box = { flags: string; uidValidity: number; uidNext: number; uids: number[] };

/** A pretend IMAP server: its folders, and every command it was sent (tags dropped). */
class PretendServer {
  readonly boxes = new Map<string, Box>();
  readonly commands: string[] = [];
  private selected: Box | null = null;
  private validity = 100;

  constructor(
    private readonly capabilities: string,
    folders: Record<string, string>,
  ) {
    for (const [path, flags] of Object.entries(folders)) this.create(path, flags);
  }

  create(path: string, flags = ""): void {
    this.boxes.set(path, { flags, uidValidity: ++this.validity, uidNext: 1, uids: [] });
  }

  /** New mail in a folder: its UID. */
  deliver(path: string): number {
    const box = this.boxes.get(path)!;
    box.uids.push(box.uidNext);
    return box.uidNext++;
  }

  idOf(path: string, uid: number): string {
    return `${this.boxes.get(path)!.uidValidity}:${uid}:${path}`;
  }

  connect = async () =>
    new FakeStream(`* PREAUTH [CAPABILITY ${this.capabilities}] ready\r\n`, (text) =>
      this.answer(text),
    );

  private answer(text: string): string {
    const tag = tagOf(text);
    const command = text.slice(tag.length + 1).trim();
    this.commands.push(command);
    const args = (command.match(/"(?:[^"\\]|\\.)*"|\(.*\)|\S+/g) ?? []).map((arg) =>
      arg.startsWith('"') ? arg.slice(1, -1) : arg,
    );
    const verb = args[0] === "UID" ? `UID ${args[1]}` : args[0];
    const box = (name: string) => this.boxes.get(name)!;
    const moved = (uids: number[], to: Box) =>
      uids.map((uid) => {
        to.uids.push(to.uidNext);
        return [uid, to.uidNext++];
      });
    const copyUid = (to: Box, pairs: number[][]) =>
      `[COPYUID ${to.uidValidity} ${pairs.map((p) => p[0]).join(",")} ${pairs.map((p) => p[1]).join(",")}]`;
    switch (verb) {
      case "LIST":
        return [
          ...[...this.boxes].map(
            ([path, b]) => `* LIST (\\HasNoChildren${b.flags ? ` ${b.flags}` : ""}) "/" "${path}"`,
          ),
          `${tag} OK done`,
          "",
        ].join("\r\n");
      case "STATUS": {
        const b = box(args[1]!);
        return `* STATUS "${args[1]}" (MESSAGES ${b.uids.length} UIDNEXT ${b.uidNext} UIDVALIDITY ${b.uidValidity} UNSEEN ${b.uids.length})\r\n${tag} OK done\r\n`;
      }
      case "SELECT": {
        const b = (this.selected = box(args[1]!));
        return `* ${b.uids.length} EXISTS\r\n* OK [UIDVALIDITY ${b.uidValidity}] ok\r\n* OK [UIDNEXT ${b.uidNext}] ok\r\n${tag} OK [READ-WRITE] done\r\n`;
      }
      case "UID MOVE": {
        const uids = args[2]!.split(",").map(Number);
        const to = box(args[3]!);
        this.selected!.uids = this.selected!.uids.filter((uid) => !uids.includes(uid));
        return `* OK ${copyUid(to, moved(uids, to))} moved\r\n${tag} OK done\r\n`;
      }
      case "UID COPY": {
        const to = box(args[3]!);
        return `${tag} OK ${copyUid(to, moved(args[2]!.split(",").map(Number), to))} done\r\n`;
      }
      case "UID EXPUNGE": {
        const uids = new Set(args[2]!.split(",").map(Number));
        this.selected!.uids = this.selected!.uids.filter((uid) => !uids.has(uid));
        return `${tag} OK done\r\n`;
      }
      case "CREATE": {
        const use = /USE \((\\\w+)\)/.exec(args[2] ?? "")?.[1];
        this.create(args[1]!, this.capabilities.includes("CREATE-SPECIAL-USE") ? use : "");
        return `${tag} OK done\r\n`;
      }
      case "LOGOUT":
        return `* BYE bye\r\n${tag} OK done\r\n`;
      default:
        return `${tag} OK done\r\n`;
    }
  }
}

let server: PretendServer;
platform.connect = async () => server.connect();

let counter = 0;
/** An IMAP mailbox on `server`, with a conversation: Bob's mail in INBOX, your reply in Sent. */
async function mailbox(sent: string) {
  const accountId = `me${++counter}@example.com`;
  await accounts.addAccount({
    id: accountId,
    email: accountId,
    name: "Me",
    provider: "imap",
    imap: {
      username: accountId,
      imap: { host: "imap.example.com", port: 993, security: "tls" },
      smtp: { host: "smtp.example.com", port: 465, security: "tls" },
    },
  });
  await setImapPassword(accountId, "secret");
  const row = (id: string, labelIds: string[], fromEmail: string) => ({
    id,
    threadId: "t",
    fromName: "",
    fromEmail,
    to: accountId,
    subject: "Lunch?",
    snippet: "",
    date: Date.now(),
    unread: labelIds.includes("UNREAD"),
    starred: false,
    labelIds,
    hasAttachments: false,
  });
  const inbox = server.idOf("INBOX", server.deliver("INBOX"));
  const reply = server.idOf(sent, server.deliver(sent));
  store.upsertMessages(accountId, [
    row(inbox, ["INBOX", "UNREAD"], "bob@example.com"),
    row(reply, ["SENT"], accountId),
  ]);
  return { accountId, reply };
}

/** The conversation's cached messages: where each is, and its labels. */
const thread = (accountId: string) =>
  store
    .getThreadMessages(accountId, "t")
    .map((m) => ({ path: m.id.split(":").slice(2).join(":"), labels: m.labelIds.sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));

afterEach(async () => {
  for (const account of await accounts.listAccounts()) {
    await provider.removeAccount(account.id);
    await accounts.removeAccount(account.id);
  }
});

describe("Archiving over IMAP", () => {
  it("moves the inbox's mail to the folder flagged \\Archive, your reply staying in Sent", async () => {
    server = new PretendServer("IMAP4rev1 MOVE UIDPLUS SPECIAL-USE LIST-EXTENDED", {
      INBOX: "",
      Sent: "\\Sent",
      Archive: "",
      "Old mail": "\\Archive",
    });
    const { accountId } = await mailbox("Sent");

    await provider.modifyThread(accountId, "t", { removeLabelIds: ["INBOX"] });
    expect(server.commands).toContain('UID MOVE 1 "Old mail"');
    expect(thread(accountId)).toEqual([
      { path: "Old mail", labels: ["ARCHIVE", "UNREAD"] },
      { path: "Sent", labels: ["SENT"] },
    ]);
    // The sidebar's Archive, with the server's counts; a folder named Archive is just a folder.
    const labels = await provider.listLabels(accountId);
    expect(labels.find((l) => l.id === "ARCHIVE")).toMatchObject({
      type: "system",
      total: 1,
      unread: 1,
    });
    expect(labels.find((l) => l.id === "Archive")).toMatchObject({ type: "user" });

    // Undo: back to the inbox.
    await provider.modifyThread(accountId, "t", { addLabelIds: ["INBOX"] });
    expect(server.commands.at(-1)).toBe("UID MOVE 1 INBOX");
    expect(thread(accountId)).toEqual([
      { path: "INBOX", labels: ["INBOX", "UNREAD"] },
      { path: "Sent", labels: ["SENT"] },
    ]);
  });

  it("finds an unflagged archive by name, and takes mail out of it when ARCHIVE goes", async () => {
    server = new PretendServer("IMAP4rev1 MOVE UIDPLUS", {
      INBOX: "",
      Sent: "",
      Archives: "",
    });
    const { accountId } = await mailbox("Sent");

    await provider.modifyThread(accountId, "t", { removeLabelIds: ["INBOX"] });
    expect(server.commands).toContain('UID MOVE 1 "Archives"');
    expect(thread(accountId)[0]).toEqual({ path: "Archives", labels: ["ARCHIVE", "UNREAD"] });

    await provider.modifyThread(accountId, "t", { removeLabelIds: ["ARCHIVE"] });
    expect(thread(accountId)).toEqual([
      { path: "INBOX", labels: ["INBOX", "UNREAD"] },
      { path: "Sent", labels: ["SENT"] },
    ]);
  });

  it("makes an Archive flagged \\Archive where there's none, and copies where MOVE isn't there", async () => {
    server = new PretendServer("IMAP4rev1 UIDPLUS SPECIAL-USE LIST-EXTENDED CREATE-SPECIAL-USE", {
      INBOX: "",
      Sent: "\\Sent",
    });
    const { accountId } = await mailbox("Sent");

    await provider.modifyThread(accountId, "t", { removeLabelIds: ["INBOX"] });
    const created = server.commands.indexOf('CREATE "Archive" (USE (\\Archive))');
    expect(created).toBeGreaterThan(-1);
    expect(server.commands.slice(created)).toEqual(
      expect.arrayContaining([
        'UID COPY 1 "Archive"',
        "UID STORE 1 +FLAGS.SILENT (\\Deleted)",
        "UID EXPUNGE 1",
      ]),
    );
    expect(server.boxes.get("INBOX")!.uids).toEqual([]);
    expect(thread(accountId)[0]).toEqual({ path: "Archive", labels: ["ARCHIVE", "UNREAD"] });
  });

  it("archives Gmail's IMAP into All Mail: out of the inbox, and back with a copy", async () => {
    server = new PretendServer("IMAP4rev1 MOVE UIDPLUS SPECIAL-USE LIST-EXTENDED X-GM-EXT-1", {
      INBOX: "",
      "[Gmail]/All Mail": "\\All",
      "[Gmail]/Sent Mail": "\\Sent",
      // A Gmail label named Archive: archiving mustn't add it.
      Archive: "",
    });
    const { accountId } = await mailbox("[Gmail]/Sent Mail");

    await provider.modifyThread(accountId, "t", { removeLabelIds: ["INBOX"] });
    expect(server.commands).toContain('UID MOVE 1 "[Gmail]/All Mail"');
    expect(server.commands.some((c) => c.startsWith("CREATE"))).toBe(false);
    expect(server.boxes.get("Archive")!.uids).toEqual([]);
    // Gmail's archived mail is All Mail's: no folder label, nor ARCHIVE.
    expect(thread(accountId)).toEqual([
      { path: "[Gmail]/All Mail", labels: ["UNREAD"] },
      { path: "[Gmail]/Sent Mail", labels: ["SENT"] },
    ]);
    expect((await provider.listLabels(accountId)).map((l) => l.id)).not.toContain("ARCHIVE");

    // Undo: a copy back into the inbox; taking it out of All Mail would delete it in Gmail.
    const sent = server.commands.length;
    await provider.modifyThread(accountId, "t", { addLabelIds: ["INBOX"] });
    const undo = server.commands.slice(sent);
    expect(undo).toContain("UID COPY 1 INBOX");
    expect(undo.some((c) => /MOVE|STORE|EXPUNGE/.test(c))).toBe(false);
    expect(thread(accountId)[1]).toEqual({ path: "INBOX", labels: ["INBOX", "UNREAD"] });
  });
});

describe("Finding the archive", () => {
  const folder = (path: string, specialUse: SpecialUse | null = null): ImapFolder => ({
    path,
    name: path.split("/").pop()!,
    delimiter: "/",
    flags: [],
    specialUse,
    selectable: true,
  });

  it("takes the folder flagged \\Archive, else one named like it", () => {
    const flagged = new Folders([folder("INBOX"), folder("Archive"), folder("Kept", "\\Archive")]);
    expect(flagged.archive?.path).toBe("Kept");
    expect(flagged.forLabel("ARCHIVE")?.path).toBe("Kept");
    expect(flagged.get("Archive")?.labelId).toBe("Archive");
    expect(new Folders([folder("INBOX"), folder("Archiv")]).archive?.labelId).toBe("ARCHIVE");
    expect(new Folders([folder("INBOX")]).archive).toBeUndefined();
  });

  it("archives into All Mail only on Gmail's server", () => {
    const list = [folder("INBOX"), folder("All", "\\All"), folder("Archive")];
    // A server's virtual All folder (Dovecot) isn't somewhere to move mail.
    expect(new Folders(list).archive?.path).toBe("Archive");
    const gmail = new Folders([...list, folder("Important", "\\Important")], true);
    expect(gmail.archive?.path).toBe("All");
    expect(gmail.isAllMail("All")).toBe(true);
    // Of All Mail, only what's archived (Gmail's search) is synced; Important holds copies.
    expect(gmail.synced.map((f) => [f.path, f.labelId, f.gmailRaw])).toEqual([
      ["INBOX", "INBOX", undefined],
      ["Archive", "Archive", undefined],
      ["All", null, "-in:inbox -in:sent -in:drafts -in:chats has:nouserlabels"],
    ]);
  });
});

describe("Gmail over IMAP", () => {
  it("is Gmail to the app: All Mail, not an Archive folder, and stars", async () => {
    const { capabilitiesOf } = await import("../../index.ts");
    const settings = (host: string) => ({
      id: "me@example.com",
      email: "me@example.com",
      name: "Me",
      provider: "imap" as const,
      imap: {
        username: "me@example.com",
        imap: { host, port: 993, security: "tls" as const },
        smtp: { host, port: 465, security: "tls" as const },
      },
    });
    expect(capabilitiesOf(settings("imap.gmail.com"))).toMatchObject({
      archiveFolder: false,
      stars: true,
    });
    expect(capabilitiesOf(settings("imap.fastmail.com"))).toMatchObject({ archiveFolder: true });
    expect(capabilitiesOf(settings("imap.fastmail.com"))?.stars).toBeUndefined();
  });
});
