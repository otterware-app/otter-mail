/**
 * The browser's Platform for @otter-mail/core, inside the Web Worker: the
 * mail cache in SQLite WASM and the app's files both live in the origin's
 * private file system (OPFS); anything that needs the page goes through
 * `page` (worker.ts).
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { AsyncContext, FileInfo, Platform, SqlDatabase, SqlValue } from "@otter-mail/core";

import { webGoogleAuth } from "./google";
import { connectMailSocket } from "./mail-socket";
import { webSecrets } from "./secrets";
import type { PageEffect, PageRequests } from "./protocol";

export type Page = {
  request<K extends keyof PageRequests>(
    kind: K,
    params: PageRequests[K]["params"],
  ): Promise<PageRequests[K]["result"]>;
  effect(effect: PageEffect): void;
  broadcast(channel: string, params?: unknown): void;
  onResume(listener: () => void): () => void;
};

/**
 * The mail cache. OPFS "SAH pool" storage needs no cross-origin isolation;
 * one tab at a time can open it, so only the hosting tab runs this (backend.ts).
 */
async function openDatabase(): Promise<SqlDatabase> {
  const sqlite3 = await sqlite3InitModule();
  // The demo keeps its own cache (in OPFS's ".otter-mail-demo").
  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: __DEMO__ ? "otter-mail-demo" : "otter-mail",
  });
  const db = new pool.OpfsSAHPoolDb("/mail-cache.db");
  const bind = (params: SqlValue[]) => (params.length > 0 ? (params as never) : undefined);
  return {
    exec: (sql) => void db.exec(sql),
    prepare: (sql) => ({
      get: (...params) => db.selectObject(sql, bind(params)) as Record<string, SqlValue>,
      all: (...params) => db.selectObjects(sql, bind(params)) as Record<string, SqlValue>[],
      run: (...params) => {
        db.exec(sql, { bind: bind(params) });
        return { changes: db.changes() };
      },
    }),
  };
}

// ── Files (OPFS, under files/, or demo-files/ in demo mode) ────────────────

async function directory(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await (
    await navigator.storage.getDirectory()
  ).getDirectoryHandle(__DEMO__ ? "demo-files" : "files", { create: true });
  for (const name of path) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

function split(path: string): { dirs: string[]; name: string } {
  const parts = path.split("/").filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts.at(-1) ?? "" };
}

const files: Platform["files"] = {
  async read(path) {
    try {
      const { dirs, name } = split(path);
      const file = await (await (await directory(dirs, false)).getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  },
  async write(path, data) {
    const { dirs, name } = split(path);
    const handle = await (await directory(dirs, true)).getFileHandle(name, { create: true });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    // Sync access handles work in every browser's workers (writable streams don't yet).
    const access = await handle.createSyncAccessHandle();
    try {
      access.truncate(0);
      access.write(bytes, { at: 0 });
      access.flush();
    } finally {
      access.close();
    }
  },
  async remove(path) {
    const { dirs, name } = split(path);
    await (await directory(dirs, false)).removeEntry(name).catch(() => {});
  },
  async list(path) {
    const out: FileInfo[] = [];
    try {
      const dir = await directory(path.split("/").filter(Boolean), false);
      for await (const handle of (
        dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        if (handle.kind !== "file") continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        out.push({ name: handle.name, size: file.size, modifiedAt: file.lastModified });
      }
    } catch {
      // no such folder yet
    }
    return out;
  },
};

const noContext = <T>(): AsyncContext<T> => ({ run: (_value, fn) => fn(), get: () => undefined });

export async function webPlatform(page: Page): Promise<Platform> {
  const database = await openDatabase();
  // Demo mode: a pretend Gmail in front of fetch (left out of real builds).
  const demo = __DEMO__ ? await import("./demo/gmail") : null;
  if (demo) await demo.installFakeGmail(files);
  const relayUrl = demo
    ? demo.DEMO_RELAY_URL
    : import.meta.env.VITE_RELAY_URL || "https://relay.mail.otterware.app";
  const platform: Platform = {
    kind: "web",
    supportDiagnostics: async () => ({ environment: navigator.userAgent }),
    appVersion: __APP_VERSION__,
    log: (level, scope, message, data) =>
      console[level === "debug" ? "log" : level](`[${scope}] ${message}`, data ?? ""),

    database: () => database,
    // The relay's tunnel (mail-socket.ts); the demo has no relay.
    connect: demo
      ? () => Promise.reject(new Error("The demo can't connect to mail servers."))
      : (host, port, opts) => connectMailSocket(relayUrl, host, port, opts),
    files,
    // IMAP passwords and the like, encrypted in the origin's files (secrets.ts).
    secrets: webSecrets(files),
    userFiles: {
      open: async (name, bytes) => page.effect({ kind: "open", name, bytes }),
      save: async (name, bytes) => {
        page.effect({ kind: "download", name, bytes });
        return true;
      },
      pick: () => page.request("pickFiles", undefined),
    },

    todoistSignIn: async (authorize) => {
      try {
        const url = await authorize(`${self.location.origin}/todoist-callback/`);
        return await page.request("todoistSignIn", { url });
      } finally {
        await page.request("todoistSignIn", { close: true });
      }
    },
    google: demo ? demo.demoGoogleAuth() : webGoogleAuth({ relayUrl, page, files }),
    relayUrl,
    agentServerUrl: demo ? `${self.location.origin}/api/agent` : undefined,
    relaySession: "cookie",

    broadcast: page.broadcast,
    notify: (notification) => page.effect({ kind: "notify", ...notification }),
    setUnreadCount: (count) => page.effect({ kind: "badge", count }),
    onResume: page.onResume,
    // Browsers have no AsyncLocalStorage: all Gmail work shares one quota tier,
    // which is fine without the offline body download.
    asyncContext: noContext,
    offlineDownloads: false,
    // Chrome's built-in translator, in the page (the UI only offers it where it exists).
    translator: {
      detect: (text) => page.request("detectLanguage", { text }),
      translate: (texts, source, target) => page.request("translate", { texts, source, target }),
    },
  };
  return platform;
}
