import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  version: "0.13.9",
  directory: "",
  ipc: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => void>(),
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  updater: { channel: "latest", allowPrerelease: false, allowDowngrade: false, autoDownload: true },
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => fixture.version, getPath: () => fixture.directory },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => fixture.ipc.set(name, handler),
  },
}));
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: Object.assign(fixture.updater, {
      checkForUpdates: fixture.check,
      downloadUpdate: fixture.download,
      quitAndInstall: fixture.install,
      on: (event: string, listener: (...args: any[]) => void) =>
        fixture.events.set(event, listener),
    }),
  },
}));
vi.mock("./ipc.js", () => ({ broadcast: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("./os/index.js", () => ({ hostOS: { installsUpdatesOnQuit: true } }));

const nightly = "0.13.10-nightly.20261013.123";
const state = () => fixture.ipc.get("updates:getState")!();
const choose = (channel: unknown) => fixture.ipc.get("updates:setChannel")!(null, channel);
const emit = (event: string, info: object) => fixture.events.get(event)!(info);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  fixture.directory = mkdtempSync(join(tmpdir(), "otter-mail-updates-"));
  fixture.version = "0.13.9";
  fixture.ipc.clear();
  fixture.events.clear();
  fixture.check.mockResolvedValue(null);
  fixture.download.mockResolvedValue([]);
  writeFileSync(join(fixture.directory, "app-update.yml"), "provider: github");
  vi.stubGlobal("process", { ...process, resourcesPath: fixture.directory });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(fixture.directory, { recursive: true, force: true });
});

async function start(version = "0.13.9") {
  fixture.version = version;
  const { initUpdates } = await import("./updates.js");
  initUpdates();
}

describe("desktop update channels", () => {
  it("defaults to the installed build, with separate stable and nightly feeds", async () => {
    await start(nightly);
    expect(state().channel).toBe("nightly");
    expect(fixture.updater).toMatchObject({
      channel: "nightly",
      allowPrerelease: true,
      autoDownload: false,
    });
  });

  it("persists an explicit choice and can return from nightly to an older stable version", async () => {
    await start(nightly);
    fixture.check.mockImplementation(async () => {
      expect(fixture.updater.allowDowngrade).toBe(true);
      emit("update-available", { version: "0.13.9" });
    });
    await choose("stable");
    expect(JSON.parse(readFileSync(join(fixture.directory, "update-channel.json"), "utf8"))).toBe(
      "stable",
    );
    expect(fixture.updater).toMatchObject({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: true,
    });
    expect(fixture.download).toHaveBeenCalledOnce();
    emit("update-downloaded", { version: "0.13.9" });
    fixture.ipc.get("updates:install")!();
    expect(fixture.install).toHaveBeenCalledWith(true, true);
    await start(nightly);
    expect(state().channel).toBe("stable");
    expect(fixture.updater.allowDowngrade).toBe(true);
    await start("0.13.9");
    expect(fixture.updater.allowDowngrade).toBe(false);
  });

  it("never downloads a version from another channel or an unsupported prerelease", async () => {
    await start();
    for (const version of [nightly, "0.13.10-rc.1"]) emit("update-available", { version });
    expect(fixture.download).not.toHaveBeenCalled();
    expect(state().availableVersion).toBeNull();
    await choose("nightly");
    emit("update-available", { version: "0.13.9" });
    expect(fixture.download).not.toHaveBeenCalled();
    emit("update-available", { version: nightly });
    expect(fixture.download).toHaveBeenCalledOnce();
  });

  it("refuses a channel switch during a check, download or pending install", async () => {
    await start();
    const checking = fixture.ipc.get("updates:check")!();
    await expect(choose("nightly")).rejects.toThrow("Finish the current update");
    await checking;
    emit("update-available", { version: "0.13.10" });
    await expect(choose("nightly")).rejects.toThrow("Finish the current update");
    emit("update-downloaded", { version: "0.13.10" });
    await expect(choose("nightly")).rejects.toThrow("Finish the current update");
    await expect(choose("beta")).rejects.toThrow("Unknown update channel");
  });

  it("uses the build default when a saved preference is invalid", async () => {
    writeFileSync(join(fixture.directory, "update-channel.json"), '"beta"');
    await start();
    expect(state().channel).toBe("stable");
    expect(fixture.updater).toMatchObject({
      channel: "latest",
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });
});
