// Runs Electron against the Vite dev server and restarts it whenever
// `vp pack --watch` rewrites the main-process, backend or preload bundle.
// Started by scripts/dev-runner.ts; expects VITE_DEV_SERVER_URL.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers/promises";

import { desktopDir, electronChildEnv, resolveElectronPath } from "./electron-launcher.mjs";

const devServerUrl = process.env.VITE_DEV_SERVER_URL?.trim();
if (!devServerUrl) {
  throw new Error("VITE_DEV_SERVER_URL is required (run `pnpm dev:desktop` from the repo root).");
}
const devServer = new URL(devServerUrl);
const devServerPort = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(devServerPort) || devServerPort <= 0) {
  throw new Error(`VITE_DEV_SERVER_URL must include an explicit port: ${devServerUrl}`);
}

const watchedFiles = [
  "dist-electron/main.cjs",
  "dist-electron/backend.cjs",
  "dist-electron/preload.cjs",
  "dist-electron/extensions-preload.cjs",
].map((file) => NodePath.join(desktopDir, file));
const waitTimeoutMs = 120_000;
const restartDebounceMs = 300;
const forcedShutdownTimeoutMs = 2_000;

function tcpPortIsOpen(host, port) {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host, port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function waitForResources() {
  const hosts = [devServer.hostname === "localhost" ? "127.0.0.1" : devServer.hostname, "::1"];
  const startedAt = Date.now();
  while (true) {
    const missing = watchedFiles.filter((file) => !NodeFS.existsSync(file));
    let serverUp = false;
    for (const host of hosts) {
      if (await tcpPortIsOpen(host, devServerPort)) {
        serverUp = true;
        break;
      }
    }
    if (missing.length === 0 && serverUp) return;
    if (Date.now() - startedAt > waitTimeoutMs) {
      const pending = [
        ...(serverUp ? [] : [`dev server on port ${devServerPort}`]),
        ...missing.map((file) => NodePath.relative(desktopDir, file)),
      ];
      throw new Error(`Timed out waiting for ${pending.join(", ")}`);
    }
    await NodeTimers.setTimeout(150);
  }
}

await waitForResources();

const electronPath = resolveElectronPath();
// Lets Playwright (connectOverCDP) and DevTools attach to the running app.
const debuggingPort = Number(process.env.OTTER_MAIL_REMOTE_DEBUGGING_PORT ?? 0);
const debuggingArgs =
  debuggingPort > 0 ? [`--remote-debugging-port=${debuggingPort}`, "--remote-allow-origins=*"] : [];
const childEnv = electronChildEnv({ VITE_DEV_SERVER_URL: devServerUrl });

let shuttingDown = false;
let currentApp = null;
let restartTimer = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();

function startApp() {
  if (shuttingDown || currentApp) return;
  const app = NodeChildProcess.spawn(electronPath, [desktopDir, ...debuggingArgs], {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });
  currentApp = app;
  app.once("error", (error) => {
    console.error(`[dev-electron] Failed to start Electron: ${error.message}`);
    if (currentApp === app) currentApp = null;
  });
  app.once("exit", (code, signal) => {
    if (currentApp === app) currentApp = null;
    if (shuttingDown || expectedExits.has(app)) return;
    if (signal !== null || code !== 0) {
      console.warn(`[dev-electron] Electron exited (${signal ?? code}); restarting.`);
      scheduleRestart();
    } else {
      console.log("[dev-electron] App quit. It will relaunch on the next main/preload change.");
    }
  });
}

function stopApp() {
  const app = currentApp;
  if (!app) return Promise.resolve();
  currentApp = null;
  expectedExits.add(app);
  return new Promise((resolve) => {
    if (app.exitCode !== null || app.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      app.kill("SIGKILL");
      resolve();
    }, forcedShutdownTimeoutMs);
    app.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    app.kill("SIGTERM");
  });
}

function scheduleRestart() {
  if (shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        // The bundler may be mid-write; wait until both files exist again.
        while (watchedFiles.some((file) => !NodeFS.existsSync(file))) {
          if (shuttingDown) return;
          await NodeTimers.setTimeout(100);
        }
        startApp();
      });
  }, restartDebounceMs);
}

// Stat polling survives the bundler deleting and recreating dist-electron,
// which fs.watch on the directory does not.
for (const file of watchedFiles) {
  NodeFS.watchFile(file, { interval: 250 }, (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs && current.mtimeMs !== 0) scheduleRestart();
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const file of watchedFiles) NodeFS.unwatchFile(file);
  await stopApp();
  process.exit(exitCode);
}

process.once("SIGINT", () => void shutdown(130));
process.once("SIGTERM", () => void shutdown(143));
process.once("SIGHUP", () => void shutdown(129));

// A dev runner killed outright (SIGKILL, a closed terminal tab) never signals
// us; we'd be reparented and keep relaunching Electron into a dead terminal.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) void shutdown(0);
}, 1_000).unref();

startApp();
