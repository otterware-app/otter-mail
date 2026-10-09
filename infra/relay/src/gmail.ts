/**
 * Gmail sign-in for the web app. A browser can't keep a Google refresh token
 * on its own (web OAuth clients need a secret), so the relay does the OAuth
 * exchange with the web client and seals the refresh token: the browser
 * keeps the sealed token, only the relay can open it, and the relay stores
 * nothing. The desktop app signs in to Gmail itself and never comes here.
 *
 *   GET  /v1/gmail/authorize  (popup) → Google's consent
 *   GET  /v1/gmail/callback   → posts the sealed token and a first access token to the page
 *   POST /v1/gmail/token      `{ sealed }` → a fresh access token (410 once Google revoked it)
 *   POST /v1/dev/gmail        `pnpm dev:demo` only: a saved sign-in, sealed as the popup would
 */

import { GMAIL_SCOPES } from "@otter-mail/contracts";
import { signInPage } from "@otter-mail/shared/sign-in-page";
import { EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from "jose";

import { googleKeys } from "./auth.ts";
import { derivedKey } from "./keys.ts";
import { verifyGoogleJwt } from "./google-jwt.ts";
import type { Env } from "./worker.ts";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const tokenUrl = (env: Env) => env.GOOGLE_TOKEN_URL || TOKEN_URL;
const clientId = (env: Env) => env.GOOGLE_GMAIL_CLIENT_ID ?? env.GOOGLE_WEB_CLIENT_ID;

export const callbackUrl = (env: Env) => `${env.BETTER_AUTH_URL}/v1/gmail/callback`;

/** One key signs sign-in states, one seals refresh tokens. */
const key = (env: Env, purpose: "state" | "seal") =>
  derivedKey(env.BETTER_AUTH_SECRET, `otter-mail gmail ${purpose}`);

/** Google's consent screen for the web client, for the signed-in user. */
export async function authorizeUrl(env: Env, userId: string, loginHint?: string): Promise<string> {
  const state = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setExpirationTime("10m")
    .sign(await key(env, "state"));
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId(env),
    redirect_uri: callbackUrl(env),
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    // Consent every time, so Google always returns a refresh token.
    prompt: "consent",
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

type GoogleTokens = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  error?: string;
};

async function tokenRequest(
  env: Env,
  params: Record<string, string>,
  issuedTo = clientId(env),
): Promise<GoogleTokens> {
  if (issuedTo !== clientId(env) && issuedTo !== env.GOOGLE_WEB_CLIENT_ID)
    throw new GoogleTokenError("unsupported_client");
  const secret =
    issuedTo === env.GOOGLE_GMAIL_CLIENT_ID
      ? env.GOOGLE_GMAIL_CLIENT_SECRET
      : env.GOOGLE_WEB_CLIENT_SECRET;
  if (!secret) throw new GoogleTokenError("missing_client_secret");
  const response = await fetch(tokenUrl(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: issuedTo,
      client_secret: secret,
      ...params,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as GoogleTokens;
  if (!response.ok || body.error)
    throw new GoogleTokenError(body.error ?? `HTTP ${response.status}`);
  return body;
}

export class GoogleTokenError extends Error {
  get revoked() {
    return this.message === "invalid_grant";
  }
}

/** What the popup hands the page (apps/web/src/web/protocol.ts, GoogleSignInResult). */
export type SignInResult = {
  email: string;
  name: string;
  picture: string | null;
  sealed: string;
  accessToken: string;
  expiresIn: number;
  clientId: string;
};

/** Exchanges the code, then seals the refresh token for this user. */
export async function completeSignIn(
  env: Env,
  userId: string,
  code: string,
): Promise<SignInResult> {
  const tokens = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(env),
  });
  if (!tokens.refresh_token || !tokens.id_token) {
    throw new GoogleTokenError("Google did not return a refresh token.");
  }
  return sealSignIn(env, userId, clientId(env), tokens.refresh_token, tokens);
}

/**
 * The demo (`pnpm dev:demo`, DEV_DEMO): its mailbox's saved sign-in with
 * the web client, sealed for this user as the popup's would be.
 */
export async function demoSignIn(
  env: Env,
  userId: string,
  refreshToken: string,
): Promise<SignInResult> {
  const issuedTo = env.GOOGLE_WEB_CLIENT_ID;
  const tokens = await tokenRequest(
    env,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    issuedTo,
  );
  if (!tokens.id_token) throw new GoogleTokenError("Google did not return an ID token.");
  return sealSignIn(env, userId, issuedTo, refreshToken, tokens);
}

/** Seals the refresh token for this user: what the page keeps, with a first access token. */
async function sealSignIn(
  env: Env,
  userId: string,
  issuedTo: string,
  refreshToken: string,
  tokens: GoogleTokens,
): Promise<SignInResult> {
  const claims = await verifyGoogleJwt(tokens.id_token!, issuedTo, googleKeys(env));
  const sealed = await new EncryptJWT({ email: claims.email, refreshToken, clientId: issuedTo })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setSubject(userId)
    .setIssuedAt()
    .encrypt(await key(env, "seal"));
  return {
    email: claims.email,
    name: claims.name ?? claims.email,
    picture: claims.picture ?? null,
    sealed,
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    clientId: issuedTo,
  };
}

/** A fresh access token (and ID token) from a sealed refresh token, for its owner only. */
export async function refresh(env: Env, userId: string, sealed: string) {
  const { payload } = await jwtDecrypt<{ refreshToken: string; clientId?: string }>(
    sealed,
    await key(env, "seal"),
    {
      subject: userId,
    },
  );
  // Tokens sealed before the migration belong to the original Mail web client.
  const issuedTo = payload.clientId ?? env.GOOGLE_WEB_CLIENT_ID;
  const tokens = await tokenRequest(
    env,
    { grant_type: "refresh_token", refresh_token: payload.refreshToken },
    issuedTo,
  );
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    idToken: tokens.id_token ?? null,
    clientId: issuedTo,
  };
}

/** The popup's last page: hands the result (or error) to the app and closes. */
export function popupResponse(env: Env, message: { result?: SignInResult; error?: string }) {
  return popupPage(env, "gmail", message);
}

/**
 * The sign-in popup's last page, for Gmail or Outlook (outlook.ts): posts
 * `{ type: "otter:<provider>-sign-in", … }` to the app and closes.
 */
export function popupPage(
  env: Env,
  provider: "gmail" | "outlook",
  message: { result?: unknown; error?: string },
) {
  const payload = JSON.stringify({ type: `otter:${provider}-sign-in`, ...message }).replace(
    /</g,
    "\\u003c",
  );
  const html = signInPage({
    title: message.error ? "Sign-in didn't work" : "Signed in",
    detail: "You can close this window.",
    ok: !message.error,
    script: `
const message = ${payload};
if (window.opener) {
  window.opener.postMessage(message, ${JSON.stringify(env.APP_ORIGIN)});
  window.close();
} else {
  // Signed in in the app's own tab (the browser blocked the popup): take the answer back there.
  location.replace(${JSON.stringify(`${env.APP_ORIGIN}/app`)} + "#${provider}-sign-in=" + encodeURIComponent(JSON.stringify(message)));
}`,
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
