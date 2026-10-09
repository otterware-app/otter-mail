/**
 * The surface the preload script exposes to renderer windows as
 * `window.desktopBridge`. Everything the UI asks of the main process goes
 * through `invoke` (request/response, handled with `ipcMain.handle`) or `on`
 * (main → renderer pushes, sent with `broadcast`).
 */

export * from "./google.js";
export * from "./mail.js";
export * from "./microsoft.js";
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
   * Set when an update can't install itself (macOS refusing a build without a
   * Developer ID signature): the release page to install it from by hand.
   */
  manualDownloadUrl: string | null;
}

/**
 * What the shell running the app can do. The desktop app sets these per
 * operating system (apps/desktop/src/os/features.ts); the web app (a browser
 * tab) has none of the desktop's, and the UI hides what's off.
 */
export interface BridgeFeatures {
  /**
   * Where the window's own controls sit over the top bar, which leaves them
   * room: "left" for macOS's traffic lights, "right" for minimize, maximize
   * and close on Linux; null in a browser tab, whose controls are the browser's.
   */
  windowControls: "left" | "right" | null;
  /** The window is native frosted glass (macOS vibrancy): the frame lets it through. */
  vibrancy: boolean;
  /** Back and forward buttons in the title bar (a browser has its own). */
  historyButtons: boolean;
  launchAtLogin: boolean;
  /** The unread count on the Dock icon. */
  dockBadge: boolean;
  /** Being the computer's default mail app (mailto: links). */
  defaultMailApp: boolean;
  /** On-device translation (Apple's on macOS, the browser's built-in one on the web). */
  translation: boolean;
  /** Dragging attachments out to the file manager (Finder, Files). */
  dragOut: boolean;
  /** Opening an attachment in its default app. */
  openFiles: boolean;
  /** Handing a support report to a locally installed agent in a terminal. */
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

/** A computer signed in to the Otter account (`otter:listDevices`). */
export interface OtterDevice {
  /** Its session token, which `otter:signOutDevice` takes. */
  token: string;
  name: string;
  /** This computer. */
  current: boolean;
  lastActiveAt: number;
}

/** Push channel carrying `OtterAccountState` changes. */
export const OTTER_ACCOUNT_STATE_CHANNEL = "otter:state";

/** Saving a signature failed: this sign-in predates the Gmail settings scope. */
export const GMAIL_SETTINGS_PERMISSION =
  "Otter Mail needs permission to change this account's Gmail settings. Sign in to it again to allow it.";

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
