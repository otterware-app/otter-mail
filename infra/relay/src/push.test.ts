import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { devices, invalidate, register, remove } from "./push.ts";
import type { Env } from "./worker.ts";
import type { PutPushDeviceRequest } from "@otter-mail/contracts/relay";

let db: DatabaseSync;
let env: Env;
const session = {
  id: "phone",
  user: { id: "owner" },
  createdAt: 1,
  expiresAt: Date.now() + 100_000,
};
const registration: PutPushDeviceRequest = {
  token: "a".repeat(64),
  topic: "dev.otterware.mail.dev",
  environment: "sandbox",
  mode: "inbox",
  mailboxes: ["me@example.com"],
};

/** Uses real SQLite SQL/FKs, with the small subset of D1 called by the routing store. */
beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrations = resolve(import.meta.dirname, "../migrations");
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(resolve(migrations, file), "utf8"));
  db.exec(
    "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',1,0,0)",
  );
  db.exec(
    "INSERT INTO linked_accounts (user_id,email,provider,linked_at) VALUES ('owner','me@example.com','gmail',0), ('owner','imap@example.com','imap',0)",
  );
  const prepare = (sql: string) => {
    let values: (string | number)[] = [];
    const statement = {
      bind: (...params: (string | number)[]) => {
        values = params;
        return statement;
      },
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => {
        const result = db.prepare(sql).run(...values);
        return { meta: { changes: Number(result.changes) } };
      },
    };
    return statement;
  };
  env = {
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    APNS_SANDBOX_TOPIC: registration.topic,
  } as unknown as Env;
});

describe("push routing store", () => {
  it("rejects another user's unlinked mailbox without writing a device", async () => {
    for (const email of ["stranger@example.com"]) {
      await expect(
        register(env, session, { ...registration, mailboxes: [email] }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(db.prepare("SELECT * FROM push_devices").all()).toHaveLength(0);
  });

  it("registers linked IMAP mailboxes with the same session isolation", async () => {
    await register(env, session, { ...registration, mailboxes: ["imap@example.com"] });
    expect(await devices(env, "owner", "imap@example.com")).toHaveLength(1);
    expect(await devices(env, "another-user", "imap@example.com")).toHaveLength(0);
  });

  it("rechecks access and notification mode at delivery, and cascades unlink", async () => {
    await register(env, session, registration);
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(1);
    expect(await devices(env, "another-user", "me@example.com")).toHaveLength(0);
    db.exec(
      `INSERT INTO preferences (user_id,data,updated_at) VALUES ('owner','{"settings":{"notificationsMode":"off"}}',0)`,
    );
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(0);
    db.exec("DELETE FROM preferences");
    db.exec("DELETE FROM linked_accounts WHERE email='me@example.com'");
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(0);
    expect(db.prepare("SELECT * FROM push_mailboxes").all()).toHaveLength(0);
  });

  it("a revoked session cannot register after its earlier auth check, including central all-session revocation", async () => {
    await register(env, session, registration);
    await remove(env, "owner", session.id, true);
    await expect(register(env, session, registration)).rejects.toMatchObject({ status: 401 });
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(0);
    await remove(env, "owner", undefined, true);
    await expect(
      register(env, { ...session, id: "unregistered-in-flight" }, registration),
    ).rejects.toMatchObject({ status: 401 });
    await register(
      env,
      { ...session, id: "new-sign-in", createdAt: Date.now() + 100 },
      registration,
    );
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(1);
  });

  it("carries the more restrictive account/device filter without reading any mail", async () => {
    await register(env, session, { ...registration, mode: "all" });
    expect((await devices(env, "owner", "me@example.com"))[0]?.notification_mode).toBe("all");
    db.exec(
      `INSERT INTO preferences (user_id,data,updated_at) VALUES ('owner','{"settings":{"notificationsMode":"inbox"}}',0)`,
    );
    expect((await devices(env, "owner", "me@example.com"))[0]?.notification_mode).toBe("inbox");
    db.exec(`UPDATE preferences SET data='{"settings":{"notificationsMode":"all"}}'`);
    await register(env, session, registration);
    expect((await devices(env, "owner", "me@example.com"))[0]?.notification_mode).toBe("inbox");
  });

  it("doesn't retain expired sessions or let invalid-token cleanup delete a newer rotation", async () => {
    await register(env, session, registration);
    const [old] = await devices(env, "owner", "me@example.com");
    await register(env, session, { ...registration, token: "b".repeat(64) });
    await invalidate(env, old!);
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(1);
    await register(env, { ...session, expiresAt: 0 }, registration);
    expect(await devices(env, "owner", "me@example.com")).toHaveLength(0);
  });
});
