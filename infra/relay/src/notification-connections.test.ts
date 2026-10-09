import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  accessToken,
  callbackResponse,
  complete,
  configured,
  credential,
  connection,
  remove,
  routes,
  save,
  sameSettings,
  validateScopes,
} from "./notification-connections.ts";
import type { App, Env } from "./worker.ts";

vi.mock("./tunnel.ts", () => ({ allowed: () => true }));
let db: DatabaseSync;
let env: Env;
const session = {
  id: "phone",
  createdAt: 1,
  expiresAt: Date.now() + 100_000,
  user: { id: "owner", email: "owner@example.com", name: null, picture: null },
};
let start: ReturnType<typeof vi.fn>;
let stop: ReturnType<typeof vi.fn>;
let app: Hono<App>;
const mailbox = "mail@example.com";
const googleScope = "https://www.googleapis.com/auth/gmail.metadata";

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const migrations = resolve(import.meta.dirname, "../migrations");
  for (const file of readdirSync(migrations)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(resolve(migrations, file), "utf8"));
  db.exec(
    "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','owner@example.com',1,0,0), ('other','Other','other@example.com',1,0,0)",
  );
  db.exec(
    "INSERT INTO linked_accounts (user_id,email,provider,linked_at) VALUES ('owner','mail@example.com','gmail',0)",
  );
  const prepare = (sql: string) => {
    let values: (string | number)[] = [];
    const statement = {
      bind: (...args: (string | number)[]) => {
        values = args;
        return statement;
      },
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...values).changes) } }),
    };
    return statement;
  };
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  env = {
    DB: {
      prepare,
      batch: async (statements: ReturnType<typeof prepare>[]) =>
        Promise.all(statements.map((s) => s.run())),
    },
    BETTER_AUTH_SECRET: "local-state-secret",
    NOTIFICATION_CREDENTIAL_SECRET: "separate-encryption-secret",
    BETTER_AUTH_URL: "https://relay.example.com",
    APP_ORIGIN: "https://mail.example.com",
    NOTIFICATION_GOOGLE_CLIENT_ID: "google-notifications",
    NOTIFICATION_GOOGLE_CLIENT_SECRET: "fake-client-secret",
    NOTIFICATION_MICROSOFT_CLIENT_ID: "microsoft-notifications",
    NOTIFICATION_MICROSOFT_CLIENT_SECRET: "fake-client-secret",
    MICROSOFT_CLIENT_ID: "existing-full-mail-app",
    NOTIFICATION_MAILBOX: { idFromName: (name: string) => name, get: () => ({ start, stop }) },
    USER_HUB: {
      idFromName: (name: string) => name,
      get: () => ({ forgetPush: vi.fn().mockResolvedValue(undefined) }),
    },
  } as unknown as Env;
  app = new Hono<App>();
  app.use(async (c, next) => {
    c.set("session", session);
    await next();
  });
  app.route("/v1", routes());
});
afterEach(() => vi.unstubAllGlobals());
async function authorize(address = mailbox) {
  const response = await app.request(
    "https://relay.example.com/v1/notification-connections/authorize",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: address, returnTo: "native" }),
    },
    env,
  );
  const body = (await response.json().catch(() => ({}))) as { url?: string };
  return { response, url: body.url ? new URL(body.url) : undefined };
}
function oauth(scope = googleScope, address = mailbox) {
  const calls = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    String(input).includes("/profile")
      ? Response.json({ emailAddress: address })
      : Response.json({
          access_token: "fake-limited-access",
          refresh_token: "fake-limited-refresh",
          scope,
        }),
  );
  vi.stubGlobal("fetch", calls);
  return calls;
}

describe("verified notification credentials", () => {
  it("requests a separate metadata grant with PKCE, never incremental full-mail permissions", async () => {
    const { response, url } = await authorize();
    expect(response.status).toBe(200);
    expect(url!.searchParams.get("scope")).toBe(`openid email ${googleScope}`);
    expect(url!.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url!.searchParams.get("redirect_uri")).toBe(
      "https://relay.example.com/v1/gmail/callback",
    );
  });
  it("does not authorize another user's mailbox", async () => {
    const { response } = await authorize("unlinked@example.com");
    expect(response.status).toBe(403);
    expect(db.prepare("SELECT * FROM notification_authorizations").all()).toHaveLength(0);
  });
  it("proves the mailbox, encrypts the grant and consumes the callback once", async () => {
    const { url } = await authorize();
    oauth();
    const state = url!.searchParams.get("state")!;
    await complete(env, state, "fake-code");
    const saved = (await connection(env, "owner", mailbox))!;
    expect(saved.credential).not.toContain("fake-limited-refresh");
    expect((await credential(env, saved)).provider).toBe("gmail");
    await expect(credential(env, { ...saved, user_id: "other" })).rejects.toThrow();
    expect(start).toHaveBeenCalledWith("owner", mailbox);
    await expect(complete(env, state, "replay-code")).rejects.toMatchObject({ status: 400 });
    const result = await app.request(
      "https://relay.example.com/v1/notification-connections",
      {},
      env,
    );
    expect(JSON.stringify(await result.json())).not.toMatch(
      /refresh|access_token|credential|fake-client/,
    );
  });
  it("rejects full Gmail scope even when a metadata-only grant was requested", async () => {
    const { url } = await authorize();
    oauth(`${googleScope} https://mail.google.com/`);
    await expect(complete(env, url!.searchParams.get("state")!, "fake-code")).rejects.toThrow();
    expect(await connection(env, "owner", mailbox)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
  it("rejects a provider grant for a different mailbox", async () => {
    const { url } = await authorize();
    oauth(googleScope, "another@example.com");
    await expect(complete(env, url!.searchParams.get("state")!, "fake-code")).rejects.toMatchObject(
      { status: 403 },
    );
    expect(await connection(env, "owner", mailbox)).toBeNull();
  });
  it("a revoked session or removed mailbox wins an in-flight authorization", async () => {
    const { url } = await authorize();
    oauth();
    db.exec("INSERT INTO push_revocations VALUES ('owner','phone',100)");
    await expect(complete(env, url!.searchParams.get("state")!, "fake-code")).rejects.toMatchObject(
      { status: 401 },
    );
    expect(await connection(env, "owner", mailbox)).toBeNull();
    db.exec("DELETE FROM push_revocations; DELETE FROM linked_accounts");
    await expect(
      save(
        env,
        "owner",
        mailbox,
        { provider: "gmail", clientId: "google-notifications", refreshToken: "fake" },
        session,
      ),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  });
  it("a revocation at the final write cannot replace an existing grant", async () => {
    await save(
      env,
      "owner",
      mailbox,
      { provider: "gmail", clientId: "google-notifications", refreshToken: "original" },
      session,
    );
    const original = (await connection(env, "owner", mailbox))!.generation;
    db.exec("INSERT INTO push_revocations VALUES ('owner','phone',100)");
    await expect(
      save(
        env,
        "owner",
        mailbox,
        { provider: "gmail", clientId: "google-notifications", refreshToken: "replacement" },
        session,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect((await connection(env, "owner", mailbox))!.generation).toBe(original);
  });
  it("checks scopes again on refresh and doesn't restore credentials after removal", async () => {
    await save(
      env,
      "owner",
      mailbox,
      { provider: "gmail", clientId: "google-notifications", refreshToken: "original" },
      session,
    );
    const row = (await connection(env, "owner", mailbox))!;
    oauth("https://mail.google.com/");
    await expect(accessToken(env, row)).rejects.toThrow();
    const calls = oauth();
    calls.mockImplementation(async () => {
      await remove(env, "owner", mailbox);
      return Response.json({ access_token: "fake", refresh_token: "rotated", scope: googleScope });
    });
    await expect(accessToken(env, row)).rejects.toThrow();
    expect(await connection(env, "owner", mailbox)).toBeNull();
  });
  it("doesn't inherit the full Outlook app's permissions", () => {
    expect(configured(env, "outlook")).toBe(true);
    expect(
      configured({ ...env, NOTIFICATION_MICROSOFT_CLIENT_ID: env.MICROSOFT_CLIENT_ID }, "outlook"),
    ).toBe(false);
    expect(() => validateScopes("outlook", "User.Read Mail.ReadBasic")).not.toThrow();
    expect(() => validateScopes("outlook", "User.Read Mail.ReadBasic Mail.ReadWrite")).toThrow();
    expect(() => validateScopes("outlook", undefined)).toThrow();
  });
  it("unlink/account deletion cascades both routing and the encrypted grant", async () => {
    await save(
      env,
      "owner",
      mailbox,
      { provider: "gmail", clientId: "google-notifications", refreshToken: "fake" },
      session,
    );
    await authorize();
    expect(db.prepare("SELECT * FROM notification_authorizations").all()).toHaveLength(1);
    db.exec("DELETE FROM linked_accounts WHERE user_id='owner'");
    expect(await connection(env, "owner", mailbox)).toBeNull();
    db.exec("DELETE FROM user WHERE id='owner'");
    expect(db.prepare("SELECT * FROM notification_authorizations").all()).toHaveLength(0);
  });
  it("compares IMAP settings semantically, including host/port, not JSON key order", () => {
    const original = {
      username: "me",
      imap: { host: "imap.example.com", port: 993, security: "tls" as const },
      smtp: { host: "smtp.example.com", port: 465, security: "tls" as const },
    };
    expect(
      sameSettings(original, {
        smtp: original.smtp,
        imap: { security: "tls", port: 993, host: "IMAP.EXAMPLE.COM" },
        username: "me",
      }),
    ).toBe(true);
    expect(
      sameSettings(original, {
        ...original,
        imap: { ...original.imap, host: "attacker.example.com" },
      }),
    ).toBe(false);
  });
  it("returns safe callback errors and only a fixed native redirect", async () => {
    const { url } = await authorize();
    oauth("https://mail.google.com/");
    const response = await callbackResponse(env, url!.searchParams.get("state")!, "fake-code");
    const body = await response.text();
    expect(body).toContain("ottermail-notifications://complete?result=error");
    expect(body).not.toContain("fake-limited-refresh");
    expect(body).not.toContain("fake-client-secret");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
