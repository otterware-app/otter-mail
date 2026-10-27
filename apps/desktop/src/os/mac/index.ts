/**
 * macOS (HostOS): a window with traffic lights, the app menu, the Dock, and
 * LaunchServices for mail and terminal apps.
 */

import { app, nativeTheme } from "electron";

import type { HostOS } from "../types.js";
import { listMailApps, setDefaultMailApp } from "./mail-apps.js";
import { macTerminals } from "./terminals.js";
import { nativeMessagingDirectories } from "./native-messaging.js";

/** The renderer's --workspace-topbar-height: the traffic lights sit centered in it. */
const TOPBAR_HEIGHT = 42;
const WINDOW_BUTTON_RADIUS = 7;

/** The frame's surface (styles.css, --sidebar-surface), shown until the page paints. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#0c0c0e" : "#ededf0");

export const macOS: HostOS = {
  nativeMessagingDirectories,
  modifierKey: "metaKey",

  mainWindowOptions: () => ({
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: TOPBAR_HEIGHT / 2 - WINDOW_BUTTON_RADIUS },
    // Solid, like the frame the renderer paints over it.
    backgroundColor: background(),
    webPreferences: {
      // macOS rubber-banding, off in Electron by default: scrollers (the
      // mailbox pages' swipe included) stretch past their ends, harder
      // the further, like any Mac app.
      scrollBounce: true,
    },
  }),
  // The traffic lights follow the system's appearance on their own; the
  // background follows the app's.
  windowFollowsTheme(win) {
    const update = () => win.setBackgroundColor(background());
    nativeTheme.on("updated", update);
    win.once("closed", () => nativeTheme.off("updated", update));
  },

  applicationMenu: (items) => [
    {
      label: app.getName(),
      submenu: [
        items.about,
        items.checkForUpdates,
        { type: "separator" },
        { ...items.settings, accelerator: "Command+," },
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
    { label: "File", submenu: items.file },
    {
      label: "Edit",
      submenu: [
        ...items.edit,
        { type: "separator" },
        { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] },
      ],
    },
    { label: "View", submenu: items.view },
    { label: "Go", submenu: items.go },
    { label: "Mailbox", submenu: items.mailbox },
    { role: "windowMenu" },
    { role: "help", submenu: items.help },
  ],

  // As in T3 Code: closing the window (⌘W, the red button) leaves the app
  // running, where mail keeps syncing and notifying; the Dock icon brings the
  // window back. ⌘Q quits.
  runsWithoutWindows: true,

  installsUpdatesOnQuit: true,

  // The Keychain is always there.
  prepareSecrets: () => {},

  setLaunchAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
  setBadge: (count) => app.dock?.setBadge(count > 0 ? String(count) : ""),

  mailApps: { list: listMailApps, setDefault: setDefaultMailApp },
  terminals: macTerminals,
};
