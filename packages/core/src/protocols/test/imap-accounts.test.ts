/**
 * Adding an IMAP mailbox and signing it back in (handlers/imap-accounts.ts),
 * against GreenMail in Docker, on a fake platform. Skipped when Docker isn't
 * running.
 */

import { DatabaseSync } from "node:sqlite";
import type { ImapSettings } from "@otter-mail/contracts/mail";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { utf8Decode, utf8Encode } from "../../bytes.ts";
import { addImapAccount, signInImap } from "../../handlers/imap-accounts.ts";
import { removeLocalAccount } from "../../handlers/mail.ts";
import { setPlatform, type Platform } from "../../platform.ts";
import { getAccount } from "../../services/account-store.ts";
import { getImapPassword, loadImapPasswords } from "../../services/imap-passwords.ts";
import { nodeConnect } from "./node-stream.ts";
import { dockerAvailable, startGreenMail, type Container } from "./servers.ts";

const docker = dockerAvailable();

const files = new Map<string, string>();
const secrets = new Map<string, string>();
const broadcasts: string[] = [];
const database = new DatabaseSync(":memory:");

setPlatform({
  kind: "desktop",
  log: () => {},
  database: () => database,
  files: {
    read: async (path) => (files.has(path) ? utf8Encode(files.get(path)!) : null),
    write: async (path, data) => {
      files.set(path, typeof data === "string" ? data : utf8Decode(data));
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
  connect: nodeConnect,
  broadcast: (channel) => broadcasts.push(channel),
  setUnreadCount: () => {},
  // Adding a mailbox starts its sync and IDLE watch.
  onResume: () => () => {},
  asyncContext: () => ({ run: (_value, fn) => fn(), get: () => undefined }),
} as Partial<Platform> as Platform);

describe.skipIf(!docker)("IMAP accounts on GreenMail", () => {
  let server: Container;
  let settings: ImapSettings;

  beforeAll(async () => {
    server = await startGreenMail();
    settings = {
      username: "alice@example.com",
      imap: { host: server.host, port: server.port(3993), security: "tls" },
      smtp: { host: server.host, port: server.port(3465), security: "tls" },
    };
  }, 300_000);

  afterAll(async () => {
    await server?.stop();
  });

  it("refuses a wrong password, saving nothing", async () => {
    await expect(
      addImapAccount({ email: "alice@example.com", password: "wrong", imap: settings }),
    ).rejects.toThrow(/didn't accept the password for alice@example.com/);
    expect(await getAccount("alice@example.com")).toBeNull();
    expect(secrets.size).toBe(0);
  });

  it("says when it can't reach the server", async () => {
    const closed = { ...settings, imap: { ...settings.imap, port: 1 } };
    await expect(
      addImapAccount({ email: "alice@example.com", password: "secret", imap: closed }),
    ).rejects.toThrow(/Couldn't connect to 127\.0\.0\.1:1/);
  });

  it("adds the mailbox: password in the secrets, settings in accounts.json", async () => {
    const account = await addImapAccount({
      email: "Alice@example.com",
      name: "Alice",
      password: "secret",
      imap: settings,
    });
    expect(account).toMatchObject({
      id: "alice@example.com",
      email: "Alice@example.com",
      name: "Alice",
      provider: "imap",
      imap: settings,
      capabilities: { multipleLabels: false },
    });
    expect(await getAccount("alice@example.com")).toMatchObject({ provider: "imap" });
    expect(secrets.get("imap-password:alice@example.com")).toBe("secret");
    expect(JSON.stringify([...files.values()])).not.toContain("secret");
    expect(broadcasts).toContain("gmail:accounts-changed");
  });

  it("signs back in with the stored settings", async () => {
    secrets.clear();
    await loadImapPasswords();
    expect(getImapPassword("alice@example.com")).toBeNull();

    await expect(signInImap({ accountId: "alice@example.com", password: "nope" })).rejects.toThrow(
      /didn't accept the password/,
    );
    await signInImap({ accountId: "alice@example.com", password: "secret" });
    expect(getImapPassword("alice@example.com")).toBe("secret");
  });

  it("removing the mailbox deletes its password", async () => {
    await removeLocalAccount("alice@example.com");
    expect(await getAccount("alice@example.com")).toBeNull();
    expect(secrets.has("imap-password:alice@example.com")).toBe(false);
    expect(getImapPassword("alice@example.com")).toBeNull();
  });
});
