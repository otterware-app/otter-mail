/**
 * Registers the IPC handlers the main process serves itself (the mail
 * backend's channels are forwarded to it by backend-host.ts).
 */

import { app, ipcMain, nativeImage } from "electron";

import { invokeBackend, tempFile } from "../backend-host.js";
import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { hostOS } from "../os/index.js";
import { takePendingMailto } from "../services/mailto-target.js";
import { takePendingOpenMessage } from "../services/open-message-target.js";
import { focusMainWindow } from "../windows/main-window.js";
import { setSettingsTarget, takeSettingsTarget } from "../windows/settings-window.js";
import { registerSupportHandlers } from "./support.js";
import { registerBrowserHandlers } from "./browser.js";

export function registerHandlers(): void {
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
      p?.pane === "otter"
        ? p.pane
        : undefined;
    setSettingsTarget({ pane });
    await focusMainWindow();
    broadcast("settings:open");
  });

  ipcMain.handle("window:getSettingsTarget", async () => takeSettingsTarget());

  // A conversation a notification asked the main window to open.
  ipcMain.handle("window:takePendingOpenMessage", async () => takePendingOpenMessage());

  // Default-mail-app plumbing: the renderer pulls pending mailto targets on
  // mount and on the compose:mailto broadcast; Settings offers a "set as
  // default" button (macOS shows its own consent dialog; Linux asks xdg-settings).
  ipcMain.handle("app:takePendingMailto", async () => takePendingMailto());

  ipcMain.handle("app:getDefaultMailStatus", async () => {
    const isDefault = app.isDefaultProtocolClient("mailto");
    return { isDefault };
  });

  // Without an id this registers Otter Mail itself; with one it hands the
  // default to that app instead (the Settings dropdown; HostOS.mailApps).
  ipcMain.handle("app:setDefaultMailApp", async (_event, params: unknown) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id.length > 0) {
      await hostOS.mailApps.setDefault(id);
      logger.info("handlers", "setDefaultMailApp", { id });
      return { ok: true };
    }
    const ok = app.setAsDefaultProtocolClient("mailto");
    logger.info("handlers", "setDefaultMailApp", { ok });
    return { ok };
  });

  ipcMain.handle("app:listMailApps", async () => hostOS.mailApps.list());

  // gmail:dragAttachment — native drag-out to the file manager (startDrag needs a real file on disk)
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

  registerSupportHandlers();

  logger.info("handlers", "✓ IPC handlers registered");
}
