/**
 * The Otter Mail relay: Otter accounts (better-auth, auth.ts), the mailboxes
 * (Gmail, IMAP, Outlook) linked to them, realtime mail notifications, the web app's
 * Gmail and Outlook sign-ins (gmail.ts, outlook.ts) and its tunnel to IMAP/SMTP servers (tunnel.ts). Gmail publishes mailbox changes to a Pub/Sub
 * topic, Pub/Sub pushes them here, and the relay forwards them to the
 * signed-in devices over WebSocket; Microsoft Graph notifies here directly.
 * The API is described in packages/contracts/src/relay.ts.
 */

import { zValidator } from "@hono/zod-validator";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono, type MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { setSignedCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  GMAIL_SIGN_IN_CANCELLED,
  type CreateAgentTokenResponse,
  type ListAccountsResponse,
  type ListAgentTokensResponse,
  type MeResponse,
  type OutlookWatchResponse,
  type PreferencesResponse,
  type RelayEvent,
  type RelayUser,
  type SignInMethod,
  TUNNEL_CLOSE,
} from "@otter-mail/contracts/relay";
import type { MailProviderKind } from "@otter-mail/contracts/mail";
import { PROJECT_LIMITS, type ListProjectsResponse } from "@otter-mail/contracts/projects";

import { createAuth, googleClientIds, googleKeys, type Auth } from "./auth.ts";
import * as gmail from "./gmail.ts";
import { InvalidTokenError, remoteKeys, verifyGoogleJwt } from "./google-jwt.ts";
import identity from "./identity.ts";
import * as mcp from "./mcp.ts";
import { MICROSOFT_JWKS_URL, provesMailbox, verifyMicrosoftJwt } from "./microsoft-jwt.ts";
import * as outlook from "./outlook.ts";
import * as preferences from "./preferences.ts";
import * as projects from "./projects.ts";
import * as store from "./store.ts";
import * as push from "./push.ts";
import * as notificationConnections from "./notification-connections.ts";
import { NotificationMailbox } from "./notification-mailbox.ts";
import * as apns from "./apns.ts";
import * as tunnel from "./tunnel.ts";
import type { AgentHub } from "./agent-hub.ts";
import { SESSION_HEADER, type UserHub } from "./user-hub.ts";

export { AgentHub } from "./agent-hub.ts";
export { UserHub } from "./user-hub.ts";
export { NotificationMailbox };

export interface Env {
  NOTIFICATION_MAILBOX: DurableObjectNamespace<NotificationMailbox>;
  NOTIFICATION_CREDENTIAL_SECRET?: string;
  NOTIFICATION_GOOGLE_CLIENT_ID?: string;
  NOTIFICATION_GOOGLE_CLIENT_SECRET?: string;
  NOTIFICATION_GOOGLE_PUSH_TOPIC?: string;
  NOTIFICATION_GOOGLE_API_ORIGIN?: string;
  NOTIFICATION_MICROSOFT_CLIENT_ID?: string;
  NOTIFICATION_MICROSOFT_CLIENT_SECRET?: string;
  NOTIFICATION_IMAP_TEST_TARGET?: string;
  DB: D1Database;
  /** Private compatibility adapter to the independent Otter Accounts service. */
  ACCOUNTS?: {
    fetch(request: Request): Promise<Response>;
    getSession(headers: Record<string, string>): ReturnType<Auth["api"]["getSession"]>;
  };
  IDENTITY_MODE?: "legacy" | "paused" | "accounts";
  ACCOUNTS_ORIGIN?: string;
  USER_HUB: DurableObjectNamespace<UserHub>;
  AGENT_HUB?: DurableObjectNamespace<AgentHub>;
  /** The desktop app's Google OAuth client ("Desktop app" type). */
  GOOGLE_CLIENT_ID: string;
  /** The iPhone app's Google OAuth clients ("iOS", no secret), comma-separated: one per bundle ID. */
  GOOGLE_IOS_CLIENT_ID?: string;
  /** The web app's Google OAuth client ("Web application"): Otter and Gmail sign-in. */
  GOOGLE_WEB_CLIENT_ID: string;
  /** Its secret (a Worker secret). */
  GOOGLE_WEB_CLIENT_SECRET: string;
  /** Current Gmail web client; GOOGLE_WEB_CLIENT_* refreshes existing sealed grants. */
  GOOGLE_GMAIL_CLIENT_ID?: string;
  GOOGLE_GMAIL_CLIENT_SECRET?: string;
  /** OAuth audiences accepted from older installed apps. */
  GOOGLE_LEGACY_CLIENT_IDS?: string;
  /** Where the web app runs (https://mail.otterware.app): trusted for CORS and redirects. */
  APP_ORIGIN: string;
  /** The first-party Drive app, for the shared account lifecycle. */
  DRIVE_ORIGIN: string;
  /** The session cookie's domain, shared with the web app ("mail.otterware.app"); unset locally. */
  COOKIE_DOMAIN?: string;
  /** Pub/Sub topic Gmail publishes to (`projects/…/topics/…`). */
  PUSH_TOPIC: string;
  /** Kept as /v1/me's default for installed clients using the previous Google project. */
  PUSH_TOPIC_LEGACY?: string;
  /** Audience of the OIDC token on Pub/Sub push requests (the push route's URL). */
  PUSH_AUDIENCE: string;
  /** Service account Pub/Sub signs push requests as. */
  PUSH_SERVICE_ACCOUNT: string;
  PUSH_SERVICE_ACCOUNT_LEGACY?: string;
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  /** PKCS#8 .p8 contents, a Worker secret. */
  APNS_PRIVATE_KEY?: string;
  APNS_SANDBOX_TOPIC?: string;
  APNS_PRODUCTION_TOPIC?: string;
  /** Local mock APNs server; only tests set it. Production uses Apple's fixed hosts. */
  APNS_TEST_ORIGIN?: string;
  /** This Worker's public URL, for better-auth. */
  BETTER_AUTH_URL: string;
  /** Signs better-auth's tokens (a Worker secret). */
  BETTER_AUTH_SECRET: string;
  /** Where Google's signing keys are published; only tests change it. */
  GOOGLE_JWKS_URL?: string;
  /** Google's OAuth token endpoint; only tests change it. */
  GOOGLE_TOKEN_URL?: string;
  /**
   * The web app's Microsoft OAuth client (an Entra app registration, "Web"
   * platform): its Outlook sign-in. Without it and its secret, the web app
   * has no Outlook.
   */
  MICROSOFT_CLIENT_ID?: string;
  /** Its secret (a Worker secret). */
  MICROSOFT_CLIENT_SECRET?: string;
  /** The desktop and iPhone apps' Microsoft clients, comma-separated: audiences of their ID tokens. */
  MICROSOFT_DESKTOP_CLIENT_IDS?: string;
  /** Where Microsoft's signing keys are published; only tests change it. */
  MICROSOFT_JWKS_URL?: string;
  /** Microsoft's OAuth token endpoint; only tests change it. */
  MICROSOFT_TOKEN_URL?: string;
  /** Microsoft Graph's origin (https://graph.microsoft.com); only tests change it. */
  MICROSOFT_GRAPH_URL?: string;
  /** Tunnels a minute per user to the servers of their IMAP mailboxes (wrangler.jsonc). */
  TUNNEL_LIMIT: RateLimit;
  /** Tunnels a minute per user to any other host: adding a mailbox, before it's linked. */
  TUNNEL_UNLINKED_LIMIT: RateLimit;
  /** A "host:port" the tunnel may reach despite its rules; only tests set it (a local server). */
  TUNNEL_TEST_TARGET?: string;
  /**
   * "true" lets the tunnel reach any host and port, a mail server on this
   * machine included. Only `pnpm dev` sets it; never in wrangler.jsonc.
   */
  TUNNEL_ALLOW_PRIVATE?: string;
  /**
   * "true" opens the demo's routes (`pnpm dev:demo`): an Otter session for any
   * address, without Google, and its saved Gmail sign-in sealed for it. Only
   * the dev runner sets it; never in wrangler.jsonc.
   */
  DEV_DEMO?: string;
}

type Session = { id: string; user: RelayUser; expiresAt: number; createdAt: number };

export type App = { Bindings: Env; Variables: { db: store.Db; auth: Auth; session: Session } };

/** Verifies a Google ID token issued to one of the apps. */
async function verifyIdToken(env: Env, idToken: string) {
  try {
    return await verifyGoogleJwt(idToken, googleClientIds(env), googleKeys(env));
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      throw new HTTPException(401, { message: `Invalid ID token (${err.message}).` });
    }
    throw err;
  }
}

/** Whether a Microsoft ID token issued to one of the apps proves the caller signed in to `email`. */
async function provesOutlook(env: Env, idToken: string, email: string) {
  const audiences = [
    env.MICROSOFT_CLIENT_ID,
    ...(env.MICROSOFT_DESKTOP_CLIENT_IDS ?? "").split(","),
  ].filter((id): id is string => Boolean(id));
  try {
    const keys = remoteKeys(env.MICROSOFT_JWKS_URL || MICROSOFT_JWKS_URL);
    return provesMailbox(await verifyMicrosoftJwt(idToken, audiences, keys), email);
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      throw new HTTPException(401, { message: `Invalid ID token (${err.message}).` });
    }
    throw err;
  }
}

const hub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));

/** Malformed input answers 400 in the relay's `{ error }` shape. */
const rejectInvalid = (result: { success: boolean }) => {
  if (!result.success) throw new HTTPException(400, { message: "Invalid request." });
};

const profileField = z.string().max(2048).nullable().optional();
const mailbox = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email());

const app = new Hono<App>();

// The web app calls the relay from its own origin, with its session cookie.
app.use("/v1/*", (c, next) =>
  cors({ origin: c.env.APP_ORIGIN, credentials: true, maxAge: 86_400 })(c, next),
);

app.use(async (c, next) => {
  if (c.env.IDENTITY_MODE === "paused" && !c.req.path.startsWith("/push/")) {
    c.header("Retry-After", "60");
    return c.json({ error: "Account maintenance in progress. Please try again shortly." }, 503);
  }
  if (
    c.env.IDENTITY_MODE === "accounts" &&
    (c.req.path.startsWith("/v1/auth/") ||
      c.req.path.startsWith("/.well-known/") ||
      c.req.path.startsWith("/otter/"))
  ) {
    if (!c.env.ACCOUNTS) return c.json({ error: "Accounts is unavailable." }, 503);
    if (c.req.path.startsWith("/otter/"))
      return c.redirect(`${c.env.ACCOUNTS_ORIGIN}${c.req.path}${new URL(c.req.url).search}`, 307);
    return c.env.ACCOUNTS.fetch(c.req.raw);
  }
  const db = store.openDb(c.env.DB);
  c.set("db", db);
  c.set("auth", createAuth(c.env, db));
  await next();
});

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error("Unhandled error", err);
  return c.json({ error: "Something went wrong." }, 500);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));

app.get("/", (c) => c.text("Otter Mail relay\n"));

app.get("/v1/notifications/callback", async (c) => {
  const { state, code, error } = c.req.query();
  if (!state) return c.text("Start notification setup in Otter Mail.", 400);
  return notificationConnections.callbackResponse(c.env, state, error ? undefined : code);
});

// Reuse Google's registered redirect. A separate state key/audience distinguishes the limited notification grant.
app.get("/v1/gmail/callback", async (c, next) => {
  const { state, code, error } = c.req.query();
  if (state && (await notificationConnections.isAuthorizationState(c.env, state))) {
    return notificationConnections.callbackResponse(c.env, state, error ? undefined : code);
  }
  await next();
});

/** Sign-in, sign-out, devices and account deletion. */
// Standalone local development has no Accounts service. Production forwards
// this request above to the coordinator that visits every cookie owner.
app.post("/v1/auth/browser-sign-out/start", async (c) => {
  if (c.req.header("origin") !== c.env.APP_ORIGIN) throw new HTTPException(403);
  const headers = new Headers(c.req.raw.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  headers.delete("authorization");
  const result = await c.var.auth.handler(
    new Request(new URL("/v1/auth/sign-out", c.req.url), {
      method: "POST",
      headers,
      body: "{}",
    }),
  );
  if (!result.ok) throw new HTTPException(502, { message: "Could not sign out. Try again." });
  for (const cookie of result.headers.getSetCookie())
    c.header("Set-Cookie", cookie, { append: true });
  c.header("Cache-Control", "no-store");
  return c.redirect(c.env.APP_ORIGIN, 303);
});
app.on(["GET", "POST"], "/v1/auth/*", (c) => c.var.auth.handler(c.req.raw));

// ── The demo (`pnpm dev:demo`, DEV_DEMO) ─────────────────────────────────────

/** Everywhere but the demo's local relay, these routes don't exist. */
const demoOnly: MiddlewareHandler<App> = async (c, next) => {
  if (c.env.DEV_DEMO !== "true") throw new HTTPException(404, { message: "Not found." });
  await next();
};

/** Signs the browser in to the Otter account for `email` (made if new), as Google would. */
app.post(
  "/v1/dev/session",
  demoOnly,
  zValidator("json", z.object({ email: mailbox }), rejectInvalid),
  async (c) => {
    const { email } = c.req.valid("json");
    const ctx = await c.var.auth.$context;
    const user =
      (await ctx.internalAdapter.findUserByEmail(email))?.user ??
      (await ctx.internalAdapter.createUser(
        { email, name: email, emailVerified: true },
        { method: "admin" },
      ));
    const session = await ctx.internalAdapter.createSession(user.id, false);
    const cookie = ctx.authCookies.sessionToken;
    await setSignedCookie(c, cookie.name, session.token, ctx.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: cookie.attributes.maxAge,
    });
    return c.json({ email });
  },
);
app.get("/.well-known/*", (c) => c.var.auth.handler(c.req.raw));
app.route("/otter", identity);

// ── Signed-in routes ────────────────────────────────────────────────────────

const authed = new Hono<App>();

authed.use(async (c, next) => {
  const central = c.env.IDENTITY_MODE === "accounts";
  const found = central
    ? await c.env.ACCOUNTS?.getSession(Object.fromEntries(c.req.raw.headers))
    : await c.var.auth.api.getSession({ headers: c.req.raw.headers });
  if (!found) throw new HTTPException(401, { message: "Not signed in." });
  const { session, user } = found;
  if (central) await store.ensureUser(c.env.DB, user);
  c.set("session", {
    id: session.id,
    expiresAt: session.expiresAt.getTime(),
    createdAt: session.createdAt.getTime(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name || null,
      picture: user.image ?? null,
      ...("signInMethods" in user && Array.isArray(user.signInMethods)
        ? { signInMethods: user.signInMethods as SignInMethod[] }
        : {}),
    },
  });
  await next();
});

// The AI SDK loop and API key stay in a Durable Object per Otter account.
authed.route("/", notificationConnections.routes());
authed.all("/agent/*", async (c) => {
  if (c.req.header("origin") && c.req.header("origin") !== c.env.APP_ORIGIN)
    throw new HTTPException(403, { message: "Not from the web app." });
  if (!c.env.AGENT_HUB)
    throw new HTTPException(503, { message: "The agent server is not configured." });
  const headers = new Headers(c.req.raw.headers);
  headers.set(SESSION_HEADER, c.var.session.id);
  return c.env.AGENT_HUB.get(c.env.AGENT_HUB.idFromName(c.var.session.user.id)).fetch(
    new Request(c.req.raw, { headers }),
  );
});

// ── Gmail sign-in for the web app (gmail.ts) ────────────────────────────────

authed.get("/gmail/authorize", (c) =>
  gmail
    .authorizeUrl(c.env, c.var.session.user.id, c.req.query("login_hint"))
    .then((url) => c.redirect(url)),
);

authed.get("/gmail/callback", async (c) => {
  const { code, state, error } = c.req.query();
  try {
    if (error === "access_denied")
      return gmail.popupResponse(c.env, { error: GMAIL_SIGN_IN_CANCELLED });
    if (error || !code || !state) throw new Error(error ?? "missing code");
    if ((await gmail.stateUser(c.env, state)) !== c.var.session.user.id) {
      throw new Error("signed in as someone else");
    }
    return gmail.popupResponse(c.env, {
      result: await gmail.completeSignIn(c.env, c.var.session.user.id, code),
    });
  } catch (err) {
    console.warn("Gmail sign-in failed", String(err));
    return gmail.popupResponse(c.env, { error: String(err) });
  }
});

authed.post(
  "/gmail/token",
  zValidator("json", z.object({ sealed: z.string() }), rejectInvalid),
  async (c) => {
    try {
      return c.json(await gmail.refresh(c.env, c.var.session.user.id, c.req.valid("json").sealed));
    } catch (err) {
      if (err instanceof gmail.GoogleTokenError && err.revoked) {
        throw new HTTPException(410, { message: "Google revoked this sign-in." });
      }
      if (err instanceof gmail.GoogleTokenError)
        throw new HTTPException(502, { message: err.message });
      throw new HTTPException(400, { message: "Invalid sealed token." });
    }
  },
);

authed.post(
  "/dev/gmail",
  demoOnly,
  zValidator("json", z.object({ refreshToken: z.string().min(1) }), rejectInvalid),
  async (c) =>
    c.json(await gmail.demoSignIn(c.env, c.var.session.user.id, c.req.valid("json").refreshToken)),
);

authed.post(
  "/dev/outlook",
  demoOnly,
  zValidator("json", z.object({ refreshToken: z.string().min(1) }), rejectInvalid),
  async (c) =>
    c.json(
      await outlook.demoSignIn(c.env, c.var.session.user.id, c.req.valid("json").refreshToken),
    ),
);

// ── Outlook sign-in for the web app, and Graph's notifications (outlook.ts) ─

authed.get("/outlook/authorize", async (c) => {
  if (!outlook.configured(c.env))
    throw new HTTPException(503, { message: "Outlook sign-in is not configured." });
  return c.redirect(
    await outlook.authorizeUrl(c.env, c.var.session.user.id, c.req.query("login_hint")),
  );
});

authed.get("/outlook/callback", async (c) => {
  const { code, state, error } = c.req.query();
  try {
    if (error === "access_denied")
      return outlook.popupResponse(c.env, { error: GMAIL_SIGN_IN_CANCELLED });
    if (error || !code || !state) throw new Error(error ?? "missing code");
    if ((await outlook.stateUser(c.env, state)) !== c.var.session.user.id) {
      throw new Error("signed in as someone else");
    }
    return outlook.popupResponse(c.env, {
      result: await outlook.completeSignIn(c.env, c.var.session.user.id, code),
    });
  } catch (err) {
    console.warn("Outlook sign-in failed", String(err));
    return outlook.popupResponse(c.env, { error: String(err) });
  }
});

authed.post(
  "/outlook/token",
  zValidator("json", z.object({ sealed: z.string() }), rejectInvalid),
  async (c) => {
    try {
      return c.json(
        await outlook.refresh(c.env, c.var.session.user.id, c.req.valid("json").sealed),
      );
    } catch (err) {
      if (err instanceof outlook.MicrosoftTokenError && err.revoked) {
        throw new HTTPException(410, { message: "Microsoft revoked this sign-in." });
      }
      if (err instanceof outlook.MicrosoftTokenError)
        throw new HTTPException(502, { message: err.message });
      throw new HTTPException(400, { message: "Invalid sealed token." });
    }
  },
);

authed.post(
  "/outlook/watch",
  zValidator("json", z.object({ email: mailbox }), rejectInvalid),
  async (c) => {
    const { email } = c.req.valid("json");
    if ((await store.linkedProvider(c.var.db, c.var.session.user.id, email)) !== "outlook") {
      throw new HTTPException(404, { message: "No such Outlook mailbox." });
    }
    return c.json({
      notificationUrl: outlook.notificationUrl(c.env, email),
      clientState: await outlook.clientState(c.env, email),
    } satisfies OutlookWatchResponse);
  },
);

authed.get("/me", (c) => {
  const env = c.env;
  return c.json({
    user: c.var.session.user,
    pushTopic: env.PUSH_TOPIC_LEGACY ?? env.PUSH_TOPIC,
    ...(env.GOOGLE_GMAIL_CLIENT_ID
      ? {
          pushTopics: {
            [env.GOOGLE_GMAIL_CLIENT_ID.split("-")[0]!]: env.PUSH_TOPIC,
            ...(env.PUSH_TOPIC_LEGACY
              ? { [env.GOOGLE_WEB_CLIENT_ID.split("-")[0]!]: env.PUSH_TOPIC_LEGACY }
              : {}),
          },
        }
      : {}),
    outlook: outlook.configured(env),
  } satisfies MeResponse);
});

authed.put(
  "/push/device",
  zValidator(
    "json",
    z
      .object({
        token: z
          .string()
          .regex(/^(?:[a-fA-F0-9]{2}){1,256}$/)
          .transform((value) => value.toLowerCase()),
        topic: z.string().min(1).max(255),
        environment: z.enum(["sandbox", "production"]),
        mode: z.enum(["off", "inbox", "all"]),
        mailboxes: z.array(mailbox).max(32),
      })
      .strict(),
    rejectInvalid,
  ),
  async (c) => {
    if (!apns.configured(c.env))
      throw new HTTPException(503, { message: "iPhone push is not configured." });
    await push.register(c.env, c.var.session, c.req.valid("json"));
    for (const email of c.req.valid("json").mailboxes) {
      if (await notificationConnections.connection(c.env, c.var.session.user.id, email)) {
        await notificationConnections.watcher(c.env, c.var.session.user.id, email).changed();
      }
    }
    return c.body(null, 204);
  },
);

authed.delete("/push/device", async (c) => {
  await push.remove(c.env, c.var.session.user.id, c.var.session.id);
  return c.body(null, 204);
});

/**
 * `?providers=gmail,imap,outlook`: the providers the client knows. Builds
 * from before IMAP don't send it, and would take any mailbox for a Gmail
 * account.
 */
const providersQuery = z.object({
  providers: z
    .string()
    .optional()
    .transform((list) =>
      (list ?? "gmail")
        .split(",")
        .filter((p): p is MailProviderKind => p === "gmail" || p === "imap" || p === "outlook"),
    ),
});

authed.get("/accounts", zValidator("query", providersQuery, rejectInvalid), async (c) => {
  const { providers } = c.req.valid("query");
  const accounts = await store.listAccounts(c.var.db, c.var.session.user.id, providers);
  return c.json({ accounts } satisfies ListAccountsResponse);
});

const mailServer = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls"]),
});

/**
 * Link a mailbox, or update its profile. Linking a Gmail or Outlook account
 * needs an ID token (Google's, Microsoft's) for that address: the caller
 * signed in to it. Linking an IMAP one needs its settings. Later edits need
 * neither, and can't change the provider.
 */
authed.put(
  "/accounts/:email",
  zValidator("param", z.object({ email: mailbox }), rejectInvalid),
  zValidator(
    "json",
    z.object({
      idToken: z.string().optional(),
      provider: z.enum(["gmail", "imap", "outlook"]).optional(),
      imap: z
        .object({ username: z.string().min(1).max(320), imap: mailServer, smtp: mailServer })
        .optional(),
      name: profileField,
      picture: profileField,
      displayName: profileField,
      color: profileField,
    }),
    rejectInvalid,
  ),
  async (c) => {
    const { email } = c.req.valid("param");
    const { idToken, ...patch } = c.req.valid("json");
    const { db, session } = c.var;
    const linked = await store.linkedProvider(db, session.user.id, email);
    const provider = patch.provider ?? linked ?? "gmail";
    if (linked && linked !== provider) {
      throw new HTTPException(409, { message: `Linked as ${linked}: unlink it first.` });
    }
    if (provider !== "imap" && patch.imap) {
      throw new HTTPException(400, { message: "IMAP settings are for IMAP mailboxes." });
    }
    if (!linked && provider === "imap" && !patch.imap) {
      throw new HTTPException(400, { message: "Linking an IMAP mailbox needs its settings." });
    }
    if (!linked && provider === "gmail") {
      if (!idToken) throw new HTTPException(403, { message: "Linking needs an ID token." });
      if ((await verifyIdToken(c.env, idToken)).email !== email) {
        throw new HTTPException(403, { message: "The ID token is for another address." });
      }
    }
    if (!linked && provider === "outlook") {
      if (!idToken) throw new HTTPException(403, { message: "Linking needs an ID token." });
      if (!(await provesOutlook(c.env, idToken, email))) {
        throw new HTTPException(403, { message: "The ID token doesn't prove this address." });
      }
    }
    await store.putAccount(db, session.user.id, email, patch);
    await hub(c.env, session.user.id).publish({ type: "accounts" });
    return c.body(null, 204);
  },
);

authed.delete(
  "/accounts/:email",
  zValidator("param", z.object({ email: mailbox }), rejectInvalid),
  zValidator("query", providersQuery, rejectInvalid),
  async (c) => {
    const userId = c.var.session.user.id;
    const { email } = c.req.valid("param");
    if (await store.deleteAccount(c.var.db, userId, email, c.req.valid("query").providers)) {
      await notificationConnections.remove(c.env, userId, email);
      await hub(c.env, userId).forgetPush(email);
      await hub(c.env, userId).publish({ type: "accounts" });
    }
    return c.body(null, 204);
  },
);

authed.get("/preferences", async (c) =>
  c.json(
    (await preferences.read(
      c.var.db,
      c.env.BETTER_AUTH_SECRET,
      c.var.session.user.id,
    )) satisfies PreferencesResponse,
  ),
);

authed.put(
  "/preferences",
  zValidator(
    "json",
    z.object({
      // Section names end up in JSON paths: plain identifiers only.
      preferences: z
        .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), z.unknown())
        .optional(),
      hermesKey: z.string().max(4096).nullable().optional(),
    }),
    rejectInvalid,
  ),
  async (c) => {
    const userId = c.var.session.user.id;
    if (
      !(await preferences.write(c.var.db, c.env.BETTER_AUTH_SECRET, userId, c.req.valid("json")))
    ) {
      throw new HTTPException(413, { message: "Preferences too large." });
    }
    await hub(c.env, userId).publish({ type: "preferences" });
    return c.body(null, 204);
  },
);

// ── Projects (projects.ts) ──────────────────────────────────────────────────

async function projectsChanged(env: Env, userId: string): Promise<void> {
  await hub(env, userId).publish({ type: "projects" });
}

/** A write the relay refused: 404 without the project, 413 past its limits. */
const refuse = (refusal: projects.Refusal | null) => {
  if (refusal === "missing") throw new HTTPException(404, { message: "No such project." });
  if (refusal === "full") throw new HTTPException(413, { message: "Too many for a project." });
};

const itemId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const timestamp = z.number().int().nonnegative();

authed.get("/projects", async (c) =>
  c.json({
    projects: await projects.list(c.var.db, c.var.session.user.id),
  } satisfies ListProjectsResponse),
);

authed.put(
  "/projects/:id",
  zValidator("param", z.object({ id: itemId }), rejectInvalid),
  zValidator(
    "json",
    z.object({
      name: z.string().trim().min(1).max(PROJECT_LIMITS.name),
      status: z.enum(["active", "settled"]),
      notes: z.string().max(PROJECT_LIMITS.notes),
      createdAt: timestamp,
      settledAt: timestamp.nullable(),
    }),
    rejectInvalid,
  ),
  async (c) => {
    const userId = c.var.session.user.id;
    refuse(await projects.put(c.var.db, userId, c.req.valid("param").id, c.req.valid("json")));
    await projectsChanged(c.env, userId);
    return c.body(null, 204);
  },
);

authed.delete(
  "/projects/:id",
  zValidator("param", z.object({ id: itemId }), rejectInvalid),
  async (c) => {
    const userId = c.var.session.user.id;
    if (await projects.remove(c.var.db, userId, c.req.valid("param").id)) {
      await projectsChanged(c.env, userId);
    }
    return c.body(null, 204);
  },
);

const threadParams = z.object({
  id: itemId,
  email: mailbox,
  threadId: z.string().min(1).max(512),
});

authed.put(
  "/projects/:id/threads/:email/:threadId",
  zValidator("param", threadParams, rejectInvalid),
  zValidator("json", z.object({ addedAt: timestamp }), rejectInvalid),
  async (c) => {
    const userId = c.var.session.user.id;
    const { id, email, threadId } = c.req.valid("param");
    refuse(await projects.putThread(c.var.db, userId, id, email, threadId, c.req.valid("json")));
    await projectsChanged(c.env, userId);
    return c.body(null, 204);
  },
);

authed.delete(
  "/projects/:id/threads/:email/:threadId",
  zValidator("param", threadParams, rejectInvalid),
  async (c) => {
    const userId = c.var.session.user.id;
    const { id, email, threadId } = c.req.valid("param");
    await projects.removeThread(c.var.db, userId, id, email, threadId);
    await projectsChanged(c.env, userId);
    return c.body(null, 204);
  },
);

const linkParams = z.object({ id: itemId, linkId: itemId });

authed.put(
  "/projects/:id/links/:linkId",
  zValidator("param", linkParams, rejectInvalid),
  zValidator(
    "json",
    z.object({
      url: z.url().max(PROJECT_LIMITS.url),
      title: z.string().max(PROJECT_LIMITS.title),
      addedAt: timestamp,
    }),
    rejectInvalid,
  ),
  async (c) => {
    const userId = c.var.session.user.id;
    const { id, linkId } = c.req.valid("param");
    refuse(await projects.putLink(c.var.db, userId, id, linkId, c.req.valid("json")));
    await projectsChanged(c.env, userId);
    return c.body(null, 204);
  },
);

authed.delete(
  "/projects/:id/links/:linkId",
  zValidator("param", linkParams, rejectInvalid),
  async (c) => {
    const userId = c.var.session.user.id;
    const { id, linkId } = c.req.valid("param");
    await projects.removeLink(c.var.db, userId, id, linkId);
    await projectsChanged(c.env, userId);
    return c.body(null, 204);
  },
);

// ── Agent tokens (mcp.ts) ───────────────────────────────────────────────────

authed.get("/agent-tokens", async (c) =>
  c.json({
    tokens: await mcp.listTokens(c.var.db, c.var.session.user.id),
  } satisfies ListAgentTokensResponse),
);

authed.post(
  "/agent-tokens",
  zValidator("json", z.object({ name: z.string().trim().min(1).max(100) }), rejectInvalid),
  async (c) =>
    c.json(
      (await mcp.createToken(
        c.var.db,
        c.var.session.user.id,
        c.req.valid("json").name,
      )) satisfies CreateAgentTokenResponse,
    ),
);

authed.delete(
  "/agent-tokens/:id",
  zValidator("param", z.object({ id: z.string().max(64) }), rejectInvalid),
  async (c) => {
    await mcp.deleteToken(c.var.db, c.var.session.user.id, c.req.valid("param").id);
    return c.body(null, 204);
  },
);

/** The device's event stream, handed to the user's Durable Object. */
authed.get("/events", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    throw new HTTPException(426, { message: "Expected a WebSocket upgrade." });
  }
  const { id, user } = c.var.session;
  const headers = new Headers(c.req.raw.headers);
  headers.set(SESSION_HEADER, id);
  return hub(c.env, user.id).fetch(new Request(c.req.raw, { headers }));
});

/**
 * What a tunnel may carry each way (tunnel.ts). The servers of the user's
 * IMAP mailboxes get enough for mail; any other host, only enough to check a
 * password before the mailbox is linked.
 */
const TUNNEL_BYTES = { linked: 200 * 2 ** 20, unlinked: 2 ** 20 };

/**
 * A TCP connection to a mail server, for the web app (tunnel.ts). Rate
 * limited per user with Workers' rate limiting bindings (wrangler.jsonc),
 * counted in memory at each Cloudflare location: no Durable Object or KV per
 * tunnel.
 */
authed.get(
  "/tunnel",
  zValidator("query", z.object({ host: z.string(), port: z.coerce.number().int() }), rejectInvalid),
  async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new HTTPException(426, { message: "Expected a WebSocket upgrade." });
    }
    // Browsers send the session cookie from any page on the site: only the web app's count.
    const origin = c.req.header("origin");
    if (origin && origin !== c.env.APP_ORIGIN) {
      throw new HTTPException(403, { message: "Not from the web app." });
    }
    const { host, port } = c.req.valid("query");
    const anywhere = c.env.TUNNEL_ALLOW_PRIVATE === "true";
    if (!anywhere && !tunnel.allowed(host, port, c.env.TUNNEL_TEST_TARGET)) {
      throw new HTTPException(400, { message: "Only mail ports on public hosts." });
    }
    const userId = c.var.session.user.id;
    const servers = await store.imapServers(c.var.db, userId);
    const linked = servers.has(`${host.toLowerCase()}:${port}`);
    const limiter = linked ? c.env.TUNNEL_LIMIT : c.env.TUNNEL_UNLINKED_LIMIT;
    if (!(await limiter.limit({ key: userId })).success) {
      return tunnel.refuse(TUNNEL_CLOSE.rateLimited, "Too many connections: try again in a minute");
    }
    return tunnel.open(host, port, linked ? TUNNEL_BYTES.linked : TUNNEL_BYTES.unlinked);
  },
);

app.route("/v1", authed);

// ── MCP, for agents (mcp.ts) ────────────────────────────────────────────────

/** The project tools, for an agent token's account (Streamable HTTP, stateless). */
app.all("/mcp", async (c) => {
  const token = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const userId = token ? await mcp.tokenUser(c.var.db, token) : null;
  if (!userId) {
    return c.json({ error: "An agent token is required (Settings › Assistant)." }, 401, {
      "WWW-Authenticate": 'Bearer realm="otter-mail"',
    });
  }
  return mcp.serve(
    c.req.raw,
    projects.backend(c.var.db, userId, () => projectsChanged(c.env, userId)),
  );
});

// ── Gmail push ──────────────────────────────────────────────────────────────

const gmailNotification = z.object({
  emailAddress: mailbox,
  historyId: z
    .union([z.string(), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .transform(String)
    .pipe(z.string().regex(/^\d{1,20}$/)),
});

/**
 * Pub/Sub push of a Gmail notification (`{ emailAddress, historyId }`), sent
 * on to every device of everyone who linked that address. Anything else is
 * acknowledged and dropped: Pub/Sub would only redeliver it.
 */
app.post(
  "/push/gmail",
  bearerAuth({
    verifyToken: async (token, c) => {
      const env = c.env as Env;
      try {
        const claims = await verifyGoogleJwt(token, env.PUSH_AUDIENCE, googleKeys(env));
        return [env.PUSH_SERVICE_ACCOUNT, env.PUSH_SERVICE_ACCOUNT_LEGACY].includes(claims.email);
      } catch (err) {
        if (err instanceof InvalidTokenError) return false;
        throw err;
      }
    },
  }),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as { message?: { data?: string } } | null;
    let data: unknown = null;
    try {
      data = JSON.parse(
        atob((body?.message?.data ?? "").replaceAll("-", "+").replaceAll("_", "/")),
      );
    } catch {
      // not a Gmail notification
    }
    const parsed = gmailNotification.safeParse(data);
    if (!parsed.success) return c.body(null, 204);

    const email = parsed.data.emailAddress.toLowerCase();
    const event: RelayEvent = { type: "mail", email, historyId: parsed.data.historyId };
    const users = await store.usersWithMailbox(c.var.db, email, "gmail");
    await Promise.all(
      users.map(async (userId) => {
        const target = hub(c.env, userId);
        await target.publish(event);
        await target.queuePush(userId, email, parsed.data.historyId);
      }),
    );
    return c.body(null, 204);
  },
);

// ── Outlook push ────────────────────────────────────────────────────────────

/**
 * Microsoft Graph's change notifications for an Outlook mailbox (a
 * subscription a device made with `/v1/outlook/watch`'s answer), sent on as
 * a `mail` event to every device of everyone who linked it as Outlook. Only
 * notifications carrying the mailbox's clientState count; everything is
 * acknowledged (202), or Graph would retry it for hours.
 */
app.post(
  "/push/outlook/:email",
  zValidator("param", z.object({ email: mailbox }), (result, c) => {
    if (!result.success) return c.body(null, 202);
  }),
  async (c) => {
    // A new subscription: Graph checks the URL answers within 10 seconds, echoing its token.
    const validationToken = c.req.query("validationToken");
    if (validationToken !== undefined) {
      c.header("X-Content-Type-Options", "nosniff");
      return c.text(validationToken);
    }
    const { email } = c.req.valid("param");
    const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
    const notifications = Array.isArray(body?.value) ? (body.value as unknown[]) : [];
    let genuine = false;
    for (const note of notifications.slice(0, 100)) {
      const state = (note as { clientState?: unknown } | null)?.clientState;
      if (typeof state === "string" && (await outlook.checkClientState(c.env, email, state))) {
        genuine = true;
        break;
      }
    }
    if (!genuine) return c.body(null, 202);

    const event: RelayEvent = { type: "mail", email, historyId: "" };
    const users = await store.usersWithMailbox(c.var.db, email, "outlook");
    await Promise.all(
      users.map(async (userId) => {
        await hub(c.env, userId).publish(event);
        await notificationConnections.watcher(c.env, userId, email).changed();
      }),
    );
    return c.body(null, 202);
  },
);

/** Account lifecycle calls are private Worker RPC, never public HTTP routes. */
export class IdentityLifecycle extends WorkerEntrypoint<Env> {
  async disconnect(userId: string, sessionId?: string): Promise<void> {
    await push.remove(this.env, userId, sessionId, true);
    await hub(this.env, userId).disconnect(sessionId);
    await this.env.AGENT_HUB?.get(this.env.AGENT_HUB.idFromName(userId)).disconnect(sessionId);
  }
  async deleteUser(userId: string): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR IGNORE INTO deleted_identity (user_id) VALUES (?)").bind(
        userId,
      ),
      this.env.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId),
    ]);
    await this.disconnect(userId);
    await this.env.AGENT_HUB?.get(this.env.AGENT_HUB.idFromName(userId)).deleteUser();
  }
}

export default app;
