/**
 * Messages between the page (bridge.ts) and the mail backend's Web Worker
 * (worker.ts). The page invokes the backend's handlers and receives its
 * pushes, like the desktop's IPC; the backend asks the page for what only a
 * page can do (file pickers, Google and Microsoft sign-in popups, downloads, notifications).
 */

import type { OutlookSignInResult } from "@otter-mail/contracts/relay";
import type { LanguageDetection, PickedFile, TranslationResult } from "@otter-mail/core";

/** The Gmail sign-in the relay's popup hands back (see infra/relay, /v1/gmail/callback). */
export type GoogleSignInResult = {
  email: string;
  name: string;
  picture: string | null;
  /** The refresh token, sealed by the relay: only it can use it. */
  sealed: string;
  accessToken: string;
  expiresIn: number;
  clientId?: string;
};

/** The page's answer to `googleSignIn` and `outlookSignIn` when the user closes the popup or declines. */
export { GMAIL_SIGN_IN_CANCELLED as SIGN_IN_CANCELLED } from "@otter-mail/contracts/relay";

/** What the backend asks of the page, and what the page answers. */
export type PageRequests = {
  todoistSignIn: { params: { url?: string; close?: boolean }; result: string };
  pickFiles: { params: undefined; result: PickedFile[] };
  googleSignIn: { params: { loginHint?: string }; result: GoogleSignInResult };
  outlookSignIn: { params: { loginHint?: string }; result: OutlookSignInResult };
  detectLanguage: { params: { text: string }; result: LanguageDetection };
  translate: {
    params: { texts: string[]; source: string; target: string };
    result: TranslationResult;
  };
};

export type PageEffect =
  | {
      kind: "notify";
      title: string;
      subtitle?: string;
      body?: string;
      open?: { accountId: string; messageId: string };
    }
  | { kind: "badge"; count: number }
  | { kind: "download"; name: string; bytes: Uint8Array }
  | { kind: "open"; name: string; bytes: Uint8Array };

export type ToWorker =
  | { type: "invoke"; id: number; channel: string; params: unknown }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  /** The tab came back (visible again, or back online): reconnect and catch up. */
  | { type: "resume" };

export type FromWorker =
  | { type: "ready" }
  | { type: "failed"; error: string }
  | { type: "result"; id: number; result?: unknown; error?: string }
  | { type: "event"; channel: string; params: unknown }
  | {
      type: "request";
      id: number;
      kind: keyof PageRequests;
      params: PageRequests[keyof PageRequests]["params"];
    }
  | ({ type: "effect" } & PageEffect);
