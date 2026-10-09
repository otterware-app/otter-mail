import { todoistSignIn } from "./services/todoist-oauth.js";
/**
 * The desktop's Platform for @otter-mail/core, in the mail backend's utility
 * process (backend.ts): its data in the state directory (paths.ts), SQLite
 * through node:sqlite, what only the main process can do (safeStorage,
 * dialogs, notifications, the badge) asked of main (main-link.ts), and what
 * differs between macOS and Linux from os/backend.ts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AsyncContext, Platform, SqlDatabase } from "@otter-mail/core";

import { appInfo } from "./backend-protocol.js";
import { logger } from "./logger.js";
import { requestMain, tellMain } from "./main-link.js";
import { backendOS } from "./os/backend.js";
import { googleAuth } from "./services/gmail-oauth.js";
import { connectMailSocket } from "./services/mail-socket.js";
import { microsoftAuth } from "./services/microsoft-oauth.js";
import { claudeProvider } from "./services/agent/claude.js";
import { codexProvider } from "./services/agent/codex.js";
import { desktopSupportDiagnostics } from "./services/support-diagnostics.js";

const home = () => appInfo().stateDir;

/** Writes through a temp file, so a crash never leaves half a file. */
async function writeFileAtomic(file: string, data: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, file);
}

const SECRETS_FILE = "secrets.json";

async function readSecrets(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(path.join(home(), SECRETS_FILE), "utf-8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function openDatabase(): SqlDatabase {
  const db = new DatabaseSync(path.join(home(), "mail-cache.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  return db as unknown as SqlDatabase;
}

/** Listeners for the computer waking up (main says so, backend.ts). */
export const resumeListeners = new Set<() => void>();

export function desktopPlatform(): Platform {
  let database: SqlDatabase | null = null;
  return {
    kind: "desktop",
    supportDiagnostics: desktopSupportDiagnostics,
    appVersion: appInfo().version,
    log: (level, scope, message, data) => logger[level](scope, message, data),

    database: () => (database ??= openDatabase()),
    connect: connectMailSocket,
    files: {
      async read(file) {
        try {
          return new Uint8Array(await fs.readFile(path.join(home(), file)));
        } catch {
          return null;
        }
      },
      write: (file, data) => writeFileAtomic(path.join(home(), file), data),
      remove: (file) => fs.rm(path.join(home(), file), { force: true }),
      async list(dir) {
        const full = path.join(home(), dir);
        const names = await fs.readdir(full).catch(() => [] as string[]);
        const files = await Promise.all(
          names.map(async (name) => {
            const stat = await fs.stat(path.join(full, name)).catch(() => null);
            return stat?.isFile() ? { name, size: stat.size, modifiedAt: stat.mtimeMs } : null;
          }),
        );
        return files.filter((f) => f !== null);
      },
    },
    secrets: {
      async get(name) {
        const sealed = (await readSecrets())[name];
        return sealed ? requestMain("unseal", { sealed }) : null;
      },
      async set(name, value) {
        const secrets = await readSecrets();
        secrets[name] = await requestMain("seal", { text: value });
        await writeFileAtomic(path.join(home(), SECRETS_FILE), JSON.stringify(secrets, null, 2));
      },
      async delete(name) {
        const secrets = await readSecrets();
        if (!(name in secrets)) return;
        delete secrets[name];
        await writeFileAtomic(path.join(home(), SECRETS_FILE), JSON.stringify(secrets, null, 2));
      },
    },
    userFiles: {
      open: (name, bytes) => requestMain("openFile", { name, bytes }),
      save: (name, bytes) => requestMain("saveFile", { name, bytes }),
      pick: () => requestMain("pickFiles", undefined),
    },

    google: googleAuth,
    microsoft: microsoftAuth,
    todoistSignIn,
    relayUrl: process.env.OTTER_MAIL_RELAY_URL?.trim() || "https://relay.mail.otterware.app",
    relaySession: "bearer",
    deviceName: backendOS.deviceName(),

    broadcast: (channel, params) => tellMain({ kind: "broadcast", channel, params }),
    notify: (notification) => tellMain({ kind: "notify", ...notification }),
    setUnreadCount: (count) => tellMain({ kind: "unread", count }),
    onResume(listener) {
      resumeListeners.add(listener);
      return () => resumeListeners.delete(listener);
    },
    asyncContext<T>(): AsyncContext<T> {
      const storage = new AsyncLocalStorage<T>();
      return { run: (value, fn) => storage.run(value, fn), get: () => storage.getStore() };
    },
    offlineDownloads: true,
    translator: backendOS.translator,
    agentProviders: [codexProvider, claudeProvider],
  };
}
