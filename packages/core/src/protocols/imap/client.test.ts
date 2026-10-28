import { describe, expect, it } from "vite-plus/test";
import { FakeStream, tagOf } from "../test/fake-stream.ts";
import { connectImap, ImapError, type ImapOptions, type ImapUpdate } from "./client.ts";

const options = (stream: FakeStream, extra: Partial<ImapOptions> = {}): ImapOptions => ({
  host: "imap.example.com",
  port: 143,
  security: "starttls",
  auth: { user: "ann@example.com", pass: "pässword" },
  connect: async () => stream,
  ...extra,
});

describe("ImapClient against a pretend server", () => {
  it("upgrades, logs in with PLAIN, and waits for the server before sending a literal", async () => {
    const stream = new FakeStream("* OK ready\r\n", (text, server) => {
      const tag = tagOf(text);
      if (text.includes("CAPABILITY")) {
        const caps = server.tls ? "IMAP4rev1 AUTH=PLAIN" : "IMAP4rev1 STARTTLS LOGINDISABLED";
        return `* CAPABILITY ${caps}\r\n${tag} OK\r\n`;
      }
      if (text.includes("STARTTLS")) return `${tag} OK Begin TLS\r\n`;
      if (text.startsWith(`${tag} AUTHENTICATE PLAIN`)) return "+ \r\n";
      if (text === "AGFubkBleGFtcGxlLmNvbQBww6Rzc3dvcmQ=\r\n") {
        return "A4 OK [CAPABILITY IMAP4rev1 UIDPLUS] Logged in\r\n";
      }
      if (text.includes("APPEND")) return "+ go ahead\r\n";
      if (text.startsWith("From:")) return "A5 OK [APPENDUID 99 7] Stored\r\n";
      return undefined;
    });
    const client = await connectImap(options(stream));
    expect(stream.tls).toBe(true);
    expect([...client.capabilities]).toEqual(["IMAP4REV1", "UIDPLUS"]);

    const stored = await client.append("Entwürfe", "From: a\r\n\r\nhi\r\n", {
      flags: ["\\Seen"],
      date: new Date("2026-01-02T03:04:05Z"),
    });
    expect(stored).toEqual({ uidValidity: 99, uid: 7 });
    expect(stream.written.slice(-3)).toEqual([
      'A5 APPEND "Entw&APw-rfe" (\\Seen) "02-Jan-2026 03:04:05 +0000" {15}\r\n',
      "From: a\r\n\r\nhi\r\n",
      "\r\n",
    ]);
  });

  it("lists folders with their special use, names decoded", async () => {
    const stream = new FakeStream(
      "* PREAUTH [CAPABILITY IMAP4rev1 SPECIAL-USE LIST-EXTENDED] hi\r\n",
      (text) =>
        [
          '* LIST (\\HasNoChildren) "/" "INBOX"',
          '* LIST (\\HasChildren \\Noselect) "/" "[Gmail]"',
          '* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Envoy&AOk-s"',
          '* LIST (\\HasNoChildren \\Trash) "/" {7}\r\nCorbeil',
          `${tagOf(text)} OK LIST done`,
          "",
        ].join("\r\n"),
    );
    const client = await connectImap(options(stream, { security: "tls" }));
    const folders = await client.list();
    expect(stream.written[0]).toBe('A1 LIST "" "*" RETURN (SPECIAL-USE)\r\n');
    expect(folders).toEqual([
      {
        path: "INBOX",
        name: "INBOX",
        delimiter: "/",
        flags: ["\\HasNoChildren"],
        specialUse: null,
        selectable: true,
      },
      {
        path: "[Gmail]",
        name: "[Gmail]",
        delimiter: "/",
        flags: ["\\HasChildren", "\\Noselect"],
        specialUse: null,
        selectable: false,
      },
      {
        path: "[Gmail]/Envoyés",
        name: "Envoyés",
        delimiter: "/",
        flags: ["\\HasNoChildren", "\\Sent"],
        specialUse: "\\Sent",
        selectable: true,
      },
      {
        path: "Corbeil",
        name: "Corbeil",
        delimiter: "/",
        flags: ["\\HasNoChildren", "\\Trash"],
        specialUse: "\\Trash",
        selectable: true,
      },
    ]);
  });

  it("tells a refused XOAUTH2 login apart", async () => {
    const stream = new FakeStream(
      "* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=XOAUTH2] ready\r\n",
      (text) => {
        if (text.includes("AUTHENTICATE XOAUTH2")) return "+ eyJzdGF0dXMiOiI0MDAifQ==\r\n";
        if (text === "\r\n") return "A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n";
        return undefined;
      },
    );
    const error = await connectImap(
      options(stream, { security: "tls", auth: { user: "a@x", accessToken: "t" } }),
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImapError);
    expect(error).toMatchObject({
      kind: "auth",
      status: "NO",
      code: "AUTHENTICATIONFAILED",
      serverText: "Invalid credentials",
    });
    expect(stream.closed).toBe(true);
  });

  it("moves without MOVE: copy, flag deleted, expunge just those", async () => {
    const stream = new FakeStream("* PREAUTH [CAPABILITY IMAP4rev1 UIDPLUS] hi\r\n", (text) => {
      const tag = tagOf(text);
      if (text.includes("UID COPY")) return `${tag} OK [COPYUID 5 3:4 10:11] Copied\r\n`;
      if (text.includes("UID EXPUNGE")) return `* 1 EXPUNGE\r\n* 1 EXPUNGE\r\n${tag} OK\r\n`;
      return `${tag} OK\r\n`;
    });
    const client = await connectImap(options(stream, { security: "tls" }));
    const moved = await client.move([4, 3], "Archive");
    expect(moved).toEqual({
      uidValidity: 5,
      uids: new Map([
        [3, 10],
        [4, 11],
      ]),
    });
    expect(stream.written).toEqual([
      'A1 UID COPY 3:4 "Archive"\r\n',
      "A2 UID STORE 3:4 +FLAGS.SILENT (\\Deleted)\r\n",
      "A3 UID EXPUNGE 3:4\r\n",
    ]);
  });

  it("reports updates while idling and stops cleanly", async () => {
    const stream = new FakeStream(
      "* PREAUTH [CAPABILITY IMAP4rev1 IDLE] hi\r\n",
      (text, server) => {
        if (text.includes("IDLE")) {
          setTimeout(() => server.send("* 4 EXISTS\r\n* 2 FETCH (FLAGS (\\Seen) UID 9)\r\n"), 5);
          return "+ idling\r\n";
        }
        if (text === "DONE\r\n") return "A1 OK IDLE done\r\n";
        return `${tagOf(text)} OK\r\n`;
      },
    );
    const client = await connectImap(options(stream, { security: "tls" }));
    const updates: ImapUpdate[] = [];
    const idle = await client.idle((update) => updates.push(update));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await idle.stop();
    expect(updates).toEqual([
      { type: "exists", count: 4 },
      { type: "fetch", message: { seq: 2, uid: 9, flags: ["\\Seen"] } },
    ]);
    await client.noop();
    expect(stream.written.at(-1)).toBe("A2 NOOP\r\n");
  });

  it("times out when the server goes quiet", async () => {
    const stream = new FakeStream("* PREAUTH [CAPABILITY IMAP4rev1] hi\r\n", () => undefined);
    const client = await connectImap(options(stream, { security: "tls", timeoutMs: 20 }));
    await expect(client.noop()).rejects.toMatchObject({ kind: "timeout" });
    expect(client.isOpen).toBe(false);
    await expect(client.noop()).rejects.toMatchObject({ kind: "network" });
  });

  it("says why the server hung up", async () => {
    const stream = new FakeStream("* PREAUTH [CAPABILITY IMAP4rev1] hi\r\n", (_text, server) => {
      server.send("* BYE Shutting down\r\n");
      server.close();
      return undefined;
    });
    const client = await connectImap(options(stream, { security: "tls" }));
    await expect(client.noop()).rejects.toMatchObject({
      kind: "network",
      status: "BYE",
      serverText: "Shutting down",
    });
  });

  it("searches with Gmail's own syntax (X-GM-RAW)", async () => {
    const stream = new FakeStream(
      "* PREAUTH [CAPABILITY IMAP4rev1 X-GM-EXT-1] hi\r\n",
      (text) => `* SEARCH 4 9\r\n${tagOf(text)} OK done\r\n`,
    );
    const client = await connectImap(options(stream, { security: "tls" }));
    expect(await client.search({ deleted: false, gmailRaw: "-in:inbox has:nouserlabels" })).toEqual(
      [4, 9],
    );
    expect(stream.written.at(-1)).toBe(
      'A1 UID SEARCH UNDELETED X-GM-RAW "-in:inbox has:nouserlabels"\r\n',
    );
  });
});
