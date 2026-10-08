/**
 * otter-account.ts
 *
 * The Otter account, signed in to the relay (infra/relay,
 * relay.mail.otterware.app), which keeps the list of linked Gmail accounts
 * and pushes new-mail events. Sign-in, devices and account deletion go
 * through better-auth's client; the relay's own routes through
 * relayRequest. linked-accounts.ts and realtime.ts build on this module.
 *
 * The desktop app holds a bearer token (one session per device, kept in the
 * platform's secrets); the web app is signed in by the browser's session
 * cookie, set when it signs in with Google by redirect.
 */

import { createAuthClient } from "better-auth/client";

import type { OtterDevice } from "@otter-mail/contracts";
import type { MeResponse, RelayUser } from "@otter-mail/contracts/relay";

import { logger } from "../logger.js";
import { platform } from "../platform.js";

const SESSION_SECRET = "otter-session";

let session: { token: string | null; user: RelayUser } | null = null;
const listeners = new Set<() => void>();

/** Runs `listener` whenever the Otter account signs in or out. */
export function onOtterAccountChange(listener: () => void): void {
  listeners.add(listener);
}

const usesCookie = () => platform().relaySession === "cookie";

async function setSession(next: typeof session): Promise<void> {
  session = next;
  if (!usesCookie()) {
    if (next) await platform().secrets.set(SESSION_SECRET, JSON.stringify(next));
    else await platform().secrets.delete(SESSION_SECRET);
  }
  for (const listener of listeners) listener();
}

/** Restores the session; call once at startup. */
export async function loadOtterAccount(): Promise<void> {
  try {
    if (usesCookie()) {
      const { user } = await request<MeResponse>("GET", "/v1/me");
      session = { token: null, user };
    } else {
      const saved = await platform().secrets.get(SESSION_SECRET);
      session = saved ? (JSON.parse(saved) as { token: string; user: RelayUser }) : null;
    }
  } catch {
    session = null;
  }
}

/** Who is signed in to Otter Mail, or null. */
export function getOtterUser(): RelayUser | null {
  return session?.user ?? null;
}

/** The bearer token for the event stream (null when a cookie signs the browser in). */
export function getSessionToken(): string | null {
  return session?.token ?? null;
}

/** The relay answered with an error (`status` 0: it couldn't be reached). */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

async function request<T>(
  method: string,
  route: string,
  opts: { body?: unknown; token?: string | null } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${platform().relayUrl}${route}`, {
      method,
      credentials: usesCookie() ? "include" : "omit",
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new RelayError(0, `Can't reach Otter Mail's servers (${String(err)}).`);
  }
  if (!response.ok) {
    const { error } = (await response.json().catch(() => ({}))) as { error?: string };
    throw new RelayError(response.status, error || `The relay answered ${response.status}.`);
  }
  return (response.status === 204 ? null : await response.json()) as T;
}

/**
 * A signed-in call to the relay. A 401 means the session is gone (signed out
 * elsewhere, or revoked): this device signs out too.
 */
export async function relayRequest<T = null>(
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const current = session;
  if (!current) throw new RelayError(401, "Not signed in to Otter Mail.");
  try {
    return await request<T>(method, route, { body, token: current.token });
  } catch (err) {
    if (err instanceof RelayError && err.status === 401 && session === current) {
      logger.warn("otter-account", "The relay ended this session; signing out");
      await setSession(null);
    }
    throw err;
  }
}

// ── better-auth ─────────────────────────────────────────────────────────────

let authClient: ReturnType<typeof createClient> | null = null;

function createClient() {
  const { relayUrl, deviceName, appVersion } = platform();
  return createAuthClient({
    baseURL: relayUrl,
    basePath: "/v1/auth",
    fetchOptions: {
      credentials: usesCookie() ? "include" : "omit",
      auth: { type: "Bearer", token: () => session?.token ?? undefined },
      // How this device appears in the account's device list (browsers send their own).
      // Percent-encoded: headers only take Latin-1, and Macs are named "Laurin’s MacBook Pro".
      ...(deviceName
        ? {
            headers: {
              "User-Agent": `Otter Mail/${appVersion} (${encodeURIComponent(deviceName)})`,
            },
          }
        : {}),
    },
  });
}

const auth = () => (authClient ??= createClient());

/** better-auth answers `{ data, error }`; turn an error into a RelayError. */
async function unwrap<T>(
  call: Promise<
    { data: T; error: null } | { data: null; error: { status: number; message?: string } }
  >,
): Promise<T> {
  const { data, error } = await call;
  if (error) {
    if (error.status === 401 && session) await setSession(null);
    throw new RelayError(error.status, error.message || `The relay answered ${error.status}.`);
  }
  return data;
}

/** Signs in to the relay with a Google ID token (the desktop's "Sign in with Google"). */
export async function signIn(idToken: string): Promise<RelayUser> {
  let token: string | null = null;
  const data = await unwrap(
    auth().signIn.social(
      { provider: "google", idToken: { token: idToken } },
      { onSuccess: (ctx) => void (token = ctx.response.headers.get("set-auth-token")) },
    ),
  );
  // A browser's session is the cookie that came with the response.
  if (!data || !("user" in data) || (!token && !usesCookie())) {
    throw new RelayError(0, "The relay didn't return a session.");
  }
  const { user } = data;
  const relayUser: RelayUser = {
    id: user.id,
    email: user.email,
    name: user.name || null,
    picture: user.image ?? null,
  };
  await setSession({ token, user: relayUser });
  logger.info("otter-account", "Signed in", { user: user.email });
  return relayUser;
}

/** Adopts an Otter Accounts device credential after checking it with Mail's relay. */
export async function signInWithSession(token: string): Promise<RelayUser> {
  const { user } = await request<MeResponse>("GET", "/v1/me", { token });
  await setSession({ token, user });
  return user;
}

/** For a host whose account session owns sign-out; mailbox connections stay on this device. */
export async function clearOtterSession(): Promise<void> {
  await setSession(null);
}

/**
 * Where to send the browser to sign in with Google (the web app's sign-in);
 * Google returns it to `callbackURL`, signed in by cookie.
 */
export async function signInRedirect(callbackURL: string): Promise<string> {
  const data = await unwrap(
    auth().signIn.social({ provider: "google", callbackURL, disableRedirect: true }),
  );
  if (!data || !("url" in data) || !data.url) throw new RelayError(0, "No sign-in URL.");
  return data.url;
}

/** Signs out here, and ends the session on the relay when it can be reached. */
export async function signOut(): Promise<void> {
  if (!session) return;
  await auth()
    .signOut()
    .catch((err: unknown) => {
      logger.info("otter-account", `Couldn't end the relay session: ${String(err)}`);
    });
  await setSession(null);
}

/** A device's name from its session's user agent: the Mac's name, or the browser. */
function deviceName(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const mac = /^Otter Mail\/\S+ \((.+)\)$/.exec(ua)?.[1];
  if (mac) {
    try {
      return decodeURIComponent(mac);
    } catch {
      return mac;
    }
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  return browser ? `${browser} (web)` : "Unknown device";
}

/** The devices signed in to this Otter account, this one first. */
export async function listDevices(): Promise<OtterDevice[]> {
  const [sessions, current] = await Promise.all([
    unwrap(auth().listSessions()),
    unwrap(auth().getSession()),
  ]);
  return (sessions ?? [])
    .map((s) => ({
      token: s.token,
      name: deviceName(s.userAgent),
      current: s.id === current?.session.id,
      lastActiveAt: new Date(s.updatedAt).getTime(),
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt - a.lastActiveAt);
}

/** Signs another device out of this Otter account. */
export async function signOutDevice(token: string): Promise<void> {
  await unwrap(auth().revokeSession({ token }));
}

/** Deletes the Otter account and everything the relay keeps for it; signs every device out. */
export async function deleteOtterAccount(): Promise<void> {
  await unwrap(auth().deleteUser({}));
  await setSession(null);
}
