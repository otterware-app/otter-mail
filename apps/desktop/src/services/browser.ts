/**
 * The browser in the agent panel: the renderer's `<webview>` tabs, in one
 * persistent session of their own (never the app's), with extensions from the
 * Chrome Web Store (electron-chrome-web-store installs them; extensions.ts
 * gives them Chrome's toolbar and tabs). Around a page it does what Chrome
 * does: links that open a tab, sign-in popups, links to other apps, the
 * context menu, and asking before a site gets more than the basics.
 */

import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  session,
  shell,
  webContents,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { installChromeWebStore } from "electron-chrome-web-store";
import * as path from "node:path";

import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { extensionMenuItems, reachOf, setupExtensions, trackTab } from "./extensions.js";
import { parseMailtoUrl, setPendingMailto } from "./mailto-target.js";
import { hostOS } from "../os/index.js";

export const BROWSER_PARTITION = "persist:browser";

/** What a page may use without asking; anything else (camera, location, notifications…) is refused. */
const ALLOWED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

/** Where a tab may go: the web, and extensions' own pages (their options). */
export function isPageUrl(url: string): boolean {
  return /^(https?|chrome-extension):/i.test(url);
}

export function getBrowserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION);
}

/** Sets up the browser's session and its extensions. Once, before the main window opens. */
export function setupBrowser(): void {
  // Electron's own user agent stays, less its Electron/x: Google's sign-in gives
  // agents that name Electron a lite page that never offers your passkeys (as
  // 1Password's) until you ask. A whole new string drops the client hints
  // Chromium sends with it, and Google's sign-in turns that mismatch away.
  const ses = getBrowserSession();
  ses.setUserAgent(ses.getUserAgent().replace(/ Electron\/\S+/, ""));
  ses.setPermissionRequestHandler((page, permission, callback, details) => {
    if (permission === "openExternal" && "externalURL" in details && details.externalURL) {
      void openOutside(page, details.externalURL);
      callback(false);
      return;
    }
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_page, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.extensions.on("extension-loaded", () => broadcast("browser:extensionsChanged"));
  ses.extensions.on("extension-unloaded", () => broadcast("browser:extensionsChanged"));
  // Before any extension loads, so each worker and page gets its chrome.action.
  setupExtensions(path.join(__dirname, "extensions-preload.cjs"));
  installChromeWebStore({ session: ses, beforeInstall: confirmInstall }).catch((error: unknown) =>
    logger.error("browser", "Chrome Web Store setup failed", { error: String(error) }),
  );
}

/**
 * A link a page hands to another app. mailto: is ours: it opens a new message
 * here. Anything else asks first, as Chrome does.
 */
async function openOutside(page: WebContents, url: string): Promise<void> {
  const mailto = parseMailtoUrl(url);
  if (mailto) {
    setPendingMailto(mailto);
    broadcast("compose:mailto");
    return;
  }
  const appName = app.getApplicationNameForProtocol(url);
  if (!appName) return;
  const window = BrowserWindow.fromWebContents(page.hostWebContents ?? page);
  const options = {
    type: "question" as const,
    message: `Open ${appName}?`,
    detail: `${URL.parse(page.getURL())?.host || "This page"} wants to open this link in ${appName}.`,
    buttons: [`Open ${appName}`, "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (response === 0) await shell.openExternal(url);
}

/** The Web Store's "Add to Chrome": asks before anything is installed. */
async function confirmInstall(details: {
  localizedName: string;
  manifest: Parameters<typeof reachOf>[0];
  icon: Electron.NativeImage;
  browserWindow?: BrowserWindow;
}): Promise<{ action: "allow" | "deny" }> {
  const window = details.browserWindow ?? BrowserWindow.getFocusedWindow();
  const options = {
    message: `Add “${details.localizedName}”?`,
    detail: reachOf(details.manifest),
    icon: details.icon.isEmpty() ? undefined : details.icon,
    buttons: ["Add Extension", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  logger.info("browser", "Extension install", {
    name: details.localizedName,
    allowed: response === 0,
  });
  return { action: response === 0 ? "allow" : "deny" };
}

/**
 * Signs out of every site: cookies, site storage and the cache go; extensions
 * (and their service workers) stay. With `origin`, just that site's.
 */
export async function clearBrowsingData(origin?: string): Promise<void> {
  const ses = getBrowserSession();
  await ses.clearStorageData({
    ...(origin ? { origin } : {}),
    storages: ["cookies", "filesystem", "indexdb", "localstorage", "cachestorage"],
  });
  if (!origin) {
    await ses.clearCache();
    await ses.clearAuthCache();
  }
}

/** The browser page with keyboard focus, if any: the menus' ⌘Z, ⌘R, ⌘[ and ⌘] act on it. */
export function focusedBrowserPage(): WebContents | null {
  const focused = webContents.getFocusedWebContents();
  return focused && focused.getType() === "webview" && focused.session === getBrowserSession()
    ? focused
    : null;
}

/** Lets `win` host browser tabs: only in the browser's session, with nothing of the app's in them. */
export function attachBrowser(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (event, prefs, params) => {
    if (params.partition !== BROWSER_PARTITION || !isPageUrl(params.src ?? "")) {
      event.preventDefault();
      return;
    }
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.nodeIntegrationInSubFrames = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    prefs.webviewTag = false;
    prefs.scrollBounce = true;
  });
  win.webContents.on("did-attach-webview", (_event, page) => {
    preparePage(win, page);
    trackTab(page);
    // A focused guest page's keys never reach the panel's dispatcher.
    page.on("before-input-event", (event, input) => {
      // Panel visibility and expansion shortcuts, even while a page has focus.
      const mod = hostOS.modifierKey === "metaKey";
      const key = input.key.toLowerCase();
      if (
        input.type === "keyDown" &&
        (key === "b" || key === "f") &&
        (mod ? input.meta && !input.control : input.control && !input.meta) &&
        input.shift &&
        !input.alt
      ) {
        event.preventDefault();
        if (!win.isDestroyed())
          win.webContents.send("keybindings:keydown", {
            key,
            [hostOS.modifierKey]: true,
            shiftKey: true,
          });
        return;
      }
      if (
        input.type !== "keyDown" ||
        input.key !== "Tab" ||
        !input.control ||
        input.meta ||
        input.alt ||
        input.shift
      )
        return;
      event.preventDefault();
      if (!win.isDestroyed()) win.webContents.send("browser:previousTab");
    });
  });
}

/** Opens `url` in a new tab of `win`'s browser (the renderer's `browser:openTab`). */
function openTab(win: BrowserWindow, url: string, background = false): void {
  if (!isPageUrl(url) || win.isDestroyed()) return;
  win.webContents.send("browser:openTab", { url, background });
}

/** Chrome's ways around a page: links to tabs, popups, the context menu. */
export function preparePage(win: BrowserWindow, page: WebContents): void {
  page.setWindowOpenHandler(({ url, disposition }) => {
    // A popup (a site's sign-in window) stays one: it reports back to its opener.
    if (disposition === "new-window" && isPageUrl(url)) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 520, height: 680 } };
    }
    openTab(win, url, disposition === "background-tab");
    return { action: "deny" };
  });
  page.on("did-create-window", (popup) => preparePage(win, popup.webContents));
  page.on("context-menu", (_event, params) => {
    Menu.buildFromTemplate(contextMenu(win, page, params)).popup({ window: win });
  });
}

/** Chrome's context menu, the parts that fit: links, images, text, then the page. */
function contextMenu(
  win: BrowserWindow,
  page: WebContents,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];
  if (params.linkURL && isPageUrl(params.linkURL)) {
    groups.push([
      { label: "Open Link in New Tab", click: () => openTab(win, params.linkURL, true) },
      {
        label: "Open Link in Default Browser",
        click: () => void shell.openExternal(params.linkURL),
      },
      { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
    ]);
  }
  if (params.mediaType === "image" && params.srcURL) {
    groups.push([
      { label: "Open Image in New Tab", click: () => openTab(win, params.srcURL, true) },
      { label: "Copy Image", click: () => page.copyImageAt(params.x, params.y) },
      { label: "Copy Image Address", click: () => clipboard.writeText(params.srcURL) },
    ]);
  }
  const selection = params.selectionText.trim();
  if (params.isEditable) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    if (suggestions.length > 0) {
      groups.push(
        suggestions.map((word) => ({ label: word, click: () => page.replaceMisspelling(word) })),
      );
    }
    groups.push([
      { label: "Cut", enabled: params.editFlags.canCut, click: () => page.cut() },
      { label: "Copy", enabled: params.editFlags.canCopy, click: () => page.copy() },
      { label: "Paste", enabled: params.editFlags.canPaste, click: () => page.paste() },
      { label: "Select All", click: () => page.selectAll() },
    ]);
  } else if (selection) {
    const quoted = selection.length > 30 ? `${selection.slice(0, 30)}…` : selection;
    groups.push([
      { label: "Copy", click: () => page.copy() },
      {
        label: `Search Google for “${quoted}”`,
        click: () =>
          openTab(win, `https://www.google.com/search?q=${encodeURIComponent(selection)}`),
      },
    ]);
  }
  if (groups.length === 0) {
    const history = page.navigationHistory;
    groups.push([
      { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
      { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
      { label: "Reload", click: () => page.reload() },
    ]);
  }
  const fromExtensions = extensionMenuItems(page, params);
  if (fromExtensions.length > 0) groups.push(fromExtensions);
  groups.push([{ label: "Inspect Element", click: () => page.inspectElement(params.x, params.y) }]);
  return groups.flatMap((group, i) => (i === 0 ? group : [{ type: "separator" }, ...group]));
}
