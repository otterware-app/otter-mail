/**
 * The surface the preload script exposes to renderer windows as
 * `window.desktopBridge`. Everything the UI asks of the main process goes
 * through `invoke` (request/response, handled with `ipcMain.handle`) or `on`
 * (main → renderer pushes, sent with `broadcast`).
 */

export * from "./mail.js";
export * from "./settings.js";

export type ThemeSource = "system" | "light" | "dark";

export interface NativeThemeInfo {
  shouldUseDarkColors: boolean;
  themeSource: ThemeSource;
  shouldUseHighContrastColors: boolean;
  prefersReducedTransparency: boolean;
}

export type UpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  downloadPercent: number | null;
  checkedAt: number | null;
  message: string | null;
  /**
   * Set when macOS refused to install a downloaded update (a build without a
   * Developer ID signature): the release page to install it from by hand.
   */
  manualDownloadUrl: string | null;
}

/**
 * What the shell running the app can do. The desktop app has everything; the
 * web app (a browser tab) has none of these, and the UI hides them.
 */
export interface BridgeFeatures {
  /** macOS window chrome: traffic lights over the window's top-left corner. */
  trafficLights: boolean;
  /** Back and forward buttons in the title bar (a browser has its own). */
  historyButtons: boolean;
  /** The menu-bar icon and mini inbox. */
  menuBar: boolean;
  launchAtLogin: boolean;
  /** The unread count on the Dock icon. */
  dockBadge: boolean;
  /** Being the Mac's default mail app (mailto: links). */
  defaultMailApp: boolean;
  /** Apple's on-device translation. */
  translation: boolean;
  /** Dragging attachments out to Finder. */
  dragOut: boolean;
  /** Opening an attachment in its default app (Preview, Pages, …). */
  openFiles: boolean;
  /** Handing a support report to a locally installed agent in Terminal. */
  externalAgent: boolean;
  /**
   * Codex and Claude, the command-line agents installed on this computer, and
   * Otter Mail's tools for any agent on it (agent-tokens.ts' ConnectedAgent).
   */
  localAgents: boolean;
  /**
   * The browser in the agent panel: links from mail and chat open there as
   * tabs, with Chrome Web Store extensions (a web page can't embed sites).
   */
  browser: boolean;
}

export interface DesktopBridge {
  /** `process.platform` in the desktop app, "web" in a browser. */
  platform: "darwin" | "linux" | "win32" | "web" | (string & {});
  features: BridgeFeatures;
  /** Call a main-process handler registered with `ipcMain.handle(channel, …)`. */
  invoke<T = unknown>(channel: string, params?: unknown): Promise<T>;
  /** Listen for a main-process push on `channel`. Returns an unsubscribe function. */
  on(channel: string, listener: (params: unknown) => void): () => void;
  openExternal(url: string): Promise<void>;
  nativeTheme: {
    getInfo(): Promise<NativeThemeInfo>;
    setThemeSource(source: ThemeSource): Promise<void>;
  };
  updates: {
    getState(): Promise<UpdateState>;
    check(): Promise<UpdateState>;
    download(): Promise<UpdateState>;
    install(): Promise<void>;
    onState(listener: (state: UpdateState) => void): () => void;
  };
}

/** Push channel carrying `UpdateState` changes. */
export const UPDATE_STATE_CHANNEL = "updates:state";

/**
 * The Otter account as the renderer sees it (`otter:getState`, and pushed on
 * `otter:state`): who is signed in, and whether new mail arrives by push.
 */
export interface OtterAccountState {
  user: { email: string; name: string | null; picture: string | null } | null;
  /** "live": the relay's event stream is connected, so Gmail changes arrive within seconds. */
  realtime: "off" | "connecting" | "live";
}

/** A Mac signed in to the Otter account (`otter:listDevices`). */
export interface OtterDevice {
  /** Its session token, which `otter:signOutDevice` takes. */
  token: string;
  name: string;
  /** This Mac. */
  current: boolean;
  lastActiveAt: number;
}

/** Push channel carrying `OtterAccountState` changes. */
export const OTTER_ACCOUNT_STATE_CHANNEL = "otter:state";

/** Saving a signature failed: this sign-in predates the Gmail settings scope. */
export const GMAIL_SETTINGS_PERMISSION =
  "Otter Mail needs permission to change this account's Gmail settings. Sign in to it again to allow it.";

/**
 * What Otter Mail asks Google for when a Gmail account signs in (the desktop
 * app, and the relay for the web app). The iPhone app asks for less
 * (apps/ios GoogleAuth.swift): it has no calendar or contacts features.
 */
export const GMAIL_SCOPES = [
  "https://mail.google.com/",
  "openid",
  "email",
  "profile",
  // People API, for sender avatars. Tokens issued before these scopes were
  // added simply 403 on People calls (the avatar cascade skips to Gravatar);
  // re-adding the account upgrades its consent in place.
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  // Calendar, for answering invitations in place: events on calendars the user
  // owns (the invitation's copy on their primary calendar). Tokens granted the
  // broader calendar.events before work the same; older tokens lack both: RSVP
  // then falls back to an email reply; re-adding the account upgrades it.
  "https://www.googleapis.com/auth/calendar.events.owned",
  // Gmail settings, for editing signatures (they live in Gmail). Older tokens
  // can read them but not save them; re-adding the account upgrades it.
  "https://www.googleapis.com/auth/gmail.settings.basic",
];

/** A confirmed agent change, kept with the chat so its result can be reopened. */
export type ChatChange = {
  title: string;
  action: "created" | "updated" | "deleted" | "trashed" | "restored";
  target:
    | { kind: "draft"; id: string; accountId: string }
    | { kind: "thread"; id: string; accountId: string }
    | { kind: "label"; id: string; accountId: string }
    | { kind: "project"; id: string }
    | { kind: "view"; id: string }
    | { kind: "theme"; id: string }
    | { kind: "event"; id: string; accountId: string; url: string | null };
};
