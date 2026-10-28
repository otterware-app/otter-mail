/**
 * Gmail sign-in in the browser. The page opens the relay's sign-in popup
 * (Google's consent for the web OAuth client); the relay exchanges the code,
 * seals the refresh token (only it can use it), and hands the page the sealed
 * token and a first access token. Access tokens then come from the relay's
 * `/v1/gmail/token`, which refreshes with Google. Nothing is stored on the
 * relay.
 */

import {
  accountStore,
  broadcast,
  SIGNED_OUT_MESSAGE,
  SignInCancelledError,
  type MailAccount,
  type GoogleAuth,
  type Platform,
} from "@otter-mail/core";

import type { Page } from "./platform";
import { SIGN_IN_CANCELLED, type GoogleSignInResult } from "./protocol";

type Stored = { sealed: string; accessToken: string; expiresAt: number };

const FILE = "google-tokens.json";
/** Refresh a little before Google expires the token, never mid-request. */
const REFRESH_AHEAD_MS = 2 * 60_000;

export function webGoogleAuth(deps: {
  relayUrl: string;
  page: Page;
  files: Platform["files"];
}): GoogleAuth {
  const { relayUrl, page, files } = deps;
  let tokens = new Map<string, Stored>();
  const refreshes = new Map<string, Promise<{ accessToken: string; idToken: string | null }>>();

  async function save(): Promise<void> {
    await files.write(FILE, JSON.stringify(Object.fromEntries(tokens)));
  }

  /** New tokens from the relay; drops the account's sign-in if Google revoked it. */
  function refresh(accountId: string) {
    let pending = refreshes.get(accountId);
    if (pending) return pending;
    pending = (async () => {
      const stored = tokens.get(accountId);
      if (!stored) throw new Error(SIGNED_OUT_MESSAGE);
      const response = await fetch(`${relayUrl}/v1/gmail/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sealed: stored.sealed }),
      });
      if (response.status === 410) {
        tokens.delete(accountId);
        await save();
        broadcast("gmail:accounts-changed");
        throw new Error(SIGNED_OUT_MESSAGE);
      }
      if (!response.ok)
        throw new Error(`Couldn't refresh the Google sign-in (${response.status}).`);
      const body = (await response.json()) as {
        accessToken: string;
        expiresIn: number;
        idToken: string | null;
      };
      if (tokens.has(accountId)) {
        tokens.set(accountId, {
          ...stored,
          accessToken: body.accessToken,
          expiresAt: Date.now() + body.expiresIn * 1000,
        });
        await save();
      }
      return { accessToken: body.accessToken, idToken: body.idToken };
    })().finally(() => refreshes.delete(accountId));
    refreshes.set(accountId, pending);
    return pending;
  }

  /** A sign-in from the relay: its tokens, then the account, kept under the address. */
  async function keep(result: GoogleSignInResult): Promise<MailAccount> {
    tokens.set(result.email, {
      sealed: result.sealed,
      accessToken: result.accessToken,
      expiresAt: Date.now() + result.expiresIn * 1000,
    });
    await save();
    const existing = await accountStore.getAccount(result.email);
    const account: MailAccount = {
      ...existing,
      id: result.email,
      email: result.email,
      name: result.name,
      picture: result.picture ?? undefined,
    };
    await accountStore.addAccount(account);
    return account;
  }

  return {
    async load() {
      const bytes = await files.read(FILE);
      if (bytes) tokens = new Map(Object.entries(JSON.parse(new TextDecoder().decode(bytes))));
    },

    async addAccount(loginHint) {
      const result = await page.request("googleSignIn", { loginHint }).catch((err: unknown) => {
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
      const response = await fetch(`${relayUrl}/v1/dev/gmail`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) throw new Error(`The relay couldn't sign it in (${response.status}).`);
      return keep((await response.json()) as GoogleSignInResult);
    },

    // The page owns the popup: cancelling closes it, which rejects addAccount.
    cancelSignIn() {},

    isSignedIn: (accountId) => tokens.has(accountId),

    async getAccessToken(accountId, opts) {
      const stored = tokens.get(accountId);
      if (!stored) throw new Error(SIGNED_OUT_MESSAGE);
      if (!opts?.forceRefresh && stored.expiresAt - REFRESH_AHEAD_MS > Date.now()) {
        return stored.accessToken;
      }
      return (await refresh(accountId)).accessToken;
    },

    async getIdToken(accountId) {
      const { idToken } = await refresh(accountId);
      if (!idToken)
        throw new Error("Google did not return an ID token. Sign in to this account again.");
      return idToken;
    },

    async removeTokens(accountId) {
      if (tokens.delete(accountId)) await save();
    },
  };
}
