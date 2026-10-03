import { BrowserWindow, ipcMain } from "electron";

import { logger } from "../logger.js";
import { clearBrowsingData } from "../services/browser.js";
import {
  extensionActions,
  listExtensions,
  loadUnpacked,
  removeExtension,
  runAction,
  setActiveTab,
  setExtensionEnabled,
} from "../services/extensions.js";

/** Settings › Extensions and › Browser, and the browser toolbar: extensions and browsing data. */
export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:extensions", () => listExtensions());

  ipcMain.handle("browser:removeExtension", async (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid parameters for browser:removeExtension.");
    logger.info("browser", "Remove extension", { id });
    await removeExtension(id);
  });

  ipcMain.handle("browser:setExtensionEnabled", async (_event, params: unknown) => {
    const { id, enabled } = (params ?? {}) as { id?: unknown; enabled?: unknown };
    if (typeof id !== "string" || typeof enabled !== "boolean") {
      throw new Error("Invalid parameters for browser:setExtensionEnabled.");
    }
    await setExtensionEnabled(id, enabled);
  });

  ipcMain.handle("browser:loadUnpacked", (event) =>
    loadUnpacked(BrowserWindow.fromWebContents(event.sender)),
  );

  // The toolbar: its buttons for the page showing, and one clicked.
  ipcMain.handle("browser:extensionActions", () => extensionActions());

  ipcMain.handle("browser:runAction", (_event, params: unknown) => {
    const { id, anchor } = (params ?? {}) as {
      id?: unknown;
      anchor?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    };
    const box = [anchor?.x, anchor?.y, anchor?.width, anchor?.height];
    if (typeof id !== "string" || !box.every((n) => typeof n === "number")) {
      throw new Error("Invalid parameters for browser:runAction.");
    }
    const [x, y, width, height] = box as number[];
    runAction(id, { x: x!, y: y!, width: width!, height: height! });
  });

  // The page showing in the panel: the active tab, to extensions.
  ipcMain.handle("browser:activeTab", (_event, webContentsId: unknown) => {
    if (typeof webContentsId === "number") setActiveTab(webContentsId);
  });

  ipcMain.handle("browser:clearData", async (_event, params: unknown) => {
    const origin = (params as { origin?: unknown } | undefined)?.origin;
    if (origin !== undefined && (typeof origin !== "string" || !/^https?:\/\//.test(origin))) {
      throw new Error("Invalid parameters for browser:clearData.");
    }
    logger.info("browser", "Clear browsing data", { origin: origin ?? "all" });
    await clearBrowsingData(origin);
  });
}
