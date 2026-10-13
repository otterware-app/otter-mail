/**
 * What differs between the operating systems the desktop app runs on (macOS
 * and Linux), as one interface each implements: os/mac and os/linux. The rest
 * of the app asks `hostOS` (os/index.ts) and never checks `process.platform`
 * itself. What the renderer may show follows from os/features.ts.
 */

import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
} from "electron";

import type { Translator } from "@otter-mail/core";

/** An app that can open mailto: links, as the default mail app setting lists it. */
export type MailApp = { id: string; name: string; path: string };
export type MailApps = { apps: MailApp[]; defaultId: string | null };

/** A terminal app a support investigation can open in. */
export type TerminalApp = { id: string; name: string };

/** The menu items main.ts builds; each OS arranges them into its menu bar. */
export type AppMenuItems = {
  about: MenuItemConstructorOptions;
  checkForUpdates: MenuItemConstructorOptions;
  settings: MenuItemConstructorOptions;
  file: MenuItemConstructorOptions[];
  edit: MenuItemConstructorOptions[];
  view: MenuItemConstructorOptions[];
  go: MenuItemConstructorOptions[];
  mailbox: MenuItemConstructorOptions[];
  help: MenuItemConstructorOptions[];
};

/** The main process's side of the operating system. */
export interface HostOS {
  /** Installed native messaging hosts, in the app's profile and Chrome's standard locations. */
  nativeMessagingDirectories(): string[];

  /** The modifier of the app's shortcuts: ⌘ on macOS, Ctrl elsewhere (a KeyboardEvent flag). */
  modifierKey: "metaKey" | "ctrlKey";

  /** The main window's frame: options for its BrowserWindow. */
  mainWindowOptions(): BrowserWindowConstructorOptions;
  /** Keeps what the OS draws over the window (Linux's window controls) in the app's light or dark. */
  windowFollowsTheme(win: BrowserWindow): void;
  /** Builds the menu bar from the app's items. */
  applicationMenu(items: AppMenuItems): MenuItemConstructorOptions[];

  /** Whether the app stays running with no window open (macOS's Dock brings it back). */
  runsWithoutWindows: boolean;

  /**
   * Whether a downloaded update installs whenever the app quits, or only on
   * "Restart to update" (a .deb asks for the admin password: not at logout).
   */
  installsUpdatesOnQuit: boolean;

  /** Readies safeStorage (which seals the mailboxes' secrets) once the app is ready. */
  prepareSecrets(): void;

  setLaunchAtLogin(enabled: boolean): void;
  /** The unread count on the app's icon, or none. */
  setBadge(count: number): void;

  /** Other apps that can be the default mail app, and handing the default to one. */
  mailApps: {
    list(): Promise<MailApps>;
    setDefault(id: string): Promise<void>;
  };

  /** Terminal apps, for handing a support report to a coding agent. */
  terminals: {
    list(): Promise<{ apps: TerminalApp[]; defaultName: string | null }>;
    /** Runs `launcher` (a script) in the given terminal, or the system's default one. */
    open(launcher: string, terminalId: string | null): Promise<void>;
    /** The launcher script's file name and first line (its login shell). */
    launcher: { fileName: string; shebang: string };
  };
}

/** The mail backend's side of the operating system (its utility process has no windows). */
export interface BackendOS {
  /** The computer's name as the user knows it, for the Otter account's device list. */
  deviceName(): string;
  /** The OS and its version, for support reports ("macOS (Darwin 25.0.0, arm64)"). */
  environment(): string;
  /** The on-device translator, where the OS has one. */
  translator?: Translator;
}
