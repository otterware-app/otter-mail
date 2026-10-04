/**
 * The relay end to end, as a device and Pub/Sub see it: the real Worker in
 * workerd (wrangler's local runtime) with a local D1 and Durable Object.
 * Google is played by a local server: its key signs the ID tokens and push
 * tokens, and its token endpoint serves the web app's Gmail sign-ins.
 */

import { execFileSync } from "node:child_process";
import * as http from "node:http";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { unstable_startWorker } from "wrangler";
import { localConfig } from "../scripts/local-config.ts";
import type { ListProjectsResponse, Project } from "@otter-mail/contracts/projects";
import type {
  CreateAgentTokenResponse,
  ListAccountsResponse,
  ListAgentTokensResponse,
  MeResponse,
  PreferencesResponse,
  RelayEvent,
} from "@otter-mail/contracts/relay";
import { TUNNEL_CLOSE } from "@otter-mail/contracts/relay";

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const WEB_CLIENT_ID = "test-web-client.apps.googleusercontent.com";
const IOS_CLIENT_ID = "test-ios-client.apps.googleusercontent.com";
const IOS_STORE_CLIENT_ID = "test-ios-store-client.apps.googleusercontent.com";
const APP_ORIGIN = "http://app.test";
const PUSH_AUDIENCE = "https://relay.test/push/gmail";
const PUSH_SERVICE_ACCOUNT = "push@test.iam.gserviceaccount.com";
const root = path.resolve(import.meta.dirname, "..");

let signingKey: CryptoKey;
let jwks: http.Server;
let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let base: string;
let persistDir: string;
/** A mail server for the tunnel: greets, then echoes; `bye` makes it hang up, `stall` stop reading. */
let mailServer: net.Server;
let mailTarget: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" };
  jwks = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on(
        "end",
        () =>
          void googleToken(new URLSearchParams(body)).then(([status, json]) => {
            res.writeHead(status);
            res.end(JSON.stringify(json));
          }),
      );
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const { port } = jwks.address() as { port: number };

  mailServer = net.createServer((socket) => {
    socket.write("* OK hello\r\n");
    socket.on("error", () => {}); // The relay resets connections it cuts off.
    socket.on("data", (data) => {
      if (String(data) === "bye\r\n") socket.end();
      else if (String(data) === "stall\r\n") socket.pause();
      else socket.write(data);
    });
  });
  await new Promise<void>((resolve) => mailServer.listen(0, "127.0.0.1", resolve));
  mailTarget = `127.0.0.1:${(mailServer.address() as net.AddressInfo).port}`;

  persistDir = fs.mkdtempSync(path.join(os.tmpdir(), "otter-relay-test-"));
  // This suite exercises the local standalone identity. The central service has
  // its own integration suite; do not discover or call deployed services here.
  const config = path.join(persistDir, "wrangler.jsonc");
  fs.writeFileSync(config, localConfig());
  execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "--config",
      config,
      "d1",
      "migrations",
      "apply",
      "otter-mail-relay",
      "--local",
      "--persist-to",
      persistDir,
    ],
    { cwd: root, stdio: "ignore", env: { ...process.env, CI: "1" } },
  );

  worker = await unstable_startWorker({
    config,
    bindings: {
      IDENTITY_MODE: { type: "plain_text", value: "legacy" },
      GOOGLE_CLIENT_ID: { type: "plain_text", value: CLIENT_ID },
      GOOGLE_IOS_CLIENT_ID: {
        type: "plain_text",
        value: `${IOS_CLIENT_ID},${IOS_STORE_CLIENT_ID}`,
      },
      GOOGLE_JWKS_URL: { type: "plain_text", value: `http://127.0.0.1:${port}/certs` },
      GOOGLE_TOKEN_URL: { type: "plain_text", value: `http://127.0.0.1:${port}/token` },
      GOOGLE_WEB_CLIENT_ID: { type: "plain_text", value: WEB_CLIENT_ID },
      GOOGLE_WEB_CLIENT_SECRET: { type: "plain_text", value: "web-secret" },
      APP_ORIGIN: { type: "plain_text", value: APP_ORIGIN },
      COOKIE_DOMAIN: { type: "plain_text", value: "" },
      TUNNEL_TEST_TARGET: { type: "plain_text", value: mailTarget },
      PUSH_AUDIENCE: { type: "plain_text", value: PUSH_AUDIENCE },
      PUSH_SERVICE_ACCOUNT: { type: "plain_text", value: PUSH_SERVICE_ACCOUNT },
      BETTER_AUTH_SECRET: {
        type: "plain_text",
        value: "test-secret-that-is-long-enough-for-better-auth",
      },
    },
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: persistDir,
      watch: false,
      logLevel: "none",
    },
  });
  base = (await worker.url).toString().replace(/\/$/, "");
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
  jwks?.close();
  mailServer?.close();
  fs.rmSync(persistDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let nextSub = 1;

/** A Google ID token for `email`, as the desktop app would get one. */
function idToken(email: string, opts: { sub?: string; aud?: string } = {}) {
  return new SignJWT({ email, email_verified: true, name: "Test User" })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://accounts.google.com")
    .setAudience(opts.aud ?? CLIENT_ID)
    .setSubject(opts.sub ?? `sub-${nextSub++}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);
}

function call(method: string, route: string, token?: string, body?: unknown) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function signInRequest(token: string) {
  return call("POST", "/v1/auth/sign-in/social", undefined, {
    provider: "google",
    idToken: { token },
  });
}

/**
 * Google's token endpoint for the web client: codes are "code:<email>",
 * refresh tokens "rt:<email>", and anything for revoked@ is invalid_grant.
 */
async function googleToken(form: URLSearchParams): Promise<[number, unknown]> {
  if (form.get("client_id") !== WEB_CLIENT_ID || form.get("client_secret") !== "web-secret") {
    return [401, { error: "invalid_client" }];
  }
  const grant = form.get("grant_type");
  const email =
    grant === "authorization_code"
      ? form.get("code")?.replace(/^code:/, "")
      : form.get("refresh_token")?.replace(/^rt:/, "");
  if (!email || (grant === "refresh_token" && email.startsWith("revoked@"))) {
    return [400, { error: "invalid_grant" }];
  }
  return [
    200,
    {
      access_token: `at:${email}:${Date.now()}`,
      expires_in: 3599,
      id_token: await idToken(email, { aud: WEB_CLIENT_ID }),
      ...(grant === "authorization_code" ? { refresh_token: `rt:${email}` } : {}),
    },
  ];
}

/** Signs in as the desktop app does; returns the bearer token better-auth hands out. */
async function signIn(email: string, sub?: string) {
  const response = await signInRequest(await idToken(email, { sub }));
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  expect(token).toBeTruthy();
  const { user } = (await response.json()) as { user: { id: string; email: string; name: string } };
  return { token: token!, user };
}

async function link(token: string, email: string, profile: Record<string, unknown> = {}) {
  return call("PUT", `/v1/accounts/${encodeURIComponent(email)}`, token, {
    idToken: await idToken(email),
    ...profile,
  });
}

/** The linked mailboxes, as a build that knows IMAP asks for them (`query` "" for older ones). */
async function listAccounts(token: string, query = "?providers=gmail,imap") {
  const response = await call("GET", `/v1/accounts${query}`, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as ListAccountsResponse).accounts;
}

/** Publishes a Gmail notification the way Pub/Sub pushes it. */
async function push(notification: unknown, opts: { email?: string; aud?: string } = {}) {
  const token = await new SignJWT({
    email: opts.email ?? PUSH_SERVICE_ACCOUNT,
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://accounts.google.com")
    .setAudience(opts.aud ?? PUSH_AUDIENCE)
    .setSubject("pubsub")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey);
  return call("POST", "/push/gmail", token, {
    message: { data: btoa(JSON.stringify(notification)), messageId: "1" },
    subscription: "projects/test/subscriptions/test",
  });
}

/** A device's event stream: collects what the relay sends. */
async function connect(token: string) {
  // Node's WebSocket (undici) takes headers, as the desktop app's does.
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/v1/events`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  const events: (RelayEvent | string)[] = [];
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (e) => resolve(e.code)),
  );
  socket.addEventListener("message", (e) => {
    const text = String(e.data);
    events.push(text === "pong" ? text : (JSON.parse(text) as RelayEvent));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
  });
  return { socket, events, closed };
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("the hosted agent", () => {
  it("requires an Otter session and reaches the AgentHub on desktop and web", async () => {
    expect((await call("GET", "/v1/agent/connection")).status).toBe(401);
    const { token } = await signIn("agent@example.com");
    const response = await call("GET", "/v1/agent/connection", token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false, models: [] });
    const web = await fetch(`${base}/v1/agent/connection`, {
      headers: { authorization: `Bearer ${token}`, origin: APP_ORIGIN },
    });
    expect(web.status).toBe(200);
    expect(web.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
  });

  it("rejects a different browser origin and invalid API keys without storing them", async () => {
    const { token } = await signIn("agent-origin@example.com");
    const crossOrigin = await fetch(`${base}/v1/agent/connection`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, origin: "https://untrusted.test" },
    });
    expect(crossOrigin.status).toBe(403);
    const badKey = await call("PUT", "/v1/agent/connection", token, { apiKey: "invalid" });
    expect(badKey.status).toBe(400);
    expect(await badKey.json()).toMatchObject({
      error: expect.stringContaining("OpenRouter API key"),
    });
    expect(await (await call("GET", "/v1/agent/connection", token)).json()).toEqual({
      connected: false,
      models: [],
    });
  });
});

describe("sign-in", () => {
  it("signs in with a Google ID token and reports who is signed in", async () => {
    const { token, user } = await signIn("Owner@Example.com", "owner-sub");
    expect(user).toMatchObject({ email: "owner@example.com", name: "Test User" });

    const me = (await (await call("GET", "/v1/me", token)).json()) as MeResponse;
    expect(me.user).toMatchObject({ id: user.id, email: "owner@example.com", name: "Test User" });
    expect(me.pushTopic).toBe("projects/otter-mail/topics/gmail-push");
  });

  it("signing in again (another Mac) is the same user, with its own session", async () => {
    const a = await signIn("same@example.com", "same-sub");
    const b = await signIn("same@example.com", "same-sub");
    expect(a.token).not.toBe(b.token);
    expect(a.user.id).toBe(b.user.id);
    await link(a.token, "shared-view@example.com");
    expect((await listAccounts(b.token)).map((x) => x.email)).toEqual(["shared-view@example.com"]);
  });

  it("accepts ID tokens from the iPhone app's client, to sign in and to link", async () => {
    const response = await signInRequest(
      await idToken("iphone@example.com", { aud: IOS_CLIENT_ID }),
    );
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token")!;
    const linked = await call("PUT", "/v1/accounts/iphone%40example.com", token, {
      idToken: await idToken("iphone@example.com", { aud: IOS_CLIENT_ID }),
    });
    expect(linked.status).toBe(204);
    // The App Store build's client too.
    const store = await signInRequest(
      await idToken("iphone@example.com", { aud: IOS_STORE_CLIENT_ID }),
    );
    expect(store.status).toBe(200);
  });

  it("rejects ID tokens for another OAuth client, and garbage", async () => {
    const other = await signInRequest(await idToken("x@example.com", { aud: "someone-else" }));
    expect(other.ok).toBe(false);
    expect((await signInRequest("nope")).ok).toBe(false);
  });

  it("needs a session for everything else", async () => {
    expect((await call("GET", "/v1/me")).status).toBe(401);
    expect((await call("GET", "/v1/accounts", "forged")).status).toBe(401);
  });
});

describe("devices", () => {
  it("supports browser sign-out in standalone development without ending a different device", async () => {
    const response = await signInRequest(
      await idToken("browser-logout@example.com", { sub: "browser-logout" }),
    );
    const token = response.headers.get("set-auth-token")!;
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const other = await signIn("browser-logout@example.com", "browser-logout");
    const logout = (origin: string) =>
      fetch(`${base}/v1/auth/browser-sign-out/start`, {
        method: "POST",
        headers: { origin, cookie, authorization: `Bearer ${other.token}` },
        redirect: "manual",
      });
    expect((await logout("https://evil.example")).status).toBe(403);
    expect((await call("GET", "/v1/me", token)).status).toBe(200);
    const signedOut = await logout(APP_ORIGIN);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe(APP_ORIGIN);
    expect((await call("GET", "/v1/me", token)).status).toBe(401);
    expect((await call("GET", "/v1/me", other.token)).status).toBe(200);
  });
  it("lists each signed-in device", async () => {
    const mac1 = await signIn("devices@example.com", "devices-sub");
    await signIn("devices@example.com", "devices-sub");
    const sessions = (await (
      await call("GET", "/v1/auth/list-sessions", mac1.token)
    ).json()) as unknown[];
    expect(sessions).toHaveLength(2);
  });

  // The close frame goes out at once; the runtime drops the TCP connection
  // (when Node's WebSocket reports `close`) about 10s later. These tests use
  // separate accounts, so their waits can overlap.
  it.concurrent(
    "signing out ends the session and closes its sockets",
    { timeout: 20_000 },
    async () => {
      const { token } = await signIn("leaving@example.com");
      const device = await connect(token);
      expect((await call("POST", "/v1/auth/sign-out", token, {})).status).toBe(200);
      expect((await call("GET", "/v1/me", token)).status).toBe(401);
      expect(await device.closed).toBe(4001);
    },
  );

  it.concurrent("signing another device out closes its sockets", { timeout: 20_000 }, async () => {
    const here = await signIn("revoker@example.com", "revoker-sub");
    const there = await signIn("revoker@example.com", "revoker-sub");
    const device = await connect(there.token);
    const sessions = (await (await call("GET", "/v1/auth/list-sessions", here.token)).json()) as {
      token: string;
    }[];
    const other = sessions.find((s) => s.token !== here.token.split(".")[0])!;
    const revoke = await call("POST", "/v1/auth/revoke-session", here.token, {
      token: other.token,
    });
    expect(revoke.status).toBe(200);
    expect((await call("GET", "/v1/me", there.token)).status).toBe(401);
    expect((await call("GET", "/v1/me", here.token)).status).toBe(200);
    expect(await device.closed).toBe(4001);
  });

  it.concurrent(
    "deleting the account removes its linked accounts and signs every device out",
    { timeout: 20_000 },
    async () => {
      const mac1 = await signIn("deleting@example.com", "deleting-sub");
      const mac2 = await signIn("deleting@example.com", "deleting-sub");
      await link(mac1.token, "gone-mailbox@example.com");
      const device = await connect(mac2.token);
      expect((await call("POST", "/v1/auth/delete-user", mac1.token, {})).status).toBe(200);
      expect((await call("GET", "/v1/me", mac2.token)).status).toBe(401);
      expect(await device.closed).toBe(4001);

      // Signing in again starts from nothing; pushes for the old mailbox reach nobody.
      const again = await signIn("deleting@example.com", "deleting-sub");
      expect(await listAccounts(again.token)).toEqual([]);
    },
  );
});

describe("linked accounts", () => {
  it("links accounts with proof, lists them in order, and updates profiles", async () => {
    const { token } = await signIn("me@example.com");
    expect((await link(token, "Work@Example.com", { name: "Work", color: "#f00" })).status).toBe(
      204,
    );
    expect((await link(token, "home@example.com")).status).toBe(204);

    // Profile edits after linking need no proof; left-out fields keep their value.
    const edit = await call("PUT", "/v1/accounts/work%40example.com", token, {
      displayName: "Job",
    });
    expect(edit.status).toBe(204);

    const gmail = { provider: "gmail", imap: null };
    expect(await listAccounts(token)).toEqual([
      {
        email: "work@example.com",
        ...gmail,
        name: "Work",
        picture: null,
        displayName: "Job",
        color: "#f00",
      },
      {
        email: "home@example.com",
        ...gmail,
        name: null,
        picture: null,
        displayName: null,
        color: null,
      },
    ]);
  });

  it("refuses to link without proof, or with proof for another address", async () => {
    const { token } = await signIn("me2@example.com");
    const noProof = await call("PUT", "/v1/accounts/victim%40example.com", token, {});
    expect(noProof.status).toBe(403);
    const wrongProof = await call("PUT", "/v1/accounts/victim%40example.com", token, {
      idToken: await idToken("attacker@example.com"),
    });
    expect(wrongProof.status).toBe(403);
    expect(await listAccounts(token)).toEqual([]);
  });

  it("unlinks accounts", async () => {
    const { token } = await signIn("me3@example.com");
    await link(token, "gone@example.com");
    expect((await call("DELETE", "/v1/accounts/gone%40example.com", token)).status).toBe(204);
    expect((await call("DELETE", "/v1/accounts/gone%40example.com", token)).status).toBe(204);
    expect(await listAccounts(token)).toEqual([]);
  });

  it("rejects addresses that aren't one", async () => {
    const { token } = await signIn("me4@example.com");
    expect((await call("PUT", "/v1/accounts/not-an-address", token, {})).status).toBe(400);
  });

  it("tells every device when the accounts change", async () => {
    const { token } = await signIn("multi@example.com", "multi-sub");
    const other = await signIn("multi@example.com", "multi-sub");
    const device = await connect(other.token);
    await link(token, "new@example.com");
    await until(() => device.events.length > 0, "the accounts event");
    expect(device.events).toEqual([{ type: "accounts" }]);
    device.socket.close();
  });
});

describe("IMAP mailboxes", () => {
  const settings = {
    username: "me@fastmail.test",
    imap: { host: "imap.fastmail.test", port: 993, security: "tls" },
    smtp: { host: "smtp.fastmail.test", port: 587, security: "starttls" },
  };
  const put = (token: string, email: string, body: unknown) =>
    call("PUT", `/v1/accounts/${encodeURIComponent(email)}`, token, body);

  it("links with settings and no ID token, and updates them", async () => {
    const { token } = await signIn("imap-owner@example.com");
    expect(
      (await put(token, "me@fastmail.test", { provider: "imap", imap: settings })).status,
    ).toBe(204);
    const moved = { ...settings, imap: { ...settings.imap, host: "mail.fastmail.test" } };
    expect((await put(token, "me@fastmail.test", { provider: "imap", imap: moved })).status).toBe(
      204,
    );
    // Profile edits may leave the provider out.
    expect((await put(token, "me@fastmail.test", { displayName: "Fastmail" })).status).toBe(204);
    expect(await listAccounts(token)).toEqual([
      {
        email: "me@fastmail.test",
        provider: "imap",
        imap: moved,
        name: null,
        picture: null,
        displayName: "Fastmail",
        color: null,
      },
    ]);
  });

  it("refuses missing or invalid settings, and settings on a Gmail account", async () => {
    const { token } = await signIn("imap-invalid@example.com");
    const server = settings.imap;
    for (const imap of [
      undefined,
      { ...settings, username: "" },
      { ...settings, imap: { ...server, host: " " } },
      { ...settings, imap: { ...server, port: 0 } },
      { ...settings, imap: { ...server, port: 70000 } },
      { ...settings, imap: { ...server, security: "ssl" } },
      { username: "x", imap: server },
    ]) {
      expect((await put(token, "bad@fastmail.test", { provider: "imap", imap })).status).toBe(400);
    }
    const gmail = await put(token, "g@example.com", {
      idToken: await idToken("g@example.com"),
      imap: settings,
    });
    expect(gmail.status).toBe(400);
    expect(await listAccounts(token)).toEqual([]);
  });

  it("doesn't switch a mailbox between Gmail and IMAP without unlinking it", async () => {
    const { token } = await signIn("imap-switch@example.com");
    await link(token, "both@gmail.test");
    expect((await put(token, "both@gmail.test", { provider: "imap", imap: settings })).status).toBe(
      409,
    );
    await put(token, "imap-only@fastmail.test", { provider: "imap", imap: settings });
    const relink = await put(token, "imap-only@fastmail.test", {
      provider: "gmail",
      idToken: await idToken("imap-only@fastmail.test"),
    });
    expect(relink.status).toBe(409);
    expect((await listAccounts(token)).map((a) => a.provider)).toEqual(["gmail", "imap"]);

    await call("DELETE", "/v1/accounts/both%40gmail.test", token);
    expect((await put(token, "both@gmail.test", { provider: "imap", imap: settings })).status).toBe(
      204,
    );
  });

  it("tells every device when an IMAP mailbox is linked", async () => {
    const { token } = await signIn("imap-multi@example.com", "imap-multi-sub");
    const other = await signIn("imap-multi@example.com", "imap-multi-sub");
    const device = await connect(other.token);
    await put(token, "live@fastmail.test", { provider: "imap", imap: settings });
    await until(() => device.events.length > 0, "the accounts event");
    expect(device.events).toEqual([{ type: "accounts" }]);
    device.socket.close();
  });

  it("shows IMAP mailboxes only to builds that ask, and only they unlink them", async () => {
    const { token } = await signIn("imap-old-build@example.com");
    await link(token, "old@gmail.test");
    await put(token, "new@fastmail.test", { provider: "imap", imap: settings });
    expect((await listAccounts(token, "")).map((a) => a.email)).toEqual(["old@gmail.test"]);
    expect((await listAccounts(token, "?providers=gmail")).length).toBe(1);
    expect((await listAccounts(token, "?providers=imap,outlook")).map((a) => a.email)).toEqual([
      "new@fastmail.test",
    ]);

    // An old build's unlink leaves the IMAP mailbox alone.
    expect((await call("DELETE", "/v1/accounts/new%40fastmail.test", token)).status).toBe(204);
    expect((await listAccounts(token)).length).toBe(2);
    const route = "/v1/accounts/new%40fastmail.test?providers=gmail,imap";
    expect((await call("DELETE", route, token)).status).toBe(204);
    expect((await listAccounts(token)).map((a) => a.email)).toEqual(["old@gmail.test"]);
  });

  it("gets no Gmail pushes for an address linked over IMAP", async () => {
    const { token } = await signIn("imap-eavesdropper@example.com");
    await put(token, "victim@gmail.test", {
      provider: "imap",
      imap: { ...settings, username: "victim@gmail.test" },
    });
    const device = await connect(token);
    expect((await push({ emailAddress: "victim@gmail.test", historyId: "7" })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(device.events).toEqual([]);
    device.socket.close();
  });
});

describe("preferences", () => {
  async function preferences(token: string) {
    const response = await call("GET", "/v1/preferences", token);
    expect(response.status).toBe(200);
    return (await response.json()) as PreferencesResponse;
  }

  it("starts empty, replaces the sections given, and keeps the rest", async () => {
    const { token } = await signIn("prefs@example.com");
    expect(await preferences(token)).toEqual({ preferences: {}, hermesKey: null });

    const put = (body: unknown) => call("PUT", "/v1/preferences", token, body);
    expect((await put({ preferences: { views: [1], ui: { a: "1" } } })).status).toBe(204);
    expect((await put({ preferences: { ui: { b: "2" } } })).status).toBe(204);
    expect((await preferences(token)).preferences).toEqual({ views: [1], ui: { b: "2" } });
  });

  it("keeps the Hermes key sealed, and gives it back only to its owner", async () => {
    const { token } = await signIn("hermes@example.com");
    await call("PUT", "/v1/preferences", token, { hermesKey: "sk-secret" });
    expect((await preferences(token)).hermesKey).toBe("sk-secret");

    // What the database holds is sealed.
    const stored = execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "otter-mail-relay",
        "--local",
        "--persist-to",
        persistDir,
        "--json",
        "--command",
        "SELECT hermes_key FROM preferences WHERE hermes_key IS NOT NULL",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, CI: "1" } },
    );
    expect(stored).toContain("hermes_key");
    expect(stored).not.toContain("sk-secret");

    // Other sections leave the key alone; null clears it.
    await call("PUT", "/v1/preferences", token, { preferences: { ui: {} } });
    expect((await preferences(token)).hermesKey).toBe("sk-secret");
    await call("PUT", "/v1/preferences", token, { hermesKey: null });
    expect((await preferences(token)).hermesKey).toBeNull();

    const { token: other } = await signIn("someone-else@example.com");
    expect(await preferences(other)).toEqual({ preferences: {}, hermesKey: null });
    // Inspecting D1 starts a second Wrangler runtime; allow its cold start in CI.
  }, 30_000);

  it("keeps every section when devices write at the same time", async () => {
    const { token } = await signIn("prefs-race@example.com");
    const names = Array.from({ length: 10 }, (_, i) => `section${i}`);
    const responses = await Promise.all(
      names.map((name) => call("PUT", "/v1/preferences", token, { preferences: { [name]: name } })),
    );
    expect(responses.map((r) => r.status)).toEqual(names.map(() => 204));
    expect(Object.keys((await preferences(token)).preferences).sort()).toEqual(names.sort());
  });

  it("refuses preferences that are too large", async () => {
    const { token } = await signIn("big@example.com");
    const big = "x".repeat(300 * 1024);
    const response = await call("PUT", "/v1/preferences", token, { preferences: { ui: big } });
    expect(response.status).toBe(413);
  });

  it("tells every device when the preferences change", async () => {
    const { token } = await signIn("prefs-multi@example.com", "prefs-multi-sub");
    const other = await signIn("prefs-multi@example.com", "prefs-multi-sub");
    const device = await connect(other.token);
    await call("PUT", "/v1/preferences", token, { preferences: { ui: {} } });
    await until(() => device.events.length > 0, "the preferences event");
    expect(device.events).toEqual([{ type: "preferences" }]);
    device.socket.close();
  });
});

describe("projects", () => {
  async function projects(token: string) {
    const response = await call("GET", "/v1/projects", token);
    expect(response.status).toBe(200);
    return ((await response.json()) as ListProjectsResponse).projects;
  }
  const fields = {
    name: "Acme contract",
    status: "active",
    notes: "",
    createdAt: 1_000,
    settledAt: null,
  };

  it("keeps a project's fields, threads and links, and forgets them together", async () => {
    const { token } = await signIn("projects@example.com");
    expect(await projects(token)).toEqual([]);

    expect((await call("PUT", "/v1/projects/p_1", token, fields)).status).toBe(204);
    const thread = `/v1/projects/p_1/threads/${encodeURIComponent("Me@Example.com")}/${encodeURIComponent("1a2b.root@mail.example")}`;
    expect((await call("PUT", thread, token, { addedAt: 2_000 })).status).toBe(204);
    // Again: it keeps when it was added first.
    expect((await call("PUT", thread, token, { addedAt: 3_000 })).status).toBe(204);
    const link = { url: "https://docs.example/contract", title: "Draft", addedAt: 4_000 };
    expect((await call("PUT", "/v1/projects/p_1/links/l_1", token, link)).status).toBe(204);
    const settled = { ...fields, status: "settled", notes: "Signed.", settledAt: 5_000 };
    expect((await call("PUT", "/v1/projects/p_1", token, settled)).status).toBe(204);

    const [project] = await projects(token);
    expect(project).toMatchObject({
      id: "p_1",
      name: "Acme contract",
      status: "settled",
      notes: "Signed.",
      createdAt: 1_000,
      settledAt: 5_000,
      threads: [
        {
          email: "me@example.com",
          threadId: "1a2b.root@mail.example",
          subject: "",
          addedAt: 2_000,
        },
      ],
      links: [{ id: "l_1", ...link }],
    });

    expect((await call("DELETE", thread, token)).status).toBe(204);
    expect((await projects(token))[0].threads).toEqual([]);
    expect((await call("DELETE", "/v1/projects/p_1", token)).status).toBe(204);
    expect(await projects(token)).toEqual([]);
    // Recreated, it starts without the old links.
    await call("PUT", "/v1/projects/p_1", token, fields);
    expect((await projects(token))[0].links).toEqual([]);
  });

  it("refuses threads and links of a project that doesn't exist, and bad input", async () => {
    const { token } = await signIn("projects-missing@example.com");
    const link = { url: "https://example.com", title: "", addedAt: 1 };
    expect((await call("PUT", "/v1/projects/nope/links/l_1", token, link)).status).toBe(404);
    expect((await call("PUT", "/v1/projects/p_1", token, { ...fields, name: "" })).status).toBe(
      400,
    );
    expect(
      (await call("PUT", "/v1/projects/p_1", token, { ...fields, status: "done" })).status,
    ).toBe(400);
    expect((await call("PUT", "/v1/projects/a%20b", token, fields)).status).toBe(400);
  });

  it("shows each account only its own projects", async () => {
    const { token } = await signIn("projects-a@example.com");
    const { token: other } = await signIn("projects-b@example.com");
    await call("PUT", "/v1/projects/p_1", token, fields);
    expect(await projects(other)).toEqual([]);
    const link = { url: "https://example.com", title: "", addedAt: 1 };
    expect((await call("PUT", "/v1/projects/p_1/links/l_1", other, link)).status).toBe(404);
  });

  it("tells every device when a project changes", async () => {
    const { token } = await signIn("projects-multi@example.com", "projects-multi-sub");
    const other = await signIn("projects-multi@example.com", "projects-multi-sub");
    const device = await connect(other.token);
    await call("PUT", "/v1/projects/p_1", token, fields);
    await until(() => device.events.length > 0, "the projects event");
    expect(device.events).toEqual([{ type: "projects" }]);
    device.socket.close();
  });
});

describe("MCP for agents", () => {
  async function agent(token: string) {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }
  const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
    (result.content as { type: string; text: string }[])[0].text;

  it("makes, lists and revokes agent tokens, shown once", async () => {
    const { token } = await signIn("tokens@example.com");
    const created = await call("POST", "/v1/agent-tokens", token, { name: "Hermes" });
    expect(created.status).toBe(200);
    const { token: secret, agentToken } = (await created.json()) as CreateAgentTokenResponse;
    expect(secret).toMatch(/^otter_/);
    const list = async () =>
      ((await (await call("GET", "/v1/agent-tokens", token)).json()) as ListAgentTokensResponse)
        .tokens;
    expect(await list()).toEqual([agentToken]);
    expect(JSON.stringify(await list())).not.toContain(secret);

    await (await agent(secret)).close();
    expect((await list())[0].lastUsedAt).not.toBeNull();

    expect((await call("DELETE", `/v1/agent-tokens/${agentToken.id}`, token)).status).toBe(204);
    expect(await list()).toEqual([]);
    expect((await call("POST", "/mcp", secret, {})).status).toBe(401);
  });

  it("refuses requests without an agent token, and session tokens", async () => {
    expect((await call("POST", "/mcp", undefined, {})).status).toBe(401);
    const { token } = await signIn("mcp-session@example.com");
    expect((await call("POST", "/mcp", token, {})).status).toBe(401);
  });

  it("manages the account's projects with the project tools", async () => {
    const { token } = await signIn("mcp@example.com", "mcp-sub");
    const device = await connect((await signIn("mcp@example.com", "mcp-sub")).token);
    const { token: secret } = (await (
      await call("POST", "/v1/agent-tokens", token, { name: "Hermes" })
    ).json()) as CreateAgentTokenResponse;
    const client = await agent(secret);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_projects",
      "get_project",
      "create_project",
      "update_project",
      "set_project_status",
      "add_to_project",
      "remove_from_project",
    ]);
    expect(tools.find((t) => t.name === "list_projects")?.annotations?.readOnlyHint).toBe(true);

    const created = JSON.parse(
      text(
        await client.callTool({
          name: "create_project",
          arguments: {
            name: "Acme contract",
            conversations: [{ account: "Me@Example.com", threadId: "t1" }],
            links: [{ url: "https://docs.example/contract" }],
          },
        }),
      ),
    ) as { id: string; conversations: unknown[]; links: { title: string }[] };
    expect(created.conversations).toEqual([{ account: "me@example.com", threadId: "t1" }]);
    expect(created.links[0].title).toBe("https://docs.example/contract");
    await until(() => device.events.length > 0, "the projects event");
    expect(device.events[0]).toEqual({ type: "projects" });

    await client.callTool({
      name: "set_project_status",
      arguments: { projectId: created.id, status: "settled" },
    });
    const [project] = (
      (await (await call("GET", "/v1/projects", token)).json()) as ListProjectsResponse
    ).projects as Project[];
    expect(project.status).toBe("settled");
    expect(project.settledAt).toBeGreaterThan(0);

    const missing = await client.callTool({
      name: "get_project",
      arguments: { projectId: "p_nope" },
    });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("No project");

    // Another account's token sees none of it.
    const { token: otherSession } = await signIn("mcp-other@example.com");
    const { token: otherSecret } = (await (
      await call("POST", "/v1/agent-tokens", otherSession, { name: "x" })
    ).json()) as CreateAgentTokenResponse;
    const stranger = await agent(otherSecret);
    expect(
      JSON.parse(
        text(await stranger.callTool({ name: "list_projects", arguments: { status: "all" } })),
      ),
    ).toEqual([]);
    await stranger.close();
    await client.close();
    device.socket.close();
  });
});

describe("web app", () => {
  it("lets the web app's origin call with credentials, and nobody else", async () => {
    const preflight = (origin: string) =>
      fetch(`${base}/v1/me`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
    const allowed = await preflight(APP_ORIGIN);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(APP_ORIGIN);
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
    const other = await preflight("https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("accepts ID tokens from the web client too", async () => {
    const response = await signInRequest(
      await idToken("webber@example.com", { aud: WEB_CLIENT_ID }),
    );
    expect(response.status).toBe(200);
  });

  /** The popup's HTML posts `{ type, result | error }` to the app: pull it out. */
  async function popupMessage(response: Response) {
    const html = await response.text();
    const json = /const message = (\{.*?\});\n/s.exec(html)?.[1];
    expect(html).toContain('postMessage(message, "http://app.test")');
    expect(json).toBeTruthy();
    return JSON.parse(json!) as {
      type: string;
      result?: { email: string; sealed: string; accessToken: string };
      error?: string;
    };
  }

  async function authorize(token: string) {
    const response = await fetch(`${base}/v1/gmail/authorize?login_hint=x%40example.com`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get("location")!);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(WEB_CLIENT_ID);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("login_hint")).toBe("x@example.com");
    return url.searchParams.get("state")!;
  }

  const callback = (token: string, query: string) =>
    fetch(`${base}/v1/gmail/callback?${query}`, { headers: { authorization: `Bearer ${token}` } });

  it("signs in to Gmail by popup, seals the refresh token, and refreshes it for its owner only", async () => {
    const owner = await signIn("popup-owner@example.com");
    const state = await authorize(owner.token);
    const message = await popupMessage(
      await callback(owner.token, `code=code:mail%40example.com&state=${state}`),
    );
    expect(message.type).toBe("otter:gmail-sign-in");
    expect(message.result).toMatchObject({ email: "mail@example.com" });
    expect(message.result!.sealed).not.toContain("rt:"); // sealed, not readable

    const refreshed = await call("POST", "/v1/gmail/token", owner.token, {
      sealed: message.result!.sealed,
    });
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as { accessToken: string; idToken: string };
    expect(body.accessToken).toMatch(/^at:mail@example.com:/);
    expect(body.idToken).toBeTruthy();

    // The ID token links the account like the desktop's does.
    const link = await call("PUT", "/v1/accounts/mail%40example.com", owner.token, {
      idToken: body.idToken,
    });
    expect(link.status).toBe(204);

    const stranger = await signIn("stranger@example.com");
    const stolen = await call("POST", "/v1/gmail/token", stranger.token, {
      sealed: message.result!.sealed,
    });
    expect(stolen.status).toBe(400);
  });

  it("says when Google revoked the sign-in", async () => {
    const owner = await signIn("revoker-owner@example.com");
    const state = await authorize(owner.token);
    const { result } = await popupMessage(
      await callback(owner.token, `code=code:revoked%40example.com&state=${state}`),
    );
    expect(
      (await call("POST", "/v1/gmail/token", owner.token, { sealed: result!.sealed })).status,
    ).toBe(410);
  });

  it("refuses a sign-in state issued to someone else, and reports declined consent", async () => {
    const alice = await signIn("state-alice@example.com");
    const bob = await signIn("state-bob@example.com");
    const state = await authorize(alice.token);
    const hijacked = await popupMessage(
      await callback(bob.token, `code=code:x%40example.com&state=${state}`),
    );
    expect(hijacked.result).toBeUndefined();
    expect(hijacked.error).toBeTruthy();
    const declined = await popupMessage(await callback(alice.token, "error=access_denied"));
    expect(declined.error).toBe("sign-in-cancelled");
  });
});

describe("realtime", () => {
  it("answers ping with pong", async () => {
    const { token } = await signIn("pinger@example.com");
    const device = await connect(token);
    device.socket.send("ping");
    await until(() => device.events.includes("pong"), "pong");
    device.socket.close();
  });

  it("refuses sockets without a session", async () => {
    await expect(connect("oms_forged")).rejects.toThrow();
  });

  it("forwards Gmail pushes to the devices of everyone who linked the mailbox", async () => {
    const alice = await signIn("alice@example.com");
    const bob = await signIn("bob@example.com");
    await link(alice.token, "inbox@example.com");
    const aliceDevice = await connect(alice.token);
    const bobDevice = await connect(bob.token);

    const response = await push({ emailAddress: "Inbox@Example.com", historyId: 4242 });
    expect(response.status).toBe(204);
    await until(() => aliceDevice.events.length > 0, "the mail event");
    expect(aliceDevice.events).toEqual([
      { type: "mail", email: "inbox@example.com", historyId: "4242" },
    ]);

    // Bob never linked it; a mailbox nobody linked is acknowledged and dropped.
    expect((await push({ emailAddress: "nobody@example.com", historyId: "1" })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bobDevice.events).toEqual([]);
    aliceDevice.socket.close();
    bobDevice.socket.close();
  });

  it("only accepts pushes Pub/Sub signed for this endpoint", async () => {
    const note = { emailAddress: "inbox@example.com", historyId: "1" };
    expect((await push(note, { email: "someone@example.com" })).status).toBe(401);
    expect((await push(note, { aud: "https://elsewhere/push" })).status).toBe(401);
    expect((await call("POST", "/push/gmail", undefined, {})).status).toBe(401);
  });

  it("acknowledges pushes that aren't Gmail notifications", async () => {
    expect((await push({ hello: "world" })).status).toBe(204);
  });
});

describe("tunnel", () => {
  /** The status the relay answers a WebSocket upgrade with (101 when it accepts it). */
  function upgradeStatus(query: string, headers: Record<string, string> = {}) {
    return new Promise<number>((resolve, reject) => {
      const request = http.get(`${base}/v1/tunnel?${query}`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on("error", reject);
    });
  }

  /** Opens a tunnel and collects what comes through it. */
  function tunnel(token: string, target: string) {
    const [host, port] = target.split(":");
    const url = `${base.replace(/^http/, "ws")}/v1/tunnel?host=${host}&port=${port}`;
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    } as unknown as string[]);
    socket.binaryType = "arraybuffer";
    const frames: string[] = [];
    socket.addEventListener("message", (e) =>
      frames.push(
        typeof e.data === "string"
          ? `text:${e.data}`
          : Buffer.from(e.data as ArrayBuffer).toString(),
      ),
    );
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })),
    );
    return { socket, frames, closed };
  }

  it("needs a session, a WebSocket and the web app's origin", async () => {
    const { token } = await signIn("tunnel-auth@example.com");
    expect(await upgradeStatus("host=imap.example.com&port=993")).toBe(401);
    const bearer = { authorization: `Bearer ${token}` };
    const plain = await fetch(`${base}/v1/tunnel?host=imap.example.com&port=993`, {
      headers: bearer,
    });
    expect(plain.status).toBe(426);
    const origin = "https://evil.example";
    expect(await upgradeStatus("host=imap.example.com&port=993", { ...bearer, origin })).toBe(403);
  });

  it("only reaches mail ports on public hosts", async () => {
    const { token } = await signIn("tunnel-rules@example.com");
    const bearer = { authorization: `Bearer ${token}` };
    for (const query of [
      "host=imap.example.com&port=80",
      "host=imap.example.com&port=22",
      "host=imap.example.com",
      "host=localhost&port=993",
      "host=mail.localhost&port=993",
      "host=127.0.0.1&port=993",
      "host=127.1&port=993",
      "host=2130706433&port=993",
      "host=0x7f.1&port=993",
      "host=10.1.2.3&port=993",
      "host=172.20.0.1&port=993",
      "host=192.168.1.1&port=993",
      "host=169.254.169.254&port=993",
      "host=100.64.0.1&port=993",
      "host=0.0.0.0&port=993",
      "host=%5B%3A%3A1%5D&port=993",
      "host=a%20b&port=993",
    ]) {
      expect(await upgradeStatus(query, bearer), query).toBe(400);
    }
  });

  it("pipes bytes both ways once the server is connected", async () => {
    const { token } = await signIn("tunnel-pipe@example.com");
    const { socket, frames, closed } = tunnel(token, mailTarget);
    await until(() => frames.length >= 2, "the greeting");
    expect(frames).toEqual(["text:open", "* OK hello\r\n"]);

    socket.send(new TextEncoder().encode("a1 NOOP\r\n"));
    await until(() => frames.join("").includes("a1 NOOP"), "the echo");

    // The server hanging up closes the tunnel.
    socket.send(new TextEncoder().encode("bye\r\n"));
    expect((await closed).code).toBe(1000);
  });

  it("closes the server's connection when the client closes", async () => {
    const { token } = await signIn("tunnel-close@example.com");
    let ended = 0;
    mailServer.once("connection", (connection) => connection.on("close", () => ended++));
    const { socket, frames } = tunnel(token, mailTarget);
    await until(() => frames.length >= 2, "the greeting");
    socket.close();
    await until(() => ended === 1, "the server's connection to close");
  });

  /** Links an IMAP mailbox on the test server, making its tunnels the linked kind. */
  async function linkTestServer(token: string, email: string) {
    const [host, port] = mailTarget.split(":");
    const server = { host: host!, port: Number(port), security: "tls" };
    const response = await call("PUT", `/v1/accounts/${encodeURIComponent(email)}`, token, {
      provider: "imap",
      imap: { username: email, imap: server, smtp: { ...server, host: "smtp.example.com" } },
    });
    expect(response.status).toBe(204);
  }

  /** Sends `total` bytes in 256 KB frames, once the tunnel is open. */
  async function flood(open: ReturnType<typeof tunnel>, total: number) {
    await until(() => open.frames.length >= 2, "the greeting");
    const frame = new Uint8Array(256 * 1024).fill(120);
    for (let sent = 0; sent < total && open.socket.readyState === WebSocket.OPEN;) {
      open.socket.send(frame);
      sent += frame.byteLength;
    }
  }

  /** Rate limits count per wall-clock minute (locally): start away from its end. */
  async function startOfMinute() {
    const into = Date.now() % 60_000;
    if (into > 40_000) await new Promise((resolve) => setTimeout(resolve, 60_000 - into));
  }

  it("carries 1 MB each way to a host that isn't the user's mailbox's", async () => {
    const { token } = await signIn("tunnel-unlinked@example.com");
    const open = tunnel(token, mailTarget);
    await flood(open, 1.25 * 2 ** 20);
    expect((await open.closed).code).toBe(TUNNEL_CLOSE.limit);
  });

  it("carries more to the servers of the user's IMAP mailboxes", async () => {
    const { token } = await signIn("tunnel-linked@example.com");
    await linkTestServer(token, "linked@tunnel.test");
    const open = tunnel(token, mailTarget);
    await flood(open, 1.25 * 2 ** 20);
    await until(() => open.frames.join("").length > 1.25 * 2 ** 20, "the echo");
    expect(open.socket.readyState).toBe(WebSocket.OPEN);
    open.socket.close();
  });

  it("cuts off a client far ahead of the server", { timeout: 20_000 }, async () => {
    const { token } = await signIn("tunnel-backlog@example.com");
    await linkTestServer(token, "backlog@tunnel.test");
    const open = tunnel(token, mailTarget);
    await until(() => open.frames.length >= 2, "the greeting");
    open.socket.send(new TextEncoder().encode("stall\r\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await flood(open, 64 * 2 ** 20);
    expect((await open.closed).code).toBe(TUNNEL_CLOSE.backlog);
  });

  it("limits tunnels a minute per user, fewer to other hosts", { timeout: 90_000 }, async () => {
    await startOfMinute();
    const { token } = await signIn("tunnel-rate@example.com");
    const opened = async () => {
      const open = tunnel(token, mailTarget);
      let code: number | undefined;
      void open.closed.then((closed) => (code = closed.code));
      await until(() => open.frames.length >= 2 || code !== undefined, "the greeting or a close");
      open.socket.close();
      return open.frames[0] === "text:open" ? "open" : code;
    };
    for (let i = 0; i < 6; i++) expect(await opened()).toBe("open");
    expect(await opened()).toBe(TUNNEL_CLOSE.rateLimited);

    // Linked, the same server counts against the looser limit.
    await linkTestServer(token, "rate@tunnel.test");
    expect(await opened()).toBe("open");
    // Someone else isn't limited.
    const other = await signIn("tunnel-rate-other@example.com");
    const theirs = tunnel(other.token, mailTarget);
    await until(() => theirs.frames.length >= 2, "the greeting");
    theirs.socket.close();
  });

  it("says when it couldn't connect", async () => {
    const { token } = await signIn("tunnel-fail@example.com");
    const { frames, closed } = tunnel(token, "nowhere.invalid:993");
    expect((await closed).code).toBe(TUNNEL_CLOSE.connectFailed);
    expect(frames).toEqual([]);
  });
});

describe("Gmail pushes next to IMAP mailboxes", () => {
  const imap = (username: string) => ({
    provider: "imap",
    imap: {
      username,
      imap: { host: "imap.gmail.test", port: 993, security: "tls" },
      smtp: { host: "smtp.gmail.test", port: 465, security: "tls" },
    },
  });
  const put = (token: string, email: string, body: unknown) =>
    call("PUT", `/v1/accounts/${encodeURIComponent(email)}`, token, body);
  const mailEvents = (events: (RelayEvent | string)[]) =>
    events.filter((e) => typeof e !== "string" && e.type === "mail");

  it("reach everyone who linked the address as Gmail, and nobody who linked it over IMAP", async () => {
    // Two Otter accounts linked the same Gmail account; one has an IMAP mailbox too.
    const owner = await signIn("push-owner@example.com");
    const partner = await signIn("push-partner@example.com");
    const stranger = await signIn("push-stranger@example.com");
    expect((await link(owner.token, "Shared@Gmail.test")).status).toBe(204);
    expect((await link(partner.token, "shared@gmail.test")).status).toBe(204);
    expect((await put(owner.token, "owner@fastmail.test", imap("owner"))).status).toBe(204);
    // Someone else claims the address over IMAP: it proves nothing, and takes nothing away.
    expect((await put(stranger.token, "shared@gmail.test", imap("shared"))).status).toBe(204);
    // Editing the Gmail link's profile (no provider, as every client sends it) keeps it Gmail.
    expect((await put(owner.token, "shared@gmail.test", { displayName: "Shared" })).status).toBe(
      204,
    );

    const devices = await Promise.all(
      [owner, owner, partner, stranger].map((user) => connect(user.token)),
    );
    const [ownerMac, ownerWeb, partnerMac, strangerMac] = devices;

    expect((await push({ emailAddress: "SHARED@gmail.test", historyId: "9001" })).status).toBe(204);
    const event = { type: "mail", email: "shared@gmail.test", historyId: "9001" };
    for (const device of [ownerMac, ownerWeb, partnerMac]) {
      await until(() => mailEvents(device.events).length > 0, "the mail event");
    }

    // Gmail never publishes for an IMAP mailbox; a notification for one reaches nobody.
    expect((await push({ emailAddress: "owner@fastmail.test", historyId: "1" })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const device of [ownerMac, ownerWeb, partnerMac]) {
      expect(mailEvents(device.events)).toEqual([event]);
    }
    expect(mailEvents(strangerMac.events)).toEqual([]);

    expect((await listAccounts(owner.token)).map((a) => [a.email, a.provider])).toEqual([
      ["shared@gmail.test", "gmail"],
      ["owner@fastmail.test", "imap"],
    ]);
    for (const device of devices) device.socket.close();
  });

  it("stop with the Gmail link, and don't come back with an IMAP link in its place", async () => {
    const { token } = await signIn("push-relinker@example.com");
    const route = `/v1/accounts/${encodeURIComponent("relinked@gmail.test")}`;
    await link(token, "relinked@gmail.test");
    const device = await connect(token);
    expect((await call("DELETE", route, token)).status).toBe(204);
    expect((await put(token, "relinked@gmail.test", imap("relinked"))).status).toBe(204);
    await push({ emailAddress: "relinked@gmail.test", historyId: "2" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mailEvents(device.events)).toEqual([]);
    device.socket.close();
  });
});

// The shared account uses the existing Mail identity and an app-scoped code.
describe("Otter identity provider", () => {
  const callback = "https://drive.otterware.app/api/auth/callback/otter";
  const verifier = "a".repeat(64);
  async function authorize(token: string, overrides: Record<string, string> = {}) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const query = new URLSearchParams({
      client_id: "otter-drive",
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile email",
      state: "drive-state",
      nonce: "drive-nonce",
      code_challenge: Buffer.from(digest).toString("base64url"),
      code_challenge_method: "S256",
      ...overrides,
    });
    const response = await fetch(`${base}/v1/auth/oauth2/authorize?${query}`, {
      headers: { cookie: `__Secure-better-auth.session_token=${token}`, accept: "text/html" },
      redirect: "manual",
    });
    // Node fetch sends Sec-Fetch-Mode: cors; the provider returns its redirect as JSON.
    if (response.status === 200) {
      const data = (await response.json()) as { redirect?: boolean; url?: string };
      expect(data.redirect).toBe(true);
      return Response.redirect(data.url!, 302);
    }
    return response;
  }
  function exchange(code: string, codeVerifier = verifier) {
    return fetch(`${base}/v1/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: "otter-drive",
        grant_type: "authorization_code",
        code,
        redirect_uri: callback,
        code_verifier: codeVerifier,
      }),
    });
  }
  it("publishes discovery and keeps shared sign-in cookies away from content hosts", async () => {
    const response = await call("GET", "/v1/auth/.well-known/openid-configuration");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      issuer: "https://relay.mail.otterware.app/v1/auth",
      code_challenge_methods_supported: ["S256"],
    });
    const page = await call("GET", "/otter/sign-in");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain("Continue with Google");
  });
  it("issues a verified identity for Drive without moving the Mail user or ending their session", async () => {
    const { token, user } = await signIn("shared-identity@example.com");
    const authorization = await authorize(token);
    expect(authorization.status, await authorization.clone().text()).toBe(302);
    const redirect = new URL(authorization.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(callback);
    expect(redirect.searchParams.get("state")).toBe("drive-state");
    const code = redirect.searchParams.get("code")!;
    expect(code).toBeTruthy();
    const response = await exchange(code);
    const tokens = (await response.json()) as {
      id_token: string;
      access_token: string;
      error?: string;
    };
    expect(response.status, JSON.stringify(tokens)).toBe(200);
    const keys = await (await call("GET", "/v1/auth/jwks")).json();
    const { payload } = await jwtVerify(
      tokens.id_token,
      createLocalJWKSet(keys as Parameters<typeof createLocalJWKSet>[0]),
      { issuer: "https://relay.mail.otterware.app/v1/auth", audience: "otter-drive" },
    );
    expect(payload).toMatchObject({
      sub: user.id,
      email: user.email,
      email_verified: true,
      nonce: "drive-nonce",
    });
    expect(payload.sid).toBeTypeOf("string");
    expect((await call("GET", "/v1/me", token)).status).toBe(200);
    expect((await exchange(code)).status).toBe(400);
    // A legacy Mail client's deletion must be rejected before deleting any session.
    const deletion = await call("POST", "/v1/auth/delete-user", token, {});
    expect(deletion.status).toBe(403);
    expect(await deletion.text()).toContain("also signs in to Otter Drive");
    expect((await call("GET", "/v1/me", token)).status).toBe(200);
    // An OAuth access token is not a Mail session and cannot read mail settings.
    expect((await call("GET", "/v1/me", tokens.access_token)).status).toBe(401);
  });
  it("rejects an unregistered redirect and a wrong PKCE verifier", async () => {
    const { token } = await signIn("pkce@example.com");
    const invalid = await authorize(token, {
      redirect_uri: "https://usercontent.otterware.app/callback",
    });
    expect(invalid.headers.get("location") ?? "").not.toContain(
      "https://usercontent.otterware.app",
    );
    expect(invalid.status).toBe(302);
    expect(invalid.headers.get("location")).toContain("/error?");
    const authorization = await authorize(token);
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code")!;
    expect((await exchange(code, "b".repeat(64))).status).toBe(401);
  });
  it("requires an explicit same-origin confirmation for shared deletion", async () => {
    const { token } = await signIn("delete-origin@example.com");
    const response = await call("POST", "/otter/delete-account", token, { confirmation: "DELETE" });
    expect(response.status).toBe(403);
    expect((await call("GET", "/v1/me", token)).status).toBe(200);
  });
});
