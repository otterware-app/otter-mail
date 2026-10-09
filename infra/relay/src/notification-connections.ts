/** Explicit opt-in provider connections for verified alerts. Credentials are never returned to clients. */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { base64url, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { ImapSettings, MailProviderKind } from "@otter-mail/contracts/mail";
import type { NotificationConnection } from "@otter-mail/contracts/relay";
import type { App, Env } from "./worker.ts";
import { derivedKey } from "./keys.ts";
import { allowed } from "./tunnel.ts";

export type Credential =
  | { provider: "gmail" | "outlook"; clientId: string; refreshToken: string }
  | { provider: "imap"; settings: ImapSettings; password: string };
export type Connection = {
  user_id: string;
  email: string;
  provider: MailProviderKind;
  generation: string;
  credential: string;
  status: NotificationConnection["status"];
  updated_at: number;
};
type Authorization = {
  id: string;
  user_id: string;
  email: string;
  provider: "gmail" | "outlook";
  session_id: string;
  session_created_at: number;
  verifier: string;
  return_to: string;
  expires_at: number;
};
export class NotificationFailure extends Error {
  constructor(readonly reauthorize: boolean) {
    super(
      reauthorize
        ? "Notification connection needs authorization."
        : "Notification service is temporarily unavailable.",
    );
  }
}
const email = z
  .string()
  .email()
  .transform((v) => v.toLowerCase());
const googleScope = "https://www.googleapis.com/auth/gmail.metadata";
const server = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["tls", "starttls"]),
  })
  .strict();
const imapSettings = z
  .object({ username: z.string().min(1).max(320), imap: server, smtp: server })
  .strict();
const microsoftScope = "https://graph.microsoft.com/Mail.ReadBasic";
const microsoftIdentityScope = "https://graph.microsoft.com/User.Read";
const authority = "https://login.microsoftonline.com/common/oauth2/v2.0";
const googleClient = (env: Env) => env.NOTIFICATION_GOOGLE_CLIENT_ID ?? env.GOOGLE_WEB_CLIENT_ID;
const googleSecret = (env: Env) =>
  env.NOTIFICATION_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_WEB_CLIENT_SECRET;
const callback = (env: Env, provider: "gmail" | "outlook") =>
  `${env.BETTER_AUTH_URL}${provider === "gmail" ? "/v1/gmail/callback" : "/v1/notifications/callback"}`;
const key = (env: Env) => {
  const secret =
    env.NOTIFICATION_CREDENTIAL_SECRET ??
    (env.DEV_DEMO === "true" ? env.BETTER_AUTH_SECRET : undefined);
  if (!secret)
    throw new HTTPException(503, { message: "Background notifications are not configured." });
  return derivedKey(secret, "otter-mail notification credentials v1");
};
const stateKey = (env: Env) =>
  derivedKey(env.BETTER_AUTH_SECRET, "otter-mail notification authorization v1");

export function configured(env: Env, provider: MailProviderKind): boolean {
  if (!env.NOTIFICATION_CREDENTIAL_SECRET && env.DEV_DEMO !== "true") return false;
  if (provider === "imap") return true;
  if (provider === "gmail") return Boolean(googleClient(env) && googleSecret(env));
  // Microsoft refresh tokens can acquire other scopes consented to this app. Use a separate app registration.
  return Boolean(
    env.NOTIFICATION_MICROSOFT_CLIENT_ID &&
    env.NOTIFICATION_MICROSOFT_CLIENT_SECRET &&
    env.NOTIFICATION_MICROSOFT_CLIENT_ID !== env.MICROSOFT_CLIENT_ID,
  );
}

export async function isAuthorizationState(env: Env, state: string): Promise<boolean> {
  try {
    await jwtVerify(state, await stateKey(env), {
      audience: "notification-authorization",
      algorithms: ["HS256"],
    });
    return true;
  } catch {
    return false;
  }
}

export async function connection(
  env: Env,
  userId: string,
  address: string,
): Promise<Connection | null> {
  return env.DB.prepare(
    "SELECT n.* FROM notification_connections n JOIN linked_accounts a ON a.user_id=n.user_id AND a.email=n.email AND a.provider=n.provider WHERE n.user_id=? AND n.email=?",
  )
    .bind(userId, address)
    .first<Connection>();
}
export async function credential(env: Env, row: Connection): Promise<Credential> {
  const decoded = await jwtDecrypt<Credential & { email: string }>(row.credential, await key(env), {
    subject: row.user_id,
    audience: "notification-credentials",
  });
  if (decoded.payload.email !== row.email || decoded.payload.provider !== row.provider)
    throw new NotificationFailure(true);
  return decoded.payload;
}
export async function seal(
  env: Env,
  userId: string,
  address: string,
  value: Credential,
): Promise<string> {
  return new EncryptJWT({ ...value, email: address })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(userId)
    .setAudience("notification-credentials")
    .setIssuedAt()
    .encrypt(await key(env));
}
export async function save(
  env: Env,
  userId: string,
  address: string,
  value: Credential,
  session?: { id: string; createdAt: number },
): Promise<void> {
  const generation = crypto.randomUUID();
  const result =
    await env.DB.prepare(`INSERT INTO notification_connections (user_id,email,provider,generation,credential,status,updated_at)
    SELECT user_id,email,provider,?,?,'connecting',? FROM linked_accounts WHERE user_id=? AND email=? AND provider=?
    AND NOT EXISTS (SELECT 1 FROM push_revocations WHERE user_id=? AND (session_id=? OR (session_id='' AND revoked_at>=?)))
    ON CONFLICT(user_id,email) DO UPDATE SET generation=excluded.generation,credential=excluded.credential,status='connecting',updated_at=excluded.updated_at`)
      .bind(
        generation,
        await seal(env, userId, address, value),
        Date.now(),
        userId,
        address,
        value.provider,
        userId,
        session?.id ?? "",
        session?.createdAt ?? Date.now(),
      )
      .run();
  if (!result.meta.changes)
    throw new HTTPException(401, { message: "Mailbox access ended. Sign in again." });
  if (!(await connection(env, userId, address)))
    throw new HTTPException(404, { message: "Mailbox was removed." });
  await watcher(env, userId, address).start(userId, address);
}
export function watcher(env: Env, userId: string, address: string) {
  return env.NOTIFICATION_MAILBOX.get(
    env.NOTIFICATION_MAILBOX.idFromName(JSON.stringify([userId, address])),
  );
}
export async function remove(env: Env, userId: string, address: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notification_connections WHERE user_id=? AND email=?").bind(
      userId,
      address,
    ),
    env.DB.prepare("DELETE FROM notification_authorizations WHERE user_id=? AND email=?").bind(
      userId,
      address,
    ),
  ]);
  await watcher(env, userId, address).stop();
  await env.USER_HUB.get(env.USER_HUB.idFromName(userId)).forgetPush(address);
}

/** Enforce actual token scopes, including refresh responses; don't trust the requested scope or client name. */
export function validateScopes(provider: "gmail" | "outlook", scope: unknown): void {
  if (typeof scope !== "string") throw new NotificationFailure(true);
  const granted = new Set(
    scope
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.toLowerCase().replace("https://graph.microsoft.com/", "")),
  );
  const required = provider === "gmail" ? googleScope : "mail.readbasic";
  const allowedScopes =
    provider === "gmail"
      ? new Set([
          googleScope,
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/userinfo.email",
          "https://www.googleapis.com/auth/userinfo.profile",
        ])
      : new Set(["mail.readbasic", "user.read", "openid", "email", "profile", "offline_access"]);
  if (!granted.has(required) || [...granted].some((s) => !allowedScopes.has(s)))
    throw new NotificationFailure(true);
}
type Tokens = { access_token: string; refresh_token?: string; scope?: string };
export async function tokenRequest(
  env: Env,
  provider: "gmail" | "outlook",
  params: Record<string, string>,
): Promise<Tokens> {
  const clientId = provider === "gmail" ? googleClient(env) : env.NOTIFICATION_MICROSOFT_CLIENT_ID;
  const secret =
    provider === "gmail" ? googleSecret(env) : env.NOTIFICATION_MICROSOFT_CLIENT_SECRET;
  const url =
    provider === "gmail"
      ? (env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token")
      : (env.MICROSOFT_TOKEN_URL ?? `${authority}/token`);
  const response = await fetch(url, {
    redirect: "manual",
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: secret!,
      ...(provider === "outlook"
        ? { scope: `${microsoftIdentityScope} ${microsoftScope} offline_access` }
        : {}),
      ...params,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await response.json()) as Tokens & { error?: string };
  if (!response.ok || !body.access_token)
    throw new NotificationFailure(
      body.error === "invalid_grant" ||
        body.error === "interaction_required" ||
        response.status === 401,
    );
  validateScopes(provider, body.scope);
  return body;
}
export async function accessToken(env: Env, row: Connection): Promise<string> {
  const saved = await credential(env, row);
  if (saved.provider === "imap") throw new NotificationFailure(true);
  const expected =
    saved.provider === "gmail" ? googleClient(env) : env.NOTIFICATION_MICROSOFT_CLIENT_ID;
  if (!configured(env, saved.provider) || saved.clientId !== expected)
    throw new NotificationFailure(true);
  const token = await tokenRequest(env, saved.provider, {
    grant_type: "refresh_token",
    refresh_token: saved.refreshToken,
  });
  if (token.refresh_token && token.refresh_token !== saved.refreshToken) {
    await env.DB.prepare(
      "UPDATE notification_connections SET credential=? WHERE user_id=? AND email=? AND generation=? AND credential=?",
    )
      .bind(
        await seal(env, row.user_id, row.email, { ...saved, refreshToken: token.refresh_token }),
        row.user_id,
        row.email,
        row.generation,
        row.credential,
      )
      .run();
    // A concurrent refresh may already have saved a newer rotation. Never overwrite it.
  }
  const current = await connection(env, row.user_id, row.email);
  if (current?.generation !== row.generation) throw new NotificationFailure(true);
  return token.access_token;
}

/** Callback has no browser-cookie dependency: a single-use request carries the initiating session's authority. */
export async function complete(env: Env, state: string, code?: string): Promise<Authorization> {
  const verified = await jwtVerify(state, await stateKey(env), {
    audience: "notification-authorization",
    algorithms: ["HS256"],
  });
  const id = verified.payload.jti;
  if (!id) throw new HTTPException(400);
  const request = await env.DB.prepare(
    "DELETE FROM notification_authorizations WHERE id=? AND expires_at>? RETURNING *",
  )
    .bind(id, Date.now())
    .first<Authorization>();
  if (!request || request.user_id !== verified.payload.sub)
    throw new HTTPException(400, { message: "Authorization expired. Start again in Otter Mail." });
  if (!code) return request;
  const revoked = await env.DB.prepare(
    "SELECT 1 FROM push_revocations WHERE user_id=? AND (session_id=? OR (session_id='' AND revoked_at>=?))",
  )
    .bind(request.user_id, request.session_id, request.session_created_at)
    .first();
  if (revoked) throw new HTTPException(401);
  const tokens = await tokenRequest(env, request.provider, {
    grant_type: "authorization_code",
    code,
    code_verifier: request.verifier,
    redirect_uri: callback(env, request.provider),
  });
  const url =
    request.provider === "gmail"
      ? `${env.NOTIFICATION_GOOGLE_API_ORIGIN ?? "https://gmail.googleapis.com"}/gmail/v1/users/me/profile?fields=emailAddress`
      : `${env.MICROSOFT_GRAPH_URL ?? "https://graph.microsoft.com"}/v1.0/me?$select=mail,userPrincipalName`;
  const profile = await fetch(url, {
    redirect: "manual",
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!profile.ok || !tokens.refresh_token) throw new NotificationFailure(true);
  const body = (await profile.json()) as {
    emailAddress?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const address =
    request.provider === "gmail" ? body.emailAddress : (body.mail ?? body.userPrincipalName);
  if (address?.toLowerCase() !== request.email)
    throw new HTTPException(403, { message: "Authorize the mailbox selected in Otter Mail." });
  // Recheck after the network requests: removal or session revocation must win an in-flight exchange.
  if (
    await env.DB.prepare(
      "SELECT 1 FROM push_revocations WHERE user_id=? AND (session_id=? OR (session_id='' AND revoked_at>=?))",
    )
      .bind(request.user_id, request.session_id, request.session_created_at)
      .first()
  )
    throw new HTTPException(401);
  await save(
    env,
    request.user_id,
    request.email,
    {
      provider: request.provider,
      clientId: (request.provider === "gmail"
        ? googleClient(env)
        : env.NOTIFICATION_MICROSOFT_CLIENT_ID)!,
      refreshToken: tokens.refresh_token,
    },
    { id: request.session_id, createdAt: request.session_created_at },
  );
  return request;
}

export function routes(): Hono<App> {
  const app = new Hono<App>();
  app.use(async (c, next) => {
    if (c.req.header("origin") && c.req.header("origin") !== c.env.APP_ORIGIN)
      throw new HTTPException(403);
    await next();
  });
  app.get("/notification-connections", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT email,provider,status,updated_at AS updatedAt FROM notification_connections WHERE user_id=?",
    )
      .bind(c.var.session.user.id)
      .all<NotificationConnection>();
    return c.json({
      connections: results,
      providers: {
        gmail: configured(c.env, "gmail"),
        outlook: configured(c.env, "outlook"),
        imap: configured(c.env, "imap"),
      },
    });
  });
  app.post(
    "/notification-connections/authorize",
    zValidator(
      "json",
      z.object({ email, returnTo: z.enum(["web", "desktop", "native"]) }).strict(),
    ),
    async (c) => {
      const { email: address, returnTo } = c.req.valid("json");
      const { session } = c.var;
      const linked = await c.env.DB.prepare(
        "SELECT provider FROM linked_accounts WHERE user_id=? AND email=?",
      )
        .bind(session.user.id, address)
        .first<{ provider: MailProviderKind }>();
      if (!linked || linked.provider === "imap") throw new HTTPException(403);
      if (!configured(c.env, linked.provider))
        throw new HTTPException(503, {
          message: "Background notifications are not configured for this provider.",
        });
      const id = crypto.randomUUID();
      const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64url.encode(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
      );
      await c.env.DB.batch([
        c.env.DB.prepare(
          "DELETE FROM notification_authorizations WHERE expires_at<? OR (user_id=? AND email=?)",
        ).bind(Date.now(), session.user.id, address),
        c.env.DB.prepare(
          "INSERT INTO notification_authorizations (id,user_id,email,provider,session_id,session_created_at,verifier,return_to,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ).bind(
          id,
          session.user.id,
          address,
          linked.provider,
          session.id,
          session.createdAt,
          verifier,
          returnTo,
          Math.min(Date.now() + 600_000, session.expiresAt),
        ),
      ]);
      const state = await new SignJWT({ returnTo })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(session.user.id)
        .setJti(id)
        .setAudience("notification-authorization")
        .setExpirationTime("10m")
        .sign(await stateKey(c.env));
      const google = linked.provider === "gmail";
      const url = new URL(
        google ? "https://accounts.google.com/o/oauth2/v2/auth" : `${authority}/authorize`,
      );
      url.search = new URLSearchParams({
        client_id: (google ? googleClient(c.env) : c.env.NOTIFICATION_MICROSOFT_CLIENT_ID)!,
        redirect_uri: callback(c.env, linked.provider),
        response_type: "code",
        scope: google
          ? `openid email ${googleScope}`
          : `openid email profile offline_access ${microsoftIdentityScope} ${microsoftScope}`,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        login_hint: address,
        ...(google
          ? { access_type: "offline", include_granted_scopes: "false", prompt: "consent" }
          : { prompt: "consent" }),
      }).toString();
      return c.json({ url: url.toString() });
    },
  );
  app.put(
    "/notification-connections/imap",
    zValidator(
      "json",
      z.object({ email, password: z.string().min(1).max(4096), settings: imapSettings }).strict(),
    ),
    async (c) => {
      const { email: address, password, settings } = c.req.valid("json");
      const linked = await c.env.DB.prepare(
        "SELECT imap FROM linked_accounts WHERE user_id=? AND email=? AND provider='imap'",
      )
        .bind(c.var.session.user.id, address)
        .first<{ imap: string }>();
      if (!linked) throw new HTTPException(403);
      const stored = JSON.parse(linked.imap) as ImapSettings;
      const supplied = settings as ImapSettings;
      if (!sameSettings(stored, supplied))
        throw new HTTPException(409, {
          message: "Mailbox settings changed. Reconnect the mailbox first.",
        });
      if (
        !allowed(stored.imap.host, stored.imap.port, c.env.NOTIFICATION_IMAP_TEST_TARGET) ||
        (stored.imap.security !== "tls" && stored.imap.security !== "starttls")
      )
        throw new HTTPException(400, {
          message: "Background notifications require a public IMAP server with TLS.",
        });
      await save(
        c.env,
        c.var.session.user.id,
        address,
        { provider: "imap", settings: stored, password },
        c.var.session,
      );
      return c.body(null, 204);
    },
  );
  app.delete(
    "/notification-connections/:email",
    zValidator("param", z.object({ email })),
    async (c) => {
      await remove(c.env, c.var.session.user.id, c.req.valid("param").email);
      return c.body(null, 204);
    },
  );
  return app;
}

export function sameSettings(a: ImapSettings, b: ImapSettings | undefined): boolean {
  return Boolean(
    b &&
    a.username === b.username &&
    ["imap", "smtp"].every((key) => {
      const left = a[key as "imap" | "smtp"],
        right = b[key as "imap" | "smtp"];
      return (
        right &&
        left.host.toLowerCase() === right.host.toLowerCase() &&
        left.port === right.port &&
        left.security === right.security
      );
    }),
  );
}

export async function callbackResponse(env: Env, state: string, code?: string): Promise<Response> {
  const verified = await jwtVerify(state, await stateKey(env), {
    audience: "notification-authorization",
    algorithms: ["HS256"],
  }).catch(() => null);
  if (!verified)
    return new Response("Notification setup expired. Start again in Otter Mail.", { status: 400 });
  let success = false;
  try {
    await complete(env, state, code);
    success = Boolean(code);
  } catch {
    /* Show a safe error, never token/provider response text. */
  }
  const returnTo = verified.payload.returnTo;
  const nonce = crypto.randomUUID();
  const status = success ? "success" : "error";
  const message = success
    ? "Background notifications connected. You can return to Otter Mail."
    : "Background notifications were not connected. Return to Otter Mail and try again.";
  const script =
    returnTo === "native"
      ? `location.href='ottermail-notifications://complete?result=${status}'`
      : `if(window.opener){window.opener.postMessage({type:'otter:notification-connected',result:'${status}'},${JSON.stringify(env.APP_ORIGIN)});window.close()}`;
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Otter Mail notifications</title></head><body><p>${message}</p><script nonce="${nonce}">${script}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}
