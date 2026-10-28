/**
 * Auto-update from GitHub Releases through electron-updater. The feed comes
 * from app-update.yml, which electron-builder writes from the publish config
 * (see scripts/build-desktop-artifact.ts). Stable and nightly are separate
 * feeds; Settings → General chooses which to follow on this computer.
 *
 * A new version downloads in the background as soon as it's found. The
 * sidebar then offers "Restart to update"; on macOS it also installs whenever
 * the app quits (⌘Q, Dock → Quit, logging out). On Linux the update is the
 * .deb, which dpkg installs with the admin password (HostOS).
 */

import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import * as fs from "node:fs";
import * as path from "node:path";

import { UPDATE_STATE_CHANNEL, type UpdateState, type UpdateChannel } from "@otter-mail/contracts";
import { releaseChannel, versionMatchesChannel } from "@otter-mail/shared/release-channel";

import { broadcast } from "./ipc.js";
import { logger } from "./logger.js";
import { hostOS } from "./os/index.js";

const { autoUpdater } = electronUpdater;

const STARTUP_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60 * 60_000;
const RELEASES_URL = "https://github.com/otterware-app/otterware/releases";

let state: UpdateState = {
  status: "idle",
  channel: releaseChannel(app.getVersion()),
  currentVersion: app.getVersion(),
  availableVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  manualDownloadUrl: null,
};

function setState(patch: Partial<UpdateState>): UpdateState {
  state = { ...state, ...patch };
  broadcast(UPDATE_STATE_CHANNEL, state);
  return state;
}

function disabledReason(): string | null {
  if (process.env.OTTER_MAIL_DISABLE_AUTO_UPDATE === "1") return "Updates are turned off.";
  if (!app.isPackaged) return "Updates only run in packaged builds.";
  if (!fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) {
    return "This build has no update feed.";
  }
  return null;
}

/** Squirrel.Mac only installs an update signed by the same Developer ID as the running app. */
function isSignatureError(err: Error): boolean {
  return /code signature|code requirement/i.test(err.message);
}

/** A short reason for the UI; the full error goes to the log. */
function describeError(err: Error): string {
  if (isSignatureError(err)) {
    return "This copy of Otter Mail isn't signed, so macOS won't install updates into it. Download the new version instead.";
  }
  if (/net::ERR_/.test(err.message))
    return "Couldn't reach GitHub. Otter Mail will try again later.";
  const firstLine = err.message.split("\n")[0] ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}

async function check(): Promise<UpdateState> {
  if (["disabled", "checking", "downloading"].includes(state.status)) return state;
  if (state.status === "downloaded" || state.manualDownloadUrl) return state;
  setState({ status: "checking", message: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // The "error" event has already reported it.
    if (state.status === "checking") {
      logger.warn("updates", "Update check failed", err);
      setState({ status: "error", message: describeError(asError(err)) });
    }
  }
  return state;
}

/** Retries a download that failed (normally it starts on its own). */
async function download(): Promise<UpdateState> {
  const failed = state.status === "error" && state.availableVersion && !state.manualDownloadUrl;
  if (state.status !== "available" && !failed) return state;
  setState({ status: "downloading", downloadPercent: 0, message: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    logger.warn("updates", "Update download failed", err);
    setState({ status: "error", message: describeError(asError(err)) });
  }
  return state;
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function configureChannel(channel: UpdateChannel): void {
  // Setting channel also enables downgrades in electron-updater: set it back
  // explicitly. A saved channel switch must still work after a failed check
  // or a restart, including returning from nightly to an older stable build.
  autoUpdater.channel = channel === "nightly" ? "nightly" : "latest";
  autoUpdater.allowPrerelease = channel === "nightly";
  autoUpdater.allowDowngrade =
    channel === "nightly" || releaseChannel(app.getVersion()) !== channel;
}

async function setChannel(channel: unknown): Promise<UpdateState> {
  if (channel !== "stable" && channel !== "nightly") throw new Error("Unknown update channel.");
  if (state.status === "disabled" || channel === state.channel) return state;
  if (["checking", "available", "downloading", "downloaded"].includes(state.status)) {
    throw new Error("Finish the current update before changing channels.");
  }
  fs.writeFileSync(
    path.join(app.getPath("userData"), "update-channel.json"),
    JSON.stringify(channel),
  );
  configureChannel(channel);
  setState({
    channel,
    status: "idle",
    availableVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    manualDownloadUrl: null,
  });
  return check();
}

export function initUpdates(): void {
  try {
    const chosen: unknown = JSON.parse(
      fs.readFileSync(path.join(app.getPath("userData"), "update-channel.json"), "utf8"),
    );
    if (chosen === "stable" || chosen === "nightly") state.channel = chosen;
  } catch {
    // First launch, or an invalid preference: follow the installed build.
  }
  ipcMain.handle("updates:getState", () => state);
  ipcMain.handle("updates:check", () => check());
  ipcMain.handle("updates:setChannel", (_event, channel: unknown) => setChannel(channel));
  ipcMain.handle("updates:download", () => download());
  ipcMain.handle("updates:install", () => {
    if (
      state.status !== "downloaded" ||
      !state.availableVersion ||
      !versionMatchesChannel(state.availableVersion, state.channel)
    )
      return;
    logger.info("updates", "Restarting to install", { version: state.availableVersion });
    autoUpdater.quitAndInstall(true, true);
  });

  const reason = disabledReason();
  if (reason) {
    setState({ status: "disabled", message: reason });
    return;
  }

  autoUpdater.logger = null;
  // Validate the offered version's channel before starting its download.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = hostOS.installsUpdatesOnQuit;
  configureChannel(state.channel);

  autoUpdater.on("update-available", (info) => {
    if (!versionMatchesChannel(info.version, state.channel)) {
      logger.warn("updates", "Ignoring an update from another channel", {
        version: info.version,
        channel: state.channel,
      });
      setState({ status: "up-to-date", availableVersion: null, checkedAt: Date.now() });
      return;
    }
    setState({
      status: "available",
      availableVersion: info.version,
      downloadPercent: 0,
      checkedAt: Date.now(),
    });
    void download();
  });
  autoUpdater.on("update-not-available", () => {
    setState({ status: "up-to-date", availableVersion: null, checkedAt: Date.now() });
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    // Only every 5%: the renderer re-renders on each push.
    if (state.downloadPercent == null || percent - state.downloadPercent >= 5) {
      setState({ status: "downloading", downloadPercent: percent });
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (!versionMatchesChannel(info.version, state.channel)) return;
    setState({ status: "downloaded", availableVersion: info.version, downloadPercent: 100 });
  });
  autoUpdater.on("error", (err) => {
    // A repository without any release yet.
    if (/No published versions/i.test(err.message)) {
      setState({ status: "up-to-date", availableVersion: null, checkedAt: Date.now() });
      return;
    }
    logger.warn("updates", "Updater error", err);
    setState({
      status: "error",
      message: describeError(err),
      manualDownloadUrl:
        isSignatureError(err) && state.availableVersion
          ? `${RELEASES_URL}/tag/otterware-mail-v${state.availableVersion}`
          : state.manualDownloadUrl,
    });
  });

  setTimeout(() => void check(), STARTUP_DELAY_MS);
  setInterval(() => void check(), POLL_INTERVAL_MS);
}
