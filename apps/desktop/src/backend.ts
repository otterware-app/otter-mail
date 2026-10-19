/**
 * The mail backend: @otter-mail/core in an Electron utility process, so its
 * syncing, SQLite writes and message parsing never hold up the main process
 * (windows, menus, the windows' IPC). Main (backend-host.ts) forwards the
 * windows' invokes here and sends out what core broadcasts; this asks main
 * for what only main can do (main-link.ts). The web app runs core the same
 * way, in a Web Worker.
 */

import { DEMO_MAILBOXES_ENV } from "@otter-mail/contracts/demo";
import {
  addDemoMailboxes,
  onSettingsChanged,
  registeredHandlers,
  shutdownProviders,
  startCore,
} from "@otter-mail/core";

import { appInfo, type ToBackend } from "./backend-protocol.js";
import { registerBackendHandlers } from "./handlers/backend.js";
import { logger, sendLogsTo } from "./logger.js";
import { postToMain, settleRequest, tellMain } from "./main-link.js";
import { desktopPlatform, resumeListeners } from "./platform.js";
import { serverUrl } from "./services/agent/mcp-server.js";

// One log: main writes this process's lines with its own.
sendLogsTo((level, scope, message, data) => tellMain({ kind: "log", level, scope, message, data }));

async function start(): Promise<void> {
  const platform = desktopPlatform();
  await startCore(platform);
  registerBackendHandlers();
  // Agents on this Mac reach the tools whether or not a chat has started.
  serverUrl().catch((error: unknown) =>
    logger.error("backend", "MCP server failed to start", error),
  );
  onSettingsChanged((settings, patch) => tellMain({ kind: "settings", settings, patch }));
  // `pnpm dev:demo:desktop`: its mailboxes are here before the windows ask.
  const demo = process.env[DEMO_MAILBOXES_ENV];
  if (demo && !appInfo().packaged) {
    await addDemoMailboxes(demo).catch((error: unknown) =>
      logger.error("backend", "Couldn't add the demo mailboxes", error),
    );
  }
  postToMain({ type: "ready", channels: [...registeredHandlers().keys()] });
}

async function invoke(id: number, channel: string, params: unknown): Promise<void> {
  const handler = registeredHandlers().get(channel);
  try {
    if (!handler) throw new Error(`No handler for ${channel}.`);
    postToMain({ type: "result", id, result: await handler(params) });
  } catch (err) {
    postToMain({ type: "result", id, error: err instanceof Error ? err.message : String(err) });
  }
}

const ready = start();
ready.catch((err: unknown) => {
  logger.error("backend", "Core failed to start", err);
  process.exit(1);
});

process.parentPort.on("message", (event) => {
  const message = event.data as ToBackend;
  if (message.type === "invoke") {
    void ready.then(() => invoke(message.id, message.channel, message.params));
  } else if (message.type === "reply") {
    settleRequest(message.id, message.result, message.error);
  } else if (message.type === "resume") {
    for (const listener of resumeListeners) listener();
  } else if (message.type === "shutdown") {
    // Codex app-servers are child processes; don't leave them behind.
    shutdownProviders();
    process.exit(0);
  }
});
