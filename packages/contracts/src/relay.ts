/**
 * The Otter Mail relay's HTTP API (infra/relay), shared by the Worker and the
 * apps. The relay knows who an Otter account is, which mailboxes it has
 * linked (Gmail, IMAP, Outlook), the account's preferences, and when Gmail or
 * Outlook says one of them changed. It never sees mail or keeps Gmail or
 * Microsoft tokens or IMAP passwords.
 *
 * Otter accounts are better-auth's, under `/v1/auth` (the app uses
 * better-auth's client): `sign-in/social` with `{ provider: "google",
 * idToken: { token } }` answers with the session token in the
 * `set-auth-token` header; `sign-out`, `list-sessions`, `revoke-session` and
 * `delete-user` manage devices and the account.
 *
 * The routes below take `Authorization: Bearer <session token>` and answer
 * errors as `{ error: string }`.
 */

/** How someone signs in to their Otter account (Otter Accounts). */
export type SignInMethod = "google" | "microsoft" | "password";

/** The person signed in to Otter Mail. */
export interface RelayUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  /** The account's sign-in methods, where Otter Accounts says (it decides which mailbox to offer first). */
  signInMethods?: SignInMethod[];
}

import type { AgentToken } from "./agent-tokens.js";
import type { ImapSettings, MailProviderKind } from "./mail.js";

/** A mailbox linked to an Otter account, with the profile shown in the app. */
export interface RelayAccount {
  email: string;
  provider: MailProviderKind;
  /** Where an IMAP mailbox lives (null for Gmail and Outlook). Its password stays on each device. */
  imap: ImapSettings | null;
  name: string | null;
  picture: string | null;
  /** User-set overrides, as edited in Settings › Accounts. */
  displayName: string | null;
  color: string | null;
}

/**
 * The web app's Gmail sign-in popup (`/v1/gmail/authorize`) posts
 * `{ type: "otter:gmail-sign-in", result }` or `{ …, error }` to the app;
 * this error means the user said no on Google's consent screen.
 */
export const GMAIL_SIGN_IN_CANCELLED = "sign-in-cancelled";

/** `GET /v1/me` */
export interface MeResponse {
  user: RelayUser;
  /** The Pub/Sub topic to pass to Gmail's `users.watch`. */
  pushTopic: string;
  /** Topics keyed by the Google project number in a mailbox's OAuth client ID. */
  pushTopics?: Record<string, string>;
  /** The relay can sign the web app in to Outlook (it has a Microsoft OAuth client). */
  outlook?: boolean;
}

/**
 * Outlook for the web app, like Gmail's: a browser can't keep a Microsoft
 * refresh token for long (single-page apps' expire in a day), so the relay
 * does the exchange with its confidential client and seals the refresh token
 * for the signed-in Otter user; the browser keeps the sealed token.
 *
 * - `GET /v1/outlook/authorize?login_hint=…` (a popup) → Microsoft's consent.
 * - `GET /v1/outlook/callback` posts `{ type: "otter:outlook-sign-in", result }`
 *   (an `OutlookSignInResult`) or `{ …, error }` to the opener and closes;
 *   `GMAIL_SIGN_IN_CANCELLED` when the user said no.
 * - `POST /v1/outlook/token` with `{ sealed }` → `OutlookTokenResponse`, 410 once
 *   Microsoft revoked the sign-in. Microsoft rotates refresh tokens: keep the
 *   `sealed` it answers in place of the one sent.
 */
export interface OutlookSignInResult {
  /** The mailbox's address, lowercased. */
  email: string;
  name: string;
  /** The refresh token, sealed by the relay: only it can use it, for this Otter user. */
  sealed: string;
  accessToken: string;
  expiresIn: number;
}

export interface OutlookTokenResponse {
  accessToken: string;
  expiresIn: number;
  /** A Microsoft ID token for the mailbox, to link it (`PUT /v1/accounts/:email`). */
  idToken: string | null;
  sealed: string;
}

/**
 * `POST /v1/outlook/watch` with `{ email }`, for a linked Outlook mailbox:
 * where Microsoft Graph should send its change notifications (a
 * subscription's `notificationUrl` and `clientState`). Every device signed in
 * to the mailbox may keep a subscription there; the relay passes each
 * notification on as a `mail` event (`POST /push/outlook/:email`, checked
 * against `clientState`). 404 when the mailbox isn't linked as Outlook.
 */
export interface OutlookWatchResponse {
  notificationUrl: string;
  clientState: string;
}

/** `PUT /v1/push/device`: replaces this authenticated session's iPhone registration.
 * Only already-linked Gmail mailboxes are accepted. No Gmail credentials or mail content.
 * `DELETE /v1/push/device` removes it. A token can belong to only one session per topic/environment.
 */
export interface PutPushDeviceRequest {
  token: string;
  topic: string;
  environment: "sandbox" | "production";
  mode: "off" | "inbox" | "all";
  mailboxes: string[];
}

/** APNs custom payload; the extension adds mail content and thread/message IDs only on-device. */
export interface MailPushMetadata {
  version: 1;
  userId: string;
  email: string;
  historyId: string;
  /** The more restrictive registered/account mode; no mail-dependent filtering on the server. */
  mode: "inbox" | "all";
}

/** A server-confirmed incoming message. No sender, subject, preview or credentials. */
export interface NewMailPushMetadata {
  version: 2;
  userId: string;
  email: string;
  provider: "gmail" | "outlook" | "imap";
  /** Monotonic delivery marker, independent of provider history cursors. */
  historyId: string;
  messageId: string;
  /** IMAP needs the folder and UIDVALIDITY to address a message safely. */
  folder?: string;
  uidValidity?: number;
  mode: "inbox" | "all";
}

export interface NotificationConnection {
  email: string;
  provider: "gmail" | "outlook" | "imap";
  status: "connecting" | "ready" | "reauthorize" | "retry";
  updatedAt: number;
}

export interface AuthorizeNotificationConnectionResponse {
  url: string;
}

/**
 * `GET /v1/accounts?providers=gmail,imap`: the linked mailboxes of the
 * providers named. Without `providers` it lists Gmail accounts only: builds
 * from before IMAP take every row for a Gmail account. Unknown names are
 * ignored. `DELETE /v1/accounts/:email` takes the same parameter, and without
 * it unlinks only a Gmail account (an old build can't unlink an IMAP mailbox
 * it was never shown).
 */
export interface ListAccountsResponse {
  accounts: RelayAccount[];
}

/**
 * `PUT /v1/accounts/:email`: link a mailbox or update its profile.
 * Linking a Gmail account needs `idToken`, a Google ID token for that address
 * proving the caller signed in to it; an Outlook one, `provider: "outlook"`
 * and a Microsoft ID token for that address. Updating an already linked
 * account needs neither. Linking an IMAP mailbox needs `provider: "imap"` and `imap`; the
 * relay can't check the sign-in, which is fine: it sends nothing for IMAP
 * mailboxes but their settings back to the same Otter account (Gmail pushes
 * only go to Gmail links).
 *
 * Updates may leave `provider` out; given, it must be the link's (409
 * otherwise: switching a mailbox between Gmail and IMAP means unlinking it
 * first). An IMAP link's update may replace `imap`; `imap` on a Gmail
 * account is a 400.
 */
export interface PutAccountRequest {
  idToken?: string;
  /** Absent means Gmail. */
  provider?: MailProviderKind;
  imap?: ImapSettings;
  name?: string | null;
  picture?: string | null;
  displayName?: string | null;
  color?: string | null;
}

/**
 * The account's preferences, which follow it to every device: sections of
 * JSON (`settings`, `views`, `keybindings`, `assistant`, `ui`), each replaced
 * whole when a device changes it, plus the Hermes API key, kept encrypted.
 */
export type Preferences = Record<string, unknown>;

/** `GET /v1/preferences` */
export interface PreferencesResponse {
  preferences: Preferences;
  hermesKey: string | null;
}

/**
 * `PUT /v1/preferences`: replaces the sections given (the others stay), and
 * sets or clears the Hermes key when `hermesKey` is present.
 */
export interface PutPreferencesRequest {
  preferences?: Preferences;
  hermesKey?: string | null;
}

/**
 * `GET /v1/tunnel?host=…&port=…`: a TCP connection for the web app, which
 * can't open one itself (the Mac and iPhone apps connect directly). A
 * WebSocket upgrade, with the session like `/v1/events` (the cookie, or the
 * bearer token); from a browser, only the web app's origin may open it.
 *
 * - `port` is 143, 993, 465 or 587; `host` a DNS name or a public IPv4
 *   address (no IPv6 literals, private ranges or localhost). Otherwise 400,
 *   before the upgrade (401 without a session). A DNS name is only checked
 *   by its spelling: that it doesn't resolve to a private address is up to
 *   Cloudflare, whose `connect()` refuses "Cloudflare IPs, `localhost`, and
 *   private network IPs" (Troubleshooting, in
 *   https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/).
 * - Limits, so the tunnel isn't a free proxy. A host and port in one of the
 *   Otter account's IMAP mailboxes (its `imap` or `smtp` server) is linked:
 *   up to 30 tunnels a minute per account, 200 MB each way per tunnel. Any
 *   other allowed host (adding a mailbox checks its password before linking
 *   it) gets 6 tunnels a minute, 1 MB each way: enough to log in, not to sync.
 *   Over the rate, the relay accepts the WebSocket and closes it with
 *   `TUNNEL_CLOSE.rateLimited`; past the bytes, with `TUNNEL_CLOSE.limit`
 *   (open another). Rates are counted per Cloudflare location, loosely.
 * - The relay accepts the WebSocket at once, then connects. When the TCP
 *   connection is up it sends one text frame, `open`; nothing comes before it.
 *   If it can't connect, it closes with `TUNNEL_CLOSE.connectFailed` instead
 *   (the reason says why, e.g. a DNS failure or a refused connection).
 * - After `open`: binary frames only, both ways, each carrying raw bytes of
 *   the TCP stream (no header, no framing; frame boundaries mean nothing).
 *   Send after `open`. A text frame from the client closes the tunnel (1003).
 * - The relay opens the socket without TLS: the client does TLS itself inside
 *   the tunnel (from the first byte on 993/465, after STARTTLS on 143/587), so
 *   the relay carries ciphertext.
 * - Either side closing closes both: the server closing its end is a 1000
 *   close; the client closing the WebSocket closes the TCP connection. A
 *   connection that fails midway closes with `TUNNEL_CLOSE.lost`, one with no
 *   bytes either way for 30 minutes with `TUNNEL_CLOSE.idle` (re-IDLE sooner).
 * - The client may be at most 8 MB ahead of the server (sent, not yet taken
 *   by the TCP connection), else `TUNNEL_CLOSE.backlog`. The server's bytes
 *   come at most 4 MB a second, after a first 8 MB.
 */
export const TUNNEL_CLOSE = {
  /** Couldn't open the TCP connection. */
  connectFailed: 4502,
  /** The TCP connection failed after opening. */
  lost: 4500,
  /** 30 minutes without a byte either way. */
  idle: 4408,
  /** Too many tunnels this minute: nothing was connected. */
  rateLimited: 4429,
  /** The tunnel carried all the bytes it may, one way or the other. */
  limit: 4413,
  /** The client sent more than 8 MB ahead of the server. */
  backlog: 4507,
} as const;

/**
 * Messages on the `GET /v1/events` WebSocket. Clients may send the text
 * `ping`; the relay answers `pong`.
 */
export type RelayEvent =
  /** Gmail or Outlook changed this mailbox: sync it (`historyId` is Gmail's new cursor; "" for Outlook). */
  | { type: "mail"; email: string; historyId: string }
  /** The linked accounts changed (another device linked, unlinked or edited one). */
  | { type: "accounts" }
  /** The preferences changed on another device. */
  | { type: "preferences" }
  /** A project changed (on another device, or by an agent): see projects.ts. */
  | { type: "projects" };

/**
 * Agent tokens (agent-tokens.ts): how an agent that runs elsewhere (Hermes)
 * reaches the account's projects through the relay's MCP server, `POST /mcp`
 * (Streamable HTTP, stateless). A token opens the project tools
 * (project-tools.ts) and nothing else: no mail, no mailboxes, no preferences.
 *
 * - `GET /v1/agent-tokens` → `ListAgentTokensResponse`
 * - `POST /v1/agent-tokens` with `{ name }` → `CreateAgentTokenResponse`: the
 *   token is shown this once; the relay keeps only its hash.
 * - `DELETE /v1/agent-tokens/:id` revokes it.
 */
export interface ListAgentTokensResponse {
  tokens: AgentToken[];
}

export interface CreateAgentTokenResponse {
  token: string;
  agentToken: AgentToken;
}
