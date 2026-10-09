/**
 * Outlook sign-in in the browser, like Gmail's (google.ts): the page opens
 * the relay's sign-in popup (Microsoft's consent for the relay's client); the
 * relay exchanges the code, seals the refresh token (only it can use it), and
 * hands the page the sealed token and a first access token. Access tokens
 * then come from the relay's `/v1/outlook/token`. Microsoft rotates refresh
 * tokens, so each refresh answers a new sealed one to keep.
 */

import type {
  MeResponse,
  OutlookSignInResult,
  OutlookTokenResponse,
} from "@otter-mail/contracts/relay";
import {
  broadcast,
  OUTLOOK_SIGNED_OUT_MESSAGE,
  SignInCancelledError,
  type MicrosoftAuth,
  type Platform,
} from "@otter-mail/core";

import type { Page } from "./platform";
import { SIGN_IN_CANCELLED } from "./protocol";

type Stored = { sealed: string; accessToken: string; expiresAt: number };

const FILE = "microsoft-tokens.json";
/** Refresh a little before Microsoft expires the token, never mid-request. */
const REFRESH_AHEAD_MS = 2 * 60_000;

export function webMicrosoftAuth(deps: {
  relayUrl: string;
  page: Page;
  files: Platform["files"];
}): MicrosoftAuth {
  const { relayUrl, page, files } = deps;
  let tokens = new Map<string, Stored>();
  const refreshes = new Map<string, Promise<OutlookTokenResponse>>();
  let available: Promise<boolean> | null = null;

  async function save(): Promise<void> {
    await files.write(FILE, JSON.stringify(Object.fromEntries(tokens)));
  }

  /** New tokens from the relay; drops the mailbox's sign-in if Microsoft revoked it. */
  /** A sign-in from the relay: its tokens, kept under the address. */
  async function keep(result: OutlookSignInResult) {
    tokens.set(result.email, {
      sealed: result.sealed,
      accessToken: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
    });
    await save();
    return { email: result.email, name: result.name };
  }

  function refresh(accountId: string): Promise<OutlookTokenResponse> {
    let pending = refreshes.get(accountId);
    if (pending) return pending;
    pending = (async () => {
      const stored = tokens.get(accountId);
      if (!stored) throw new Error(OUTLOOK_SIGNED_OUT_MESSAGE);
      const response = await fetch(`${relayUrl}/v1/outlook/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sealed: stored.sealed }),
      });
      if (response.status === 410) {
        tokens.delete(accountId);
        await save();
        broadcast("gmail:accounts-changed");
        throw new Error(OUTLOOK_SIGNED_OUT_MESSAGE);
      }
      if (!response.ok)
        throw new Error(`Couldn't refresh the Microsoft sign-in (${response.status}).`);
      const body = (await response.json()) as OutlookTokenResponse;
      if (tokens.has(accountId)) {
        tokens.set(accountId, {
          sealed: body.sealed,
          accessToken: body.accessToken,
          expiresAt: Date.now() + body.expiresIn * 1000,
        });
        await save();
      }
      return body;
    })().finally(() => refreshes.delete(accountId));
    refreshes.set(accountId, pending);
    return pending;
  }

  return {
    // Whether the relay has a Microsoft client; asked once, again after a failure.
    available() {
      available ??= fetch(`${relayUrl}/v1/me`, { credentials: "include" })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return ((await response.json()) as MeResponse).outlook === true;
        })
        .catch(() => {
          available = null;
          return false;
        });
      return available;
    },

    async load() {
      const bytes = await files.read(FILE);
      if (bytes) tokens = new Map(Object.entries(JSON.parse(new TextDecoder().decode(bytes))));
    },

    async addAccount(loginHint) {
      const result = await page.request("outlookSignIn", { loginHint }).catch((err: unknown) => {
        throw err instanceof Error && err.message === SIGN_IN_CANCELLED
          ? new SignInCancelledError()
          : err;
      });
      return keep(result);
    },

    // `pnpm dev:demo`: the local relay seals the mailbox's saved sign-in, as the popup would.
    async addDemoAccount(mailbox) {
      const refreshToken = mailbox.refreshTokens.web;
      if (!refreshToken) {
        throw new Error(`${mailbox.email} has no web sign-in yet: run \`pnpm dev:demo --login\`.`);
      }
      const response = await fetch(`${relayUrl}/v1/dev/outlook`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) throw new Error(`The relay couldn't sign it in (${response.status}).`);
      return keep((await response.json()) as OutlookSignInResult);
    },

    // The page owns the popup: cancelling closes it, which rejects addAccount.
    cancelSignIn() {},

    isSignedIn: (accountId) => tokens.has(accountId),

    async getAccessToken(accountId, opts) {
      const stored = tokens.get(accountId);
      if (!stored) throw new Error(OUTLOOK_SIGNED_OUT_MESSAGE);
      if (!opts?.forceRefresh && stored.expiresAt - REFRESH_AHEAD_MS > Date.now()) {
        return stored.accessToken;
      }
      return (await refresh(accountId)).accessToken;
    },

    async getIdToken(accountId) {
      const { idToken } = await refresh(accountId);
      if (!idToken)
        throw new Error("Microsoft did not return an ID token. Sign in to this mailbox again.");
      return idToken;
    },

    async removeTokens(accountId) {
      if (tokens.delete(accountId)) await save();
    },
  };
}
