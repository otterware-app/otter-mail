/**
 * The seam between the mail backend (this package) and the shell running it:
 * an Electron utility process on the desktop (apps/desktop/src/platform.ts), a
 * Web Worker in the browser (apps/web/src/web/platform.ts). Everything in
 * core that isn't plain TypeScript goes through here; a shell calls
 * `initCore(platform)` once before using anything else.
 */

import type { ChatProvider } from "./services/agent/types.js";
import type { GmailAccount } from "./types.js";
import type { DemoGmailMailbox, DemoOutlookMailbox } from "@otter-mail/contracts/demo";
import type { SupportError } from "@otter-mail/shared/support";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlStatement {
  get(...params: SqlValue[]): Record<string, SqlValue> | undefined;
  all(...params: SqlValue[]): Record<string, SqlValue>[];
  run(...params: SqlValue[]): { changes: number | bigint };
}

/** The subset of `node:sqlite`'s DatabaseSync that the mail cache uses. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

export type FileInfo = { name: string; size: number; modifiedAt: number };

export type PickedFile = { name: string; mimeType: string; bytes: Uint8Array };

/** Gmail sign-in and tokens, per account (keyed by the account's address). */
export interface GoogleAuth {
  /** Reads stored sign-ins; call once at startup so `isSignedIn` answers right away. */
  load(): Promise<void>;
  /** Signs an account in (or back in: `loginHint`); stores it and returns it. */
  addAccount(loginHint?: string): Promise<GmailAccount>;
  /**
   * Development's demo mailbox (`pnpm dev:demo`): signs it in with its saved
   * Google sign-in for this shell's OAuth client, instead of the browser.
   */
  addDemoAccount?(mailbox: DemoGmailMailbox): Promise<GmailAccount>;
  /** Stops waiting for a sign-in in progress; `addAccount` rejects with SignInCancelledError. */
  cancelSignIn(): void;
  isSignedIn(accountId: string): boolean;
  getAccessToken(accountId: string, opts?: { forceRefresh?: boolean }): Promise<string>;
  /** A fresh Google ID token for the account, proving the sign-in to the relay. */
  getIdToken(accountId: string): Promise<string>;
  /** Which OAuth client issued this mailbox's tokens, for its matching Gmail push topic. */
  getClientId?(accountId: string): Promise<string | undefined>;
  /**
   * The desktop's Otter sign-in with another Google account: Google in the
   * browser, identity only. (The web app signs in by redirect instead.)
   */
  signInForIdToken?(): Promise<string>;
  removeTokens(accountId: string): Promise<void>;
}

/** Who signed in to Microsoft: the mailbox's address (lowercased) and name. */
export type MicrosoftSignIn = { email: string; name: string };

/**
 * Outlook sign-in and tokens, per mailbox (keyed by its lowercased address):
 * Microsoft's OAuth with OUTLOOK_SCOPES. The desktop signs in itself
 * (loopback, PKCE); the web app through the relay, which seals the refresh
 * token. Microsoft rotates refresh tokens: each refresh stores the new one.
 */
export interface MicrosoftAuth {
  /** Whether this build can sign in to Microsoft (it has an OAuth client). */
  available(): Promise<boolean>;
  /** Reads stored sign-ins; call once at startup so `isSignedIn` answers right away. */
  load(): Promise<void>;
  /**
   * Signs a mailbox in (or back in: `loginHint`) in the browser, learns its
   * address from Graph's /me and stores its tokens under it.
   */
  addAccount(loginHint?: string): Promise<MicrosoftSignIn>;
  /**
   * Development's demo mailbox (`pnpm dev:demo`): signs it in with its saved
   * Microsoft sign-in for this shell's OAuth client, instead of the browser.
   */
  addDemoAccount?(mailbox: DemoOutlookMailbox): Promise<MicrosoftSignIn>;
  /** Stops waiting for a sign-in in progress; `addAccount` rejects with SignInCancelledError. */
  cancelSignIn(): void;
  isSignedIn(accountId: string): boolean;
  getAccessToken(accountId: string, opts?: { forceRefresh?: boolean }): Promise<string>;
  /** A fresh Microsoft ID token for the mailbox, proving the sign-in to the relay. */
  getIdToken(accountId: string): Promise<string>;
  removeTokens(accountId: string): Promise<void>;
}

/**
 * A TCP connection to a mail server (IMAP, SMTP), TLS already negotiated when
 * asked for. The desktop opens real sockets; the web app tunnels through the
 * relay (a WebSocket to `/v1/tunnel`) and does TLS itself, so the relay only
 * ever carries ciphertext.
 */
export interface ByteStream {
  /** The next bytes from the server; null once the connection has closed. */
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  /** STARTTLS: negotiate TLS over the open connection; everything after it is encrypted. */
  startTls(): Promise<void>;
  close(): void;
}

export type LanguageDetection = { language: string | null; confidence: number };

/**
 * `needsDownload`: the browser must download the language pack, which it
 * only does after a click. `notInstalled`: the Mac's languages must be
 * downloaded in System Settings.
 */
export type TranslationStatus =
  | "ok"
  | "notInstalled"
  | "needsDownload"
  | "unsupported"
  | "unavailable";

export type TranslationResult = { status: TranslationStatus; texts: string[] };

/** On-device translation: Apple Translation on the Mac, Chrome's built-in Translator on the web. */
export interface Translator {
  detect(text: string): Promise<LanguageDetection>;
  translate(texts: string[], source: string, target: string): Promise<TranslationResult>;
}

/** Tells background work (sync, prefetch) apart from the user's own requests. */
export interface AsyncContext<T> {
  run<R>(value: T, fn: () => R): R;
  get(): T | undefined;
}

export interface Platform {
  kind: "desktop" | "web";
  appVersion: string;
  /** Environment and classified errors only; no raw mail or credentials. */
  supportDiagnostics?(): Promise<{ environment: string; errors?: SupportError[] }>;
  log(
    level: "debug" | "info" | "warn" | "error",
    scope: string,
    message: string,
    data?: unknown,
  ): void;

  /** The mail cache: node:sqlite on the desktop, SQLite WASM (OPFS) on the web. */
  database(): SqlDatabase;
  /** The app's own files (settings, accounts, caches), by relative path. */
  files: {
    read(path: string): Promise<Uint8Array | null>;
    write(path: string, data: Uint8Array | string): Promise<void>;
    remove(path: string): Promise<void>;
    list(dir: string): Promise<FileInfo[]>;
  };
  /** Small secrets (session tokens), encrypted at rest where the platform can. */
  secrets: {
    get(name: string): Promise<string | null>;
    set(name: string, value: string): Promise<void>;
    delete(name: string): Promise<void>;
  };
  /** Files the user opens, saves or picks. */
  userFiles: {
    open(name: string, bytes: Uint8Array): Promise<void>;
    /** False when the user cancelled. */
    save(name: string, bytes: Uint8Array): Promise<boolean>;
    pick(): Promise<PickedFile[]>;
  };

  google: GoogleAuth;
  /** Absent where Outlook can't be signed in to. */
  microsoft?: MicrosoftAuth;
  /** Opens browser consent and returns its callback URL; the backend builds the PKCE URL. */
  todoistSignIn?: (authorize: (redirectUri: string) => Promise<string>) => Promise<string>;
  /**
   * Opens a connection to a mail server: TLS from the first byte with
   * `tls: true`, plain (to be upgraded with `startTls`) otherwise. Certificates
   * are verified against the system's (or a bundled) root store.
   */
  connect(host: string, port: number, opts: { tls: boolean }): Promise<ByteStream>;
  /** The relay (infra/relay): Otter accounts, linked accounts, push. */
  relayUrl: string;
  /**
   * How the relay knows this device: a bearer token the desktop keeps, or
   * the browser's session cookie (signed in by redirect).
   */
  relaySession: "bearer" | "cookie";
  /** How this device appears in the Otter account's device list. */
  deviceName?: string;

  /** Push to every window (renderer: `desktopBridge.on`). */
  broadcast(channel: string, params?: unknown): void;
  /** A new-mail notification; clicking it opens `open` in the main window. */
  notify(notification: {
    title: string;
    subtitle?: string;
    body?: string;
    open?: { accountId: string; messageId: string };
  }): void;
  /** Total unread in the inbox, for the Dock or tab badge. */
  setUnreadCount(count: number): void;
  /** Runs `listener` after the machine wakes or the network comes back. */
  onResume(listener: () => void): () => void;
  asyncContext<T>(): AsyncContext<T>;
  /** Download bodies of all mail for offline reading (not in a browser's storage). */
  offlineDownloads: boolean;
  /** Absent where there's no on-device translator (browsers other than Chrome). */
  translator?: Translator;
  /** Agents beyond Hermes and OpenClaw that run on this device (Codex and Claude, on the Mac). */
  agentProviders?: ChatProvider[];
  /** Local demo agent endpoint; production uses the signed-in relay. */
  agentServerUrl?: string;
}

let current: Platform | null = null;

export function setPlatform(platform: Platform): void {
  current = platform;
}

export function platform(): Platform {
  if (!current) throw new Error("initCore() has not run.");
  return current;
}
