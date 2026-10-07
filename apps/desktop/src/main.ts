// Main process entry point.

import { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import type { NativeThemeInfo, ThemeSource } from "@otter-mail/contracts";
import type { AppSettings } from "@otter-mail/core";

import { invokeBackend, setDockBadgeEnabled, startBackend, stopBackend } from "./backend-host.js";
import { registerHandlers } from "./handlers/index.js";
import { requestSupportReport } from "./handlers/support.js";
import { broadcast } from "./ipc.js";
import { logger, logToFile } from "./logger.js";
import { hostOS } from "./os/index.js";
import type { AppMenuItems } from "./os/types.js";
import { configureAppPaths } from "./paths.js";
import { focusedBrowserPage, setupBrowser } from "./services/browser.js";
import { parseMailtoUrl, setPendingMailto } from "./services/mailto-target.js";
import { initUpdates } from "./updates.js";
import { setSettingsTarget } from "./windows/settings-window.js";
import { createMainWindow, focusMainWindow, getMainWindow } from "./windows/main-window.js";
import { handleRendererProtocol, registerRendererScheme } from "./windows/window-paths.js";

// Each kind of run has its own data home; see paths.ts.
configureAppPaths();
logToFile(app.getPath("logs"), !app.isPackaged);

// Logging to a terminal that has gone away (a stopped `pnpm dev`) must not
// crash the app with EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => {});
}

// In development, go away with the dev runner rather than linger orphaned.
if (process.env.VITE_DEV_SERVER_URL) {
  const parentPid = process.ppid;
  setInterval(() => {
    if (process.ppid !== parentPid) app.quit();
  }, 1_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

registerRendererScheme();

// ── mailto: handling (default mail app) ───────────────────────────────
// Clicking a mailto link anywhere on the computer lands here once Otter Mail
// is the default mail app: macOS sends it as `open-url`, Linux starts the app
// with it as an argument (a running app hears of it as a second instance).
// Stash the parsed target (the renderer pulls it via app:takePendingMailto on
// mount — covers cold starts) and nudge any live main window via broadcast.
function openMailto(url: string): void {
  const target = parseMailtoUrl(url);
  logger.info("main", "open-url", { mailto: target != null });
  if (!target) return;
  setPendingMailto(target);
  if (app.isReady()) {
    void focusMainWindow().then(() => broadcast("compose:mailto"));
  }
}

const mailtoArgument = (argv: string[]) => argv.find((arg) => /^mailto:/i.test(arg));

// Registered before `ready`: cold starts deliver the URL early.
app.on("open-url", (event, url) => {
  event.preventDefault();
  openMailto(url);
});
const launchMailto = mailtoArgument(process.argv);
if (launchMailto) openMailto(launchMailto);

app.on("second-instance", (_event, argv) => {
  const url = mailtoArgument(argv);
  if (url) openMailto(url);
  else void focusMainWindow();
});

// ── Appearance ────────────────────────────────────────────────────────
// Light/dark/system is chosen in Settings; Electron doesn't persist it.

function themeFile(): string {
  return path.join(app.getPath("userData"), "appearance.json");
}

function restoreThemeSource(): void {
  try {
    const stored = JSON.parse(fs.readFileSync(themeFile(), "utf-8")) as { themeSource?: unknown };
    if (
      stored.themeSource === "light" ||
      stored.themeSource === "dark" ||
      stored.themeSource === "system"
    ) {
      nativeTheme.themeSource = stored.themeSource;
    }
  } catch {
    // First launch: follow the system.
  }
}

function themeInfo(): NativeThemeInfo {
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
    shouldUseHighContrastColors: nativeTheme.shouldUseHighContrastColors,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
  };
}

ipcMain.handle("nativeTheme:getInfo", () => themeInfo());
ipcMain.handle("nativeTheme:setThemeSource", async (_event, source: unknown) => {
  if (source !== "light" && source !== "dark" && source !== "system") return;
  nativeTheme.themeSource = source as ThemeSource;
  await fs.promises.writeFile(themeFile(), JSON.stringify({ themeSource: source }));
});

ipcMain.handle("shell:openExternal", async (_event, url: unknown) => {
  if (typeof url !== "string" || !/^(https?|mailto|x-apple\.systempreferences):/i.test(url)) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

// ⌘Z / ⇧⌘Z landed in a text field: give it the regular text undo and redo.
ipcMain.handle("edit:nativeUndo", (event) => {
  event.sender.undo();
});
ipcMain.handle("edit:nativeRedo", (event) => {
  event.sender.redo();
});

ipcMain.handle("window:closeMain", () => {
  getMainWindow()?.close();
});

// ── Application menu ──────────────────────────────────────────────────
// The items are the same everywhere; each OS arranges them (HostOS.applicationMenu).
function setupApplicationMenu(): void {
  const isMainFocused = () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused != null && focused === getMainWindow();
  };

  const items: AppMenuItems = {
    about: { role: "about" },
    checkForUpdates: {
      label: "Check for Updates…",
      click: () => {
        void focusMainWindow().then(() => broadcast("updates:checkRequested"));
      },
    },
    settings: {
      label: "Settings…",
      click: async () => {
        setSettingsTarget({});
        await focusMainWindow();
        broadcast("settings:open");
      },
    },
    file: [
      // ⌘W closes the panel's active tab, or the panel for its last tab.
      // Without the panel, the renderer closes the main window.
      {
        label: "Close",
        accelerator: "CommandOrControl+W",
        click: () => {
          if (isMainFocused()) {
            broadcast("window:closeRequest");
            return;
          }
          BrowserWindow.getFocusedWindow()?.close();
        },
      },
      { type: "separator" },
      // The agent panel's browser (services/browser.ts).
      {
        label: "New Tab",
        accelerator: "CommandOrControl+T",
        click: (_item, _window, event) => {
          if (event.triggeredByAccelerator) {
            if (isMainFocused())
              getMainWindow()?.webContents.send("keybindings:keydown", {
                key: "t",
                [hostOS.modifierKey]: true,
              });
            return;
          }
          void focusMainWindow().then(() => broadcast("browser:newTab"));
        },
      },
      {
        label: "Open Location…",
        accelerator: "CommandOrControl+L",
        click: () => void focusMainWindow().then(() => broadcast("browser:focusAddress")),
      },
    ],
    edit: [
      // ⌘Z undoes the last mail action (archive, move, send…), ⇧⌘Z redoes
      // it — but text fields keep their own undo: the main window decides
      // (edit:undo → mail undo, or edit:nativeUndo back to the page). A
      // browser tab's page undoes its own typing.
      {
        label: "Undo",
        accelerator: "CommandOrControl+Z",
        click: () => {
          const page = focusedBrowserPage();
          if (page) {
            page.undo();
            return;
          }
          if (isMainFocused()) {
            broadcast("edit:undo");
            return;
          }
          BrowserWindow.getFocusedWindow()?.webContents.undo();
        },
      },
      {
        label: "Redo",
        accelerator: "Shift+CommandOrControl+Z",
        click: () => {
          const page = focusedBrowserPage();
          if (page) {
            page.redo();
            return;
          }
          if (isMainFocused()) {
            broadcast("edit:redo");
            return;
          }
          BrowserWindow.getFocusedWindow()?.webContents.redo();
        },
      },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
    // No plain Reload: ⌘R belongs to Sync Now. Force Reload (⇧⌘R) stays for
    // when the page really needs reloading.
    view: [
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
    // Through the mail's history, or a focused browser tab's.
    go: [
      {
        label: "Back",
        accelerator: "CommandOrControl+[",
        click: () => {
          const page = focusedBrowserPage();
          if (page) page.navigationHistory.goBack();
          else broadcast("nav:back");
        },
      },
      {
        label: "Forward",
        accelerator: "CommandOrControl+]",
        click: () => {
          const page = focusedBrowserPage();
          if (page) page.navigationHistory.goForward();
          else broadcast("nav:forward");
        },
      },
    ],
    mailbox: [
      // ⌘R refreshes mail like the sidebar's Sync button (with its spinner)
      // instead of reloading the page; see the View menu. In a focused
      // browser tab it reloads that page, as in a browser.
      {
        label: "Sync Now",
        accelerator: "CommandOrControl+R",
        click: () => {
          const page = focusedBrowserPage();
          if (page) {
            page.reload();
            return;
          }
          logger.info("main", "Menu: Sync Now");
          broadcast("mail:syncNow");
        },
      },
      {
        label: "Synchronize All Mailboxes",
        accelerator: "Shift+CommandOrControl+N",
        click: () => {
          logger.info("main", "Menu: Synchronize All Mailboxes");
          void invokeBackend("desktop:syncAll");
        },
      },
    ],
    help: [
      {
        label: "Send Feedback…",
        click: () => {
          requestSupportReport();
          void focusMainWindow().then(() => broadcast("support:open"));
        },
      },
    ],
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(hostOS.applicationMenu(items)));
}

// ── Lifecycle events ──────────────────────────────────────────────────
// Closing the window may leave the app running in the background, where mail
// keeps syncing and notifying, as long as the OS can bring the window back
// (HostOS.runsWithoutWindows).
app.on("window-all-closed", () => {
  if (!hostOS.runsWithoutWindows) app.quit();
});

app.on("activate", (_event, hasVisibleWindows) => {
  if (!hasVisibleWindows) void focusMainWindow();
});

app.on("will-quit", () => {
  // It stops the assistants' processes (Codex app-servers) on its way out.
  stopBackend();
});

// ── App ready ─────────────────────────────────────────────────────────
void app.whenReady().then(async () => {
  logger.info("main", "App ready", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
  });

  restoreThemeSource();
  hostOS.prepareSecrets();
  handleRendererProtocol();
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
  });

  setupBrowser();
  // The mail backend (@otter-mail/core) runs in its own process.
  await startBackend();
  registerHandlers();
  setupApplicationMenu();
  initUpdates();

  const startupSettings = (await invokeBackend("gmail:getSyncSettings")) as AppSettings;
  if (app.isPackaged) {
    hostOS.setLaunchAtLogin(startupSettings.launchAtLogin);
  }
  setDockBadgeEnabled(startupSettings.dockBadgeEnabled);

  try {
    await createMainWindow();
  } catch (error) {
    logger.error("main", "Failed to create main window", error);
  }
});
