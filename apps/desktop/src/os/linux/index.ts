/**
 * Linux (HostOS), Debian first: a frameless window with minimize, maximize
 * and close drawn over the top bar's right end, an XDG autostart entry, and
 * .desktop files and xdg-mime for mail and terminal apps.
 */

import { app, nativeTheme, safeStorage } from "electron";

import { logger } from "../../logger.js";
import { appIconImage } from "../../resources.js";
import type { HostOS } from "../types.js";
import { setAutostart } from "./autostart.js";
import { listMailApps, setDefaultMailApp } from "./mail-apps.js";
import { linuxTerminals } from "./terminals.js";
import { nativeMessagingDirectories } from "./native-messaging.js";

/** The renderer's --workspace-topbar-height: the window controls fill it. */
const TOPBAR_HEIGHT = 42;

/** The sidebar's surface (styles.css), shown until the page paints. */
const background = () => (nativeTheme.shouldUseDarkColors ? "#000000" : "#fafafa");
/** The window controls' glyphs: the renderer's muted foreground. */
const symbolColor = () => (nativeTheme.shouldUseDarkColors ? "#d4d4d4" : "#525252");

export const linuxOS: HostOS = {
  nativeMessagingDirectories,
  modifierKey: "ctrlKey",

  mainWindowOptions: () => ({
    // The top bar is the title bar: Electron draws the window controls over
    // its right end (the renderer leaves them room, styles.css), with the
    // page showing through behind them.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: symbolColor(), height: TOPBAR_HEIGHT },
    backgroundColor: background(),
    icon: appIconImage(),
  }),
  windowFollowsTheme(win) {
    const update = () => {
      win.setTitleBarOverlay({ color: "#00000000", symbolColor: symbolColor() });
      win.setBackgroundColor(background());
    };
    nativeTheme.on("updated", update);
    win.once("closed", () => nativeTheme.off("updated", update));
  },

  // The menu bar stays hidden (the window has no frame for it); its items
  // still answer their shortcuts. Settings, About and Quit sit where GNOME
  // and KDE apps keep them.
  applicationMenu: (items) => [
    {
      label: "&File",
      submenu: [
        { ...items.settings, accelerator: "Ctrl+," },
        { type: "separator" },
        ...items.file,
        { type: "separator" },
        { role: "quit", accelerator: "Ctrl+Q" },
      ],
    },
    { label: "&Edit", submenu: items.edit },
    { label: "&View", submenu: items.view },
    { label: "&Go", submenu: items.go },
    { label: "&Mailbox", submenu: items.mailbox },
    {
      label: "&Help",
      submenu: [...items.help, { type: "separator" }, items.checkForUpdates, items.about],
    },
  ],

  // Without a Dock to bring the window back, closing the last window quits.
  runsWithoutWindows: false,

  // dpkg needs the admin password (pkexec): ask when the user restarts to update.
  installsUpdatesOnQuit: false,

  /**
   * Secrets go in the desktop's keyring (GNOME Keyring, KWallet), which
   * Chromium picks by desktop. Desktops it doesn't know (i3, sway…) have none
   * for it: there, as Chrome does, they're sealed with a key of the app's
   * own, so the mailboxes still work (the files stay readable only by you).
   */
  prepareSecrets() {
    if (!safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
    logger.info("main", "Secrets", { store: safeStorage.getSelectedStorageBackend() });
  },

  setLaunchAtLogin(enabled) {
    // An unpackaged run would autostart Electron itself.
    if (!app.isPackaged) return;
    setAutostart(enabled, process.env.APPIMAGE ?? process.execPath);
  },
  // No Dock to badge.
  setBadge: () => {},

  mailApps: { list: listMailApps, setDefault: setDefaultMailApp },
  terminals: linuxTerminals,
};
