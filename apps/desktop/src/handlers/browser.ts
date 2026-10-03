import { ipcMain } from "electron";

import { logger } from "../logger.js";
import { clearBrowsingData, listExtensions, removeExtension } from "../services/browser.js";

/** Settings › Browser and the browser toolbar: extensions and browsing data. */
export function registerBrowserHandlers(): void {
  ipcMain.handle("browser:extensions", () => listExtensions());

  ipcMain.handle("browser:removeExtension", async (_event, id: unknown) => {
    if (typeof id !== "string") throw new Error("Invalid parameters for browser:removeExtension.");
    logger.info("browser", "Remove extension", { id });
    await removeExtension(id);
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
