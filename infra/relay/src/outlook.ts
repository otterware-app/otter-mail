/**
 * Outlook for the web app, like Gmail's (gmail.ts): a browser can't keep a
 * Microsoft refresh token for long, so the relay does the OAuth exchange with
 * its confidential client and seals the refresh token for the signed-in Otter
 * user. The browser keeps the sealed token; the relay stores nothing. The
 * desktop app signs in to Outlook itself and never comes here.
 *
 *   GET  /v1/outlook/authorize  (popup) → Microsoft's consent
 *   GET  /v1/outlook/callback   → posts the sealed token and a first access token to the page
 *   POST /v1/outlook/token      `{ sealed }` → a fresh access token and a resealed refresh token
 *   POST /v1/dev/outlook        `pnpm dev:demo` only: a saved sign-in, sealed as the popup would
 *
 * And Graph's change notifications for every Outlook mailbox:
 *
 *   POST /v1/outlook/watch      `{ email }` → where a device's Graph subscription should notify
 *   POST /push/outlook/:email   Graph's notifications, checked against `clientState`
 */

import type { OutlookSignInResult, OutlookTokenResponse } from "@otter-mail/contracts/relay";
import { MICROSOFT_AUTHORITY, OUTLOOK_SCOPES } from "@otter-mail/contracts";
import { base64url, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from "jose";

import { popupPage } from "./gmail.ts";
import { derivedKey } from "./keys.ts";
import type { Env } from "./worker.ts";

const tokenUrl = (env: Env) => env.MICROSOFT_TOKEN_URL || `${MICROSOFT_AUTHORITY}/token`;
const meUrl = (env: Env) =>
  `${env.MICROSOFT_GRAPH_URL || "https://graph.microsoft.com"}/v1.0/me?$select=mail,userPrincipalName,displayName`;

export const callbackUrl = (env: Env) => `${env.BETTER_AUTH_URL}/v1/outlook/callback`;

/** The relay has a Microsoft OAuth client to sign the web app in with. */
export const configured = (env: Env) =>
  Boolean(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);

/** One key signs sign-in states, one seals refresh tokens, one signs push subscriptions. */
const key = (env: Env, purpose: "state" | "seal" | "push") =>
  derivedKey(env.BETTER_AUTH_SECRET, `otter-mail outlook ${purpose}`);

/** Microsoft's consent screen for the relay's client, for the signed-in user. */
export async function authorizeUrl(env: Env, userId: string, loginHint?: string): Promise<string> {
  const state = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("10m")
    .sign(await key(env, "state"));
  const url = new URL(`${MICROSOFT_AUTHORITY}/authorize`);
  url.search = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID!,
    redirect_uri: callbackUrl(env),
    response_type: "code",
    response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "),
    prompt: "select_account",
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return url.toString();
}

/** The Otter user a sign-in state was issued to; throws if forged or stale. */
export async function stateUser(env: Env, state: string): Promise<string> {
  const { payload } = await jwtVerify(state, await key(env, "state"), { algorithms: ["HS256"] });
  return payload.sub!;
}

type MicrosoftTokens = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
};

async function tokenRequest(env: Env, params: Record<string, string>): Promise<MicrosoftTokens> {
  if (!configured(env)) throw new MicrosoftTokenError("missing_client_secret");
  const response = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MICROSOFT_CLIENT_ID!,
      client_secret: env.MICROSOFT_CLIENT_SECRET!,
      scope: OUTLOOK_SCOPES.join(" "),
      ...params,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as MicrosoftTokens;
  if (!response.ok || body.error)
    throw new MicrosoftTokenError(body.error ?? `HTTP ${response.status}`);
  return body;
}

export class MicrosoftTokenError extends Error {
  /** The user (or their admin) took the sign-in back, or it needs consent again. */
  get revoked() {
    return this.message === "invalid_grant" || this.message === "interaction_required";
  }
}

async function seal(env: Env, userId: string, email: string, refreshToken: string) {
  return new EncryptJWT({ email, refreshToken })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(userId)
    .setIssuedAt()
    .encrypt(await key(env, "seal"));
}

/** Exchanges the code, asks Graph which mailbox signed in, then seals the refresh token for this user. */
export async function completeSignIn(
  env: Env,
  userId: string,
  code: string,
): Promise<OutlookSignInResult> {
  const tokens = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(env),
  });
  return sealSignIn(env, userId, tokens);
}

/**
 * The demo (`pnpm dev:demo`, DEV_DEMO): its mailbox's saved sign-in with
 * the web client, sealed for this user as the popup's would be.
 */
export async function demoSignIn(
  env: Env,
  userId: string,
  refreshToken: string,
): Promise<OutlookSignInResult> {
  const tokens = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return sealSignIn(env, userId, {
    ...tokens,
    refresh_token: tokens.refresh_token ?? refreshToken,
  });
}

/** Who signed in (Graph's /me), and the refresh token sealed for this user. */
async function sealSignIn(
  env: Env,
  userId: string,
  tokens: { access_token: string; expires_in: number; refresh_token?: string },
): Promise<OutlookSignInResult> {
  if (!tokens.refresh_token) {
    throw new MicrosoftTokenError("Microsoft did not return a refresh token.");
  }
  const response = await fetch(meUrl(env), {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!response.ok) throw new Error(`Microsoft Graph answered HTTP ${response.status}`);
  const me = (await response.json()) as {
    mail?: string | null;
    userPrincipalName?: string | null;
    displayName?: string | null;
  };
  // As core's signInFromMe: the mailbox's address, else the sign-in name.
  const email = (me.mail || me.userPrincipalName || "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Microsoft didn't say which mailbox signed in.");
  return {
    email,
    name: me.displayName?.trim() || email,
    sealed: await seal(env, userId, email, tokens.refresh_token),
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
  };
}

/**
 * A fresh access token (and ID token) from a sealed refresh token, for its
 * owner only. Microsoft rotates refresh tokens: the answer carries the new
 * one, sealed, for the page to keep.
 */
export async function refresh(
  env: Env,
  userId: string,
  sealed: string,
): Promise<OutlookTokenResponse> {
  const { payload } = await jwtDecrypt<{ email: string; refreshToken: string }>(
    sealed,
    await key(env, "seal"),
    { subject: userId },
  );
  const tokens = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: payload.refreshToken,
  });
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    idToken: tokens.id_token ?? null,
    sealed: tokens.refresh_token
      ? await seal(env, userId, payload.email, tokens.refresh_token)
      : sealed,
  };
}

/** The popup's last page: hands the result (or error) to the app and closes. */
export function popupResponse(env: Env, message: { result?: OutlookSignInResult; error?: string }) {
  return popupPage(env, "outlook", message);
}

/** Where Graph should notify about the mailbox's changes. */
export const notificationUrl = (env: Env, email: string) =>
  `${env.BETTER_AUTH_URL}/push/outlook/${encodeURIComponent(email)}`;

const pushKey = async (env: Env) =>
  crypto.subtle.importKey("raw", await key(env, "push"), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

/**
 * The secret a mailbox's subscriptions hand Graph, which Graph sends back
 * with each notification: an HMAC of the address (43 characters; Graph
 * allows 128), so only Graph, told by a device that linked the mailbox, can
 * send one.
 */
export async function clientState(env: Env, email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase());
  return base64url.encode(
    new Uint8Array(await crypto.subtle.sign("HMAC", await pushKey(env), data)),
  );
}

/** Whether `state` is the mailbox's clientState (compared in constant time). */
export async function checkClientState(env: Env, email: string, state: string): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = base64url.decode(state);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(email.toLowerCase());
  return crypto.subtle.verify("HMAC", await pushKey(env), signature, data);
}
