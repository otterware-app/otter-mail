/**
 * Runs the mail backend (backend.ts: @otter-mail/core) in an Electron utility
 * process and connects it to the app: the windows' invokes on its channels
 * are forwarded to it, what it broadcasts goes out to every window, and what
 * it asks of main (safeStorage, dialogs, notifications, the badge) is done
 * here. A backend that dies is started again. See backend-protocol.ts.
 */

import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  powerMonitor,
  safeStorage,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AppSettings } from "@otter-mail/core";

import {
  appInfoEnv,
  type FromBackend,
  type MainEffect,
  type MainRequests,
  type ToBackend,
} from "./backend-protocol.js";
import { broadcast } from "./ipc.js";
import { logger } from "./logger.js";
import { hostOS } from "./os/index.js";
import { setPendingOpenMessage } from "./services/open-message-target.js";
import { focusMainWindow } from "./windows/main-window.js";

let backend: UtilityProcess | null = null;
let stopping = false;
/** Resolves once the running backend is ready (a restart makes a new one). */
let ready: Promise<void> = Promise.resolve();
let nextInvokeId = 1;
const invoking = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
/** Channels forwarded to the backend (ipcMain handles each once). */
const forwarded = new Set<string>();

const RESTART_DELAY_MS = 1_000;
const RESTART_DELAY_MAX_MS = 30_000;
let restartDelay = RESTART_DELAY_MS;

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- a process has none
const send = (message: ToBackend) => backend?.postMessage(message);

/** Starts the backend; resolves once core is running and its channels are served. */
export function startBackend(): Promise<void> {
  const child = utilityProcess.fork(path.join(__dirname, "backend.cjs"), [], {
    serviceName: "Otter Mail Backend",
    env: {
      ...process.env,
      ...appInfoEnv({
        stateDir: app.getPath("userData"),
        version: app.getVersion(),
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      }),
    },
  });
  backend = child;
  ready = new Promise((resolve) => {
    child.on("message", (message: FromBackend) => {
      if (message.type === "ready") {
        serve(message.channels);
        restartDelay = RESTART_DELAY_MS;
        resolve();
      } else {
        receive(message);
      }
    });
  });
  child.on("exit", (code) => {
    if (backend === child) backend = null;
    for (const call of invoking.values()) call.reject(new Error("The mail backend stopped."));
    invoking.clear();
    if (stopping) return;
    logger.error("backend", `The mail backend exited (${code}); starting it again`);
    setTimeout(() => void startBackend(), restartDelay);
    restartDelay = Math.min(restartDelay * 2, RESTART_DELAY_MAX_MS);
  });
  return ready;
}

/** Tells the backend the app is quitting: it stops the assistants and exits. */
export function stopBackend(): void {
  stopping = true;
  send({ type: "shutdown" });
}

/** Calls one of the backend's channels, as a window would. */
export async function invokeBackend(channel: string, params?: unknown): Promise<unknown> {
  await ready;
  const id = nextInvokeId++;
  const result = new Promise((resolve, reject) => invoking.set(id, { resolve, reject }));
  send({ type: "invoke", id, channel, params });
  return result;
}

function serve(channels: string[]): void {
  for (const channel of channels) {
    if (forwarded.has(channel)) continue;
    forwarded.add(channel);
    ipcMain.handle(channel, (_event, params: unknown) => invokeBackend(channel, params));
  }
}

void app.whenReady().then(() => powerMonitor.on("resume", () => send({ type: "resume" })));

function receive(message: Exclude<FromBackend, { type: "ready" }>): void {
  if (message.type === "result") {
    const call = invoking.get(message.id);
    invoking.delete(message.id);
    if (message.error !== undefined) call?.reject(new Error(message.error));
    else call?.resolve(message.result);
  } else if (message.type === "request") {
    const { id, kind, params } = message;
    answer(kind, params).then(
      (result) => send({ type: "reply", id, result }),
      (err: unknown) =>
        send({ type: "reply", id, error: err instanceof Error ? err.message : String(err) }),
    );
  } else {
    carryOut(message);
  }
}

// ── What the backend asks ─────────────────────────────────────────────────

async function answer(
  kind: keyof MainRequests,
  params: MainRequests[keyof MainRequests]["params"],
): Promise<unknown> {
  switch (kind) {
    case "seal": {
      const { text } = params as MainRequests["seal"]["params"];
      return safeStorage.encryptString(text).toString("base64");
    }
    case "unseal": {
      const { sealed } = params as MainRequests["unseal"]["params"];
      return safeStorage.decryptString(Buffer.from(sealed, "base64"));
    }
    case "openExternal": {
      await shell.openExternal((params as MainRequests["openExternal"]["params"]).url);
      return;
    }
    case "openFile": {
      const { name, bytes } = params as MainRequests["openFile"]["params"];
      const error = await shell.openPath(await tempFile(name, bytes));
      if (error) throw new Error(error);
      return;
    }
    case "saveFile": {
      const { name, bytes } = params as MainRequests["saveFile"]["params"];
      const result = await dialog.showSaveDialog({ defaultPath: name });
      if (result.canceled || !result.filePath) return false;
      await fs.writeFile(result.filePath, bytes);
      return true;
    }
    case "pickFiles": {
      const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
      if (result.canceled) return [];
      return Promise.all(
        result.filePaths.map(async (file) => ({
          name: path.basename(file),
          mimeType:
            MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream",
          bytes: new Uint8Array(await fs.readFile(file)),
        })),
      );
    }
  }
}

// ── What the backend has main do ──────────────────────────────────────────

const MAX_AWAITING_CLICK = 50;
const notificationsAwaitingClick = new Set<Notification>();

function carryOut(effect: MainEffect): void {
  switch (effect.kind) {
    case "broadcast":
      broadcast(effect.channel, effect.params);
      return;
    case "notify": {
      const { kind: _kind, open, code, ...options } = effect;
      if (!Notification.isSupported()) return;
      const notification = new Notification({
        ...options,
        // A button on macOS; Linux has none (the code is in the text).
        ...(code && { actions: [{ type: "button" as const, text: "Copy & trash" }] }),
      });
      notificationsAwaitingClick.add(notification);
      if (notificationsAwaitingClick.size > MAX_AWAITING_CLICK) {
        notificationsAwaitingClick.delete(notificationsAwaitingClick.values().next().value!);
      }
      notification.on("click", () => {
        notificationsAwaitingClick.delete(notification);
        // The main window pulls it on mount, or on mail:open.
        if (open) setPendingOpenMessage(open);
        void focusMainWindow().then(() => open && broadcast("mail:open"));
      });
      notification.on("action", () => {
        notificationsAwaitingClick.delete(notification);
        if (!code) return;
        clipboard.writeText(code);
        // A code is spent once used: its mail goes to the Trash.
        if (open) {
          invokeBackend("gmail:trashMessage", open).catch((err: unknown) =>
            logger.warn("notify", "trashing the code's mail failed", String(err)),
          );
        }
      });
      notification.show();
      return;
    }
    case "unread":
      unreadCount = effect.count;
      showDockBadge();
      return;
    case "settings":
      applySettings(effect.settings, effect.patch);
      return;
    case "log":
      logger[effect.level](effect.scope, effect.message, effect.data);
      return;
  }
}

let unreadCount = 0;
let dockBadgeEnabled = false;

function showDockBadge(): void {
  hostOS.setBadge(dockBadgeEnabled ? unreadCount : 0);
}

/** Shows or hides the unread badge, keeping the count for when it comes back. */
export function setDockBadgeEnabled(enabled: boolean): void {
  dockBadgeEnabled = enabled;
  showDockBadge();
}

/** The settings main carries out itself. */
function applySettings(settings: AppSettings, patch: Partial<AppSettings>): void {
  if (patch.dockBadgeEnabled !== undefined) {
    setDockBadgeEnabled(settings.dockBadgeEnabled);
  }
  if (patch.launchAtLogin !== undefined) {
    hostOS.setLaunchAtLogin(settings.launchAtLogin);
  }
}

// ── Files ─────────────────────────────────────────────────────────────────

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  ics: "text/calendar",
  zip: "application/zip",
  gz: "application/gzip",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
  return cleaned || "attachment";
}

/**
 * Writes `bytes` to a temp file named `name` (reused while its content is
 * the same) and returns its path: what Preview and Finder drags need.
 */
export async function tempFile(name: string, bytes: Uint8Array): Promise<string> {
  const key = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const file = path.join(app.getPath("temp"), "otter-mail-files", key, sanitizeFilename(name));
  const existing = await fs.stat(file).catch(() => null);
  if (!existing || existing.size !== bytes.length) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return file;
}
