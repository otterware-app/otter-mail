/**
 * Messages between the main process (backend-host.ts) and the mail backend,
 * @otter-mail/core in a utility process (backend.ts). Main forwards the
 * windows' invokes and sends out the backend's pushes; the backend asks main
 * for what only main can do (the Keychain, dialogs, notifications, the
 * Dock). The web app's page and Worker talk the same way
 * (apps/web/src/web/protocol.ts).
 */

import type { AppSettings, PickedFile } from "@otter-mail/core";

import type { Level } from "./logger.js";

/** What the backend asks of main, and what main answers. */
export type MainRequests = {
  /** safeStorage: `text` encrypted with the Keychain's key, as base64. */
  seal: { params: { text: string }; result: string };
  unseal: { params: { sealed: string }; result: string };
  openExternal: { params: { url: string }; result: void };
  openFile: { params: { name: string; bytes: Uint8Array }; result: void };
  /** False when the user cancelled. */
  saveFile: { params: { name: string; bytes: Uint8Array }; result: boolean };
  pickFiles: { params: undefined; result: PickedFile[] };
};

/** What the backend has main do, without an answer. */
export type MainEffect =
  | { kind: "broadcast"; channel: string; params: unknown }
  | {
      kind: "notify";
      title: string;
      subtitle?: string;
      body?: string;
      open?: { accountId: string; messageId: string };
      code?: string;
    }
  /** The Dock badge. */
  | { kind: "unread"; count: number }
  /** Settings main applies itself (open at login, the Dock badge). */
  | { kind: "settings"; settings: AppSettings; patch: Partial<AppSettings> }
  | { kind: "log"; level: Level; scope: string; message: string; data?: string };

export type ToBackend =
  | { type: "invoke"; id: number; channel: string; params: unknown }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  /** The Mac woke up. */
  | { type: "resume" }
  /** The app is quitting: stop the assistants' processes and exit. */
  | { type: "shutdown" };

export type FromBackend =
  /** Core is running; `channels` are the ones it handles. */
  | { type: "ready"; channels: string[] }
  | { type: "result"; id: number; result?: unknown; error?: string }
  | {
      type: "request";
      id: number;
      kind: keyof MainRequests;
      params: MainRequests[keyof MainRequests]["params"];
    }
  | ({ type: "effect" } & MainEffect);

/** What main tells the backend about the app (Electron's `app` only exists in main). */
export type AppInfo = {
  /** The state directory (userData, see paths.ts). */
  stateDir: string;
  version: string;
  packaged: boolean;
  resourcesPath: string;
};

const APP_INFO_ENV = "OTTER_MAIL_APP_INFO";

/** The backend's environment variable carrying `info`. */
export const appInfoEnv = (info: AppInfo) => ({ [APP_INFO_ENV]: JSON.stringify(info) });

let info: AppInfo | null = null;

/** In the backend: what main told it. */
export function appInfo(): AppInfo {
  return (info ??= JSON.parse(process.env[APP_INFO_ENV] ?? "null") as AppInfo);
}
