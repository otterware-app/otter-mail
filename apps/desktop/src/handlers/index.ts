/**
 * Registers the IPC handlers the main process serves itself (the mail
 * backend's channels are forwarded to it by backend-host.ts).
 */

import { app, ipcMain, nativeImage } from "electron";

import { invokeBackend, tempFile } from "../backend-host.js";
import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { listMailApps, setDefaultMailHandler } from "../services/default-mail.js";
import { takePendingMailto } from "../services/mailto-target.js";
import { takePendingOpenMessage } from "../services/open-message-target.js";
import { focusMainWindow } from "../windows/main-window.js";
import { setSettingsTarget, takeSettingsTarget } from "../windows/settings-window.js";
import { registerTrayPopoverHandlers } from "./tray-popover.js";
import { registerSupportHandlers } from "./support.js";
import { registerAppIconHandlers } from "./app-icon.js";
import { registerBrowserHandlers } from "./browser.js";

export function registerHandlers(): void {
  registerAppIconHandlers();
  registerBrowserHandlers();
  // Settings live in the main window. Any window can deep-link into a pane;
  // the main window pulls the target on mount and whenever settings:open is
  // broadcast.
  ipcMain.handle("window:openSettings", async (_event, params: unknown) => {
    const p = params as { pane?: unknown } | undefined;
    const pane =
      p?.pane === "general" ||
      p?.pane === "appearance" ||
      p?.pane === "accounts" ||
      p?.pane === "keybindings" ||
      p?.pane === "agents" ||
      p?.pane === "integrations" ||
      p?.pane === "browser" ||
      p?.pane === "extensions" ||
      p?.pane === "otter"
        ? p.pane
        : undefined;
    setSettingsTarget({ pane });
    await focusMainWindow();
    broadcast("settings:open");
  });

  ipcMain.handle("window:getSettingsTarget", async () => takeSettingsTarget());

  // A conversation the menu-bar popover asked the main window to open.
  ipcMain.handle("window:takePendingOpenMessage", async () => takePendingOpenMessage());

  // Default-mail-app plumbing: the renderer pulls pending mailto targets on
  // mount and on the compose:mailto broadcast; Settings offers a "set as
  // default" button (macOS shows its own consent dialog).
  ipcMain.handle("app:takePendingMailto", async () => takePendingMailto());

  ipcMain.handle("app:getDefaultMailStatus", async () => {
    const isDefault = app.isDefaultProtocolClient("mailto");
    return { isDefault };
  });

  // Without a bundleId this registers Otter Mail itself (macOS consent
  // dialog); with one it hands the default to that app instead
  // (Settings dropdown, LaunchServices via JXA).
  ipcMain.handle("app:setDefaultMailApp", async (_event, params: unknown) => {
    const bundleId = (params as { bundleId?: unknown } | undefined)?.bundleId;
    if (typeof bundleId === "string" && bundleId.length > 0) {
      await setDefaultMailHandler(bundleId);
      logger.info("handlers", "setDefaultMailApp", { bundleId });
      return { ok: true };
    }
    const ok = app.setAsDefaultProtocolClient("mailto");
    logger.info("handlers", "setDefaultMailApp", { ok });
    return { ok };
  });

  ipcMain.handle("app:listMailApps", async () => listMailApps());

  // gmail:dragAttachment — native drag-out to Finder (startDrag needs a real file on disk)
  ipcMain.handle("gmail:dragAttachment", async (event, params: unknown) => {
    const p = params as Record<string, unknown> | undefined;
    const { accountId, messageId, attachmentId, filename, taskId } = p ?? {};
    if (
      typeof accountId !== "string" ||
      typeof messageId !== "string" ||
      typeof attachmentId !== "string" ||
      typeof filename !== "string"
    ) {
      throw new Error("Invalid parameters for gmail:dragAttachment.");
    }
    const drag = async () => {
      const bytes = (await invokeBackend("desktop:attachmentBytes", {
        accountId,
        messageId,
        attachmentId,
      })) as Uint8Array;
      const file = await tempFile(filename, bytes);
      const icon = await nativeImage
        .createThumbnailFromPath(file, { width: 64, height: 64 })
        .catch(() => nativeImage.createEmpty());
      // Electron requires a non-empty drag image.
      event.sender.startDrag({
        file,
        icon: icon.isEmpty() ? await app.getFileIcon(file, { size: "normal" }) : icon,
      });
      return { ok: true };
    };
    // With a taskId (core's runAsTask): answer at once, the outcome follows as task:done.
    if (typeof taskId !== "string") return drag();
    void drag().then(
      (result) => broadcast("task:done", { taskId, result }),
      (err: unknown) =>
        broadcast("task:done", { taskId, error: err instanceof Error ? err.message : String(err) }),
    );
    return { accepted: true };
  });

  registerTrayPopoverHandlers();
  registerSupportHandlers();

  logger.info("handlers", "✓ IPC handlers registered");
}
