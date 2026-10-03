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
import { configureAppPaths } from "./paths.js";
import { focusedBrowserPage, setupBrowser } from "./services/browser.js";
import { parseMailtoUrl, setPendingMailto } from "./services/mailto-target.js";
import { createTray, destroyTray } from "./services/tray.js";
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
// Clicking a mailto link anywhere in macOS lands here once Otter Mail is the
// default mail app. Stash the parsed target (the renderer pulls it via
// app:takePendingMailto on mount — covers cold starts) and nudge any live
// main window via broadcast. Registered before `ready`: cold starts deliver
// the URL early.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const target = parseMailtoUrl(url);
  logger.info("main", "open-url", { mailto: target != null });
  if (!target) return;
  setPendingMailto(target);
  if (app.isReady()) {
    void focusMainWindow().then(() => broadcast("compose:mailto"));
  }
});

app.on("second-instance", () => {
  void focusMainWindow();
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
function setupApplicationMenu(): void {
  const isMainFocused = () => {
    const focused = BrowserWindow.getFocusedWindow();
    return focused != null && focused === getMainWindow();
  };

  const menu = Menu.buildFromTemplate([
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates…",
          click: () => {
            void focusMainWindow().then(() => broadcast("updates:checkRequested"));
          },
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "Command+,",
          click: async () => {
            setSettingsTarget({});
            await focusMainWindow();
            broadcast("settings:open");
          },
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        // Otter Code's ⌘W: closes the active chat tab first; the window only
        // closes once there's no tab left to close. The main window decides
        // (window:closeRequest → agent tab, or window:closeMain).
        {
          label: "Close",
          accelerator: "Command+W",
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
          accelerator: "Command+T",
          click: (_item, _window, event) => {
            if (event.triggeredByAccelerator) {
              if (isMainFocused())
                getMainWindow()?.webContents.send("keybindings:keydown", {
                  key: "t",
                  metaKey: true,
                });
              return;
            }
            void focusMainWindow().then(() => broadcast("browser:newTab"));
          },
        },
        {
          label: "Open Location…",
          accelerator: "Command+L",
          click: () => void focusMainWindow().then(() => broadcast("browser:focusAddress")),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
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
        { type: "separator" },
        {
          label: "Speech",
          submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
        },
      ],
    },
    {
      // No plain Reload: ⌘R belongs to Sync Now. Force Reload (⇧⌘R) stays for
      // when the page really needs reloading.
      label: "View",
      submenu: [
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Go",
      // Through the mail's history, or a focused browser tab's.
      submenu: [
        {
          label: "Back",
          accelerator: "Command+[",
          click: () => {
            const page = focusedBrowserPage();
            if (page) page.navigationHistory.goBack();
            else broadcast("nav:back");
          },
        },
        {
          label: "Forward",
          accelerator: "Command+]",
          click: () => {
            const page = focusedBrowserPage();
            if (page) page.navigationHistory.goForward();
            else broadcast("nav:forward");
          },
        },
      ],
    },
    {
      label: "Mailbox",
      submenu: [
        // ⌘R refreshes mail like the sidebar's Sync button (with its spinner)
        // instead of reloading the page; see the View menu below. In a
        // focused browser tab it reloads that page, as in a browser.
        {
          label: "Sync Now",
          accelerator: "Command+R",
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
          accelerator: "Shift+Command+N",
          click: () => {
            logger.info("main", "Menu: Synchronize All Mailboxes");
            void invokeBackend("tray:sync");
          },
        },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Send Feedback…",
          click: () => {
            requestSupportReport();
            void focusMainWindow().then(() => broadcast("support:open"));
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Lifecycle events ──────────────────────────────────────────────────
// As in T3 Code: closing the window (⌘W, the red button) leaves the app
// running in the background, where mail keeps syncing and notifying; the Dock
// icon or the menu bar brings the window back. ⌘Q quits.
app.on("window-all-closed", () => {});

app.on("activate", (_event, hasVisibleWindows) => {
  if (!hasVisibleWindows) void focusMainWindow();
});

app.on("will-quit", () => {
  destroyTray();
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
    app.setLoginItemSettings({ openAtLogin: startupSettings.launchAtLogin });
  }
  if (startupSettings.trayEnabled) {
    void createTray();
  }
  setDockBadgeEnabled(startupSettings.dockBadgeEnabled);

  try {
    await createMainWindow();
  } catch (error) {
    logger.error("main", "Failed to create main window", error);
  }
});
