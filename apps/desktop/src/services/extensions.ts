/**
 * The browser's extensions, beyond what Electron runs by itself: the toolbar
 * (Chrome's `chrome.action`: an icon, a badge, a popup or a click), the tab
 * strip as extensions see it (`chrome.tabs`, `chrome.windows`), and turning
 * one off, on, or away. Extensions call in through extensions-preload.ts;
 * the renderer's toolbar through the `browser:` channels (handlers/browser.ts).
 *
 * Tabs are the agent panel's pages (webview guests), each known by its
 * webContents id; the main window is the one window.
 */

import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  webFrameMain,
  type ContextMenuParams,
  type Extension,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
  type ServiceWorkerMain,
  type Session,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { uninstallExtension } from "electron-chrome-web-store";
import * as fs from "node:fs";
import * as path from "node:path";

import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { getMainWindow } from "../windows/main-window.js";
import { getBrowserSession, isPageUrl, preparePage } from "./browser.js";

/** The parts of an extension's manifest.json read here. */
type Manifest = {
  description?: string;
  homepage_url?: string;
  icons?: { [size: number]: string };
  action?: {
    default_title?: string;
    default_icon?: string | { [size: number]: string };
    default_popup?: string;
  };
  options_page?: string;
  options_ui?: { page?: string };
  permissions?: string[];
  host_permissions?: string[];
  commands?: Record<string, { description?: string; suggested_key?: Record<string, string> }>;
  background?: { service_worker?: string };
  key?: string;
};

const manifestOf = (extension: Extension) => extension.manifest as Manifest;

// ── Tabs ─────────────────────────────────────────────────────────────

const tabs = new Map<number, { contents: WebContents; favicon: string | null }>();
let activeTabId = -1;

/** A page can show its address to extensions that may read it (Chrome's rule). */
function seesPage(extensionId: string | null, tabId: number): boolean {
  if (!extensionId) return true;
  const manifest = getBrowserSession().extensions.getExtension(extensionId)?.manifest as
    | Manifest
    | undefined;
  if (!manifest) return false;
  const permissions = manifest.permissions ?? [];
  return (
    permissions.includes("tabs") ||
    (manifest.host_permissions ?? []).length > 0 ||
    (permissions.includes("activeTab") && tabId === activeTabId)
  );
}

function tabOf(tabId: number, extensionId: string | null = null) {
  const entry = tabs.get(tabId);
  if (!entry || entry.contents.isDestroyed()) return null;
  const { contents, favicon } = entry;
  const window = getMainWindow();
  const sees = seesPage(extensionId, tabId);
  return {
    id: tabId,
    index: [...tabs.keys()].indexOf(tabId),
    windowId: window?.id ?? -1,
    active: tabId === activeTabId,
    highlighted: tabId === activeTabId,
    selected: tabId === activeTabId,
    pinned: false,
    incognito: false,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    groupId: -1,
    status: contents.isLoading() ? "loading" : "complete",
    audible: contents.isCurrentlyAudible(),
    mutedInfo: { muted: contents.isAudioMuted() },
    ...(sees
      ? { url: contents.getURL(), title: contents.getTitle(), favIconUrl: favicon ?? undefined }
      : {}),
  };
}

function windowOf(window: BrowserWindow, populate = false, extensionId: string | null = null) {
  const bounds = window.getBounds();
  const main = window === getMainWindow();
  return {
    id: window.id,
    focused: window.isFocused(),
    top: bounds.y,
    left: bounds.x,
    width: bounds.width,
    height: bounds.height,
    incognito: false,
    alwaysOnTop: false,
    type: main ? "normal" : "popup",
    state: window.isFullScreen()
      ? "fullscreen"
      : window.isMinimized()
        ? "minimized"
        : window.isMaximized()
          ? "maximized"
          : "normal",
    ...(populate && main
      ? { tabs: [...tabs.keys()].map((id) => tabOf(id, extensionId)).filter(Boolean) }
      : {}),
  };
}

/** A page of the agent panel's browser, as extensions see it (browser.ts calls this as it attaches). */
export function trackTab(contents: WebContents): void {
  const tabId = contents.id;
  tabs.set(tabId, { contents, favicon: null });
  const updated = (change: Record<string, unknown>) =>
    emit((ext) => ["tabs.onUpdated", [tabId, change, tabOf(tabId, ext)]]);
  contents.on("did-start-loading", () => updated({ status: "loading" }));
  contents.on("did-stop-loading", () => updated({ status: "complete" }));
  contents.on("did-navigate", (_event, url) => updated({ url }));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) updated({ url });
  });
  contents.on("page-title-updated", (_event, title) => updated({ title }));
  // webNavigation, frame by frame (Chrome's frame ids: 0 for the page itself).
  const navigation = (name: string, frame: WebFrameMain | null | undefined, extra = {}) => {
    if (!frame) return;
    emit(() => [
      `webNavigation.${name}`,
      [
        {
          tabId,
          frameId: frameIdOf(contents, frame),
          parentFrameId: frame.parent ? frameIdOf(contents, frame.parent) : -1,
          url: frame.url,
          processId: frame.processId,
          timeStamp: Date.now(),
          ...extra,
        },
      ],
    ]);
  };
  contents.on("did-start-navigation", (details) => {
    if (!details.isSameDocument)
      navigation("onBeforeNavigate", details.frame, { url: details.url });
  });
  contents.on(
    "did-frame-navigate",
    (_event, url, _code, _status, isMainFrame, processId, routingId) =>
      navigation("onCommitted", frameOf(processId, routingId), {
        url,
        transitionType: isMainFrame ? "link" : "auto_subframe",
        transitionQualifiers: [],
      }),
  );
  contents.on("dom-ready", () => navigation("onDOMContentLoaded", contents.mainFrame));
  contents.on("did-frame-finish-load", (_event, _isMainFrame, processId, routingId) =>
    navigation("onCompleted", frameOf(processId, routingId)),
  );
  contents.on(
    "did-fail-load",
    (_event, code, description, url, _isMainFrame, processId, routingId) => {
      if (code !== -3) {
        navigation("onErrorOccurred", frameOf(processId, routingId), { url, error: description });
      }
    },
  );
  contents.on("did-navigate-in-page", (_event, url, isMainFrame, processId, routingId) => {
    const fragment = URL.parse(url)?.hash !== "";
    navigation(
      fragment ? "onReferenceFragmentUpdated" : "onHistoryStateUpdated",
      isMainFrame ? contents.mainFrame : frameOf(processId, routingId),
      { url, transitionType: "link", transitionQualifiers: [] },
    );
  });
  contents.on("page-favicon-updated", (_event, favicons) => {
    const entry = tabs.get(tabId);
    if (entry) entry.favicon = favicons[0] ?? null;
    updated({ favIconUrl: favicons[0] });
  });
  contents.once("destroyed", () => {
    tabs.delete(tabId);
    for (const state of actions.values()) state.tabs.delete(tabId);
    if (activeTabId === tabId) activeTabId = -1;
    emit(() => [
      "tabs.onRemoved",
      [tabId, { windowId: getMainWindow()?.id ?? -1, isWindowClosing: false }],
    ]);
    actionsChanged();
  });
  emit((ext) => ["tabs.onCreated", [tabOf(tabId, ext)]]);
  const waiting = creating.findIndex((pending) => pending.url === contents.getURL());
  if (waiting >= 0) creating.splice(waiting, 1)[0]!.resolve(tabId);
}

function frameIdOf(contents: WebContents, frame: WebFrameMain): number {
  return frame === contents.mainFrame ? 0 : frame.frameTreeNodeId;
}

function frameOf(processId: number, routingId: number): WebFrameMain | undefined {
  return webFrameMain.fromId(processId, routingId) ?? undefined;
}

function frameInfo(contents: WebContents, frame: WebFrameMain) {
  return {
    frameId: frameIdOf(contents, frame),
    parentFrameId: frame.parent ? frameIdOf(contents, frame.parent) : -1,
    url: frame.url,
    processId: frame.processId,
    errorOccurred: false,
  };
}

/** The page showing in the panel (the renderer tells): Chrome's active tab. */
export function setActiveTab(tabId: number): void {
  if (!tabs.has(tabId) || tabId === activeTabId) return;
  activeTabId = tabId;
  emit(() => ["tabs.onActivated", [{ tabId, windowId: getMainWindow()?.id ?? -1 }]]);
  actionsChanged();
}

/** Tabs an extension asked for, waiting for their page to attach. */
const creating: { url: string; resolve: (tabId: number) => void }[] = [];

function createTab(url: string, active = true): Promise<number | null> {
  if (!isPageUrl(url)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const pending = { url, resolve };
    creating.push(pending);
    broadcast("browser:openTab", { url, background: !active });
    setTimeout(() => {
      const at = creating.indexOf(pending);
      if (at < 0) return;
      creating.splice(at, 1);
      resolve(null);
    }, 5_000);
  });
}

/** Resolves an extension's relative URL ("options.html") against its own origin. */
function absolute(extensionId: string, url: string): string {
  return new URL(url, `chrome-extension://${extensionId}/`).href;
}

// ── Events, to extensions' workers and pages ─────────────────────────

/** Which events each extension listens to (it wakes for those). */
const listening = new Map<string, Set<string>>();
/** Extension pages (popups, options) that listen, by extension. */
const pages = new Map<string, Set<WebContents>>();
/** Resolves a wait for an extension to (re)start listening to an event. */
const listenWaiters = new Map<string, (() => void)[]>();

function onListen(extensionId: string, name: string, page?: WebContents): void {
  const names = listening.get(extensionId) ?? new Set();
  listening.set(extensionId, names);
  names.add(name);
  if (page) {
    const set = pages.get(extensionId) ?? new Set();
    pages.set(extensionId, set);
    if (!set.has(page)) {
      set.add(page);
      page.once("destroyed", () => set.delete(page));
    }
  }
  const key = `${extensionId} ${name}`;
  for (const resolve of listenWaiters.get(key) ?? []) resolve();
  listenWaiters.delete(key);
}

function runningWorker(ses: Session, extensionId: string): ServiceWorkerMain | undefined {
  const scope = `chrome-extension://${extensionId}/`;
  for (const [versionId, info] of Object.entries(ses.serviceWorkers.getAllRunning())) {
    if (info.scope === scope) return ses.serviceWorkers.getWorkerFromVersionID(Number(versionId));
  }
  return undefined;
}

/** Workers that just failed to start, and when: they aren't retried for a while. */
const failedWorkers = new Map<string, number>();
const RETRY_FAILED_WORKER_MS = 60_000;
const starting = new Map<string, Promise<ServiceWorkerMain | null>>();

/** The extension's background worker, started if it sleeps (it re-listens as it starts). */
async function wakeWorker(extensionId: string, name: string): Promise<ServiceWorkerMain | null> {
  const ses = getBrowserSession();
  const running = runningWorker(ses, extensionId);
  if (running) return running;
  if (Date.now() - (failedWorkers.get(extensionId) ?? 0) < RETRY_FAILED_WORKER_MS) return null;
  if (!manifestOf(ses.extensions.getExtension(extensionId)!)?.background?.service_worker) {
    return null;
  }
  const key = `${extensionId} ${name}`;
  const listened = new Promise<void>((resolve) => {
    listenWaiters.set(key, [...(listenWaiters.get(key) ?? []), resolve]);
    setTimeout(resolve, 2_000);
  });
  // Events arriving together share one start.
  let start = starting.get(extensionId);
  if (!start) {
    start = ses.serviceWorkers
      .startWorkerForScope(`chrome-extension://${extensionId}/`)
      .catch((error: unknown) => {
        failedWorkers.set(extensionId, Date.now());
        logger.warn("extensions", "Couldn't start an extension's worker", {
          extensionId,
          error: String(error),
        });
        return null;
      })
      .finally(() => starting.delete(extensionId));
    starting.set(extensionId, start);
  }
  const worker = await start;
  if (worker) await listened;
  return worker;
}

async function deliver(extensionId: string, name: string, args: unknown[]): Promise<void> {
  for (const page of pages.get(extensionId) ?? []) {
    if (!page.isDestroyed()) page.send("crx:event", name, args);
  }
  const worker = await wakeWorker(extensionId, name);
  worker?.send("crx:event", name, args);
}

/** Sends an event to every extension listening for it; `make` tailors it to each. */
function emit(make: (extensionId: string) => [string, unknown[]], only?: string): void {
  for (const [extensionId, names] of listening) {
    if (only && extensionId !== only) continue;
    const [name, args] = make(extensionId);
    if (names.has(name)) void deliver(extensionId, name, args);
  }
}

// ── The toolbar: chrome.action ───────────────────────────────────────

type ActionDetails = {
  title?: string;
  icon?: string;
  popup?: string;
  badgeText?: string;
  badgeBackgroundColor?: string;
  badgeTextColor?: string;
  enabled?: boolean;
};

/** What each extension changed, for every tab and for single tabs. */
const actions = new Map<string, { all: ActionDetails; tabs: Map<number, ActionDetails> }>();

function actionState(extensionId: string) {
  const state = actions.get(extensionId) ?? { all: {}, tabs: new Map() };
  actions.set(extensionId, state);
  return state;
}

/** The icon file for about `size` px from a manifest's `{ "16": …, "32": … }` (or one path). */
function iconFile(icons: string | { [size: number]: string } | undefined, size: number) {
  if (!icons || typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .toSorted((a, b) => a - b);
  const best = sizes.find((each) => each >= size) ?? sizes[sizes.length - 1];
  return best === undefined ? undefined : icons[best];
}

function iconDataUrl(extension: Extension, file: string | undefined): string | null {
  if (!file) return null;
  const image = nativeImage.createFromPath(path.join(extension.path, file.replace(/^\//, "")));
  return image.isEmpty() ? null : image.toDataURL();
}

function resolvedAction(extension: Extension, tabId = activeTabId) {
  const manifest = manifestOf(extension);
  const state = actionState(extension.id);
  const changed = { ...state.all, ...state.tabs.get(tabId) };
  return {
    title: changed.title ?? manifest.action?.default_title ?? extension.name,
    icon:
      changed.icon ??
      iconDataUrl(extension, iconFile(manifest.action?.default_icon ?? manifest.icons, 32)),
    popup: changed.popup ?? manifest.action?.default_popup ?? "",
    badgeText: changed.badgeText ?? "",
    badgeBackgroundColor: changed.badgeBackgroundColor ?? "#5f6368",
    badgeTextColor: changed.badgeTextColor ?? "#ffffff",
    enabled: changed.enabled ?? true,
  };
}

/** Chrome takes a color as a string or [r, g, b, a]. */
function cssColor(color: unknown): string | undefined {
  if (typeof color === "string") return color;
  if (Array.isArray(color) && color.length >= 3) {
    const [r, g, b, a = 255] = color as number[];
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
  }
  return undefined;
}

/** `setIcon`'s pixels (RGBA from an ImageData) or path, as a data: URL. */
function iconFromDetails(extension: Extension, details: Record<string, unknown>): string | null {
  const imageData = details.imageData as
    | Record<string, { width: number; height: number; data: number[] }>
    | undefined;
  if (imageData) {
    const sets = Object.values(imageData).toSorted((a, b) => b.width - a.width);
    const largest = sets[0];
    if (!largest) return null;
    const bgra = Buffer.alloc(largest.data.length);
    for (let i = 0; i < largest.data.length; i += 4) {
      bgra[i] = largest.data[i + 2]!;
      bgra[i + 1] = largest.data[i + 1]!;
      bgra[i + 2] = largest.data[i]!;
      bgra[i + 3] = largest.data[i + 3]!;
    }
    const image = nativeImage.createFromBitmap(bgra, {
      width: largest.width,
      height: largest.height,
    });
    return image.isEmpty() ? null : image.toDataURL();
  }
  const file = iconFile(details.path as string | { [size: number]: string } | undefined, 32);
  return iconDataUrl(extension, file);
}

let changedTimer: NodeJS.Timeout | null = null;
/** Tells the renderer's toolbar to read the actions again (once per burst). */
function actionsChanged(): void {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    broadcast("browser:extensionActionsChanged");
  }, 30);
}

export type ExtensionAction = {
  id: string;
  name: string;
  title: string;
  icon: string | null;
  badgeText: string;
  badgeBackgroundColor: string;
  badgeTextColor: string;
  hasPopup: boolean;
  enabled: boolean;
  optionsUrl: string | null;
};

/** The toolbar's buttons for the active page. */
export function extensionActions(): ExtensionAction[] {
  return getBrowserSession()
    .extensions.getAllExtensions()
    .map((extension) => {
      const action = resolvedAction(extension);
      return {
        id: extension.id,
        name: extension.name,
        title: action.title,
        icon: action.icon,
        badgeText: action.badgeText,
        badgeBackgroundColor: action.badgeBackgroundColor,
        badgeTextColor: action.badgeTextColor,
        hasPopup: Boolean(action.popup),
        enabled: action.enabled,
        optionsUrl: optionsUrlOf(extension.id, manifestOf(extension)),
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** A toolbar button clicked: its popup under `anchor` (window coordinates), or the extension's onClicked. */
export function runAction(extensionId: string, anchor: Rectangle): void {
  const extension = getBrowserSession().extensions.getExtension(extensionId);
  if (!extension) return;
  const action = resolvedAction(extension);
  if (!action.enabled) return;
  if (action.popup) {
    openPopup(extension, action.popup, anchor);
    return;
  }
  const tab = tabOf(activeTabId, extensionId);
  if (tab) void deliver(extensionId, "action.onClicked", [tab]);
}

// ── Popups ───────────────────────────────────────────────────────────

let popup: BrowserWindow | null = null;
/** Where the last popup hung from, for `chrome.action.openPopup`. */
let lastAnchor: Rectangle | null = null;

/** An extension's popup: a borderless window under its button, sized to its page, gone on blur. */
function openPopup(extension: Extension, page: string, anchor: Rectangle): void {
  const owner = getMainWindow();
  if (!owner) return;
  popup?.close();
  lastAnchor = anchor;
  const content = owner.getContentBounds();
  const right = content.x + anchor.x + anchor.width;
  const top = content.y + anchor.y + anchor.height + 4;
  const window = new BrowserWindow({
    parent: owner,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    // Starts small, as Chrome's do, so the page's own size shows through.
    x: right - 25,
    y: top,
    width: 25,
    height: 25,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#202020" : "#ffffff",
    webPreferences: {
      session: getBrowserSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      enablePreferredSizeMode: true,
    },
  });
  popup = window;
  // Chrome's bounds for a popup: 25×25 to 800×600, right-aligned to its button.
  const place = (width: number, height: number) => {
    const w = Math.min(800, Math.max(25, Math.ceil(width)));
    const h = Math.min(600, Math.max(25, Math.ceil(height)));
    window.setBounds({ x: Math.max(content.x, right - w), y: top, width: w, height: h });
    if (!window.isVisible()) window.show();
  };
  window.webContents.on("preferred-size-changed", (_event, size) => {
    if (!window.isDestroyed()) place(size.width, size.height);
  });
  window.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    }, 200);
  });
  window.on("blur", () => {
    if (!window.isDestroyed()) window.close();
  });
  window.on("closed", () => {
    if (popup === window) popup = null;
  });
  preparePage(owner, window.webContents);
  void window.loadURL(absolute(extension.id, page));
}

// ── Context menus, notifications, settings ───────────────────────────

type MenuItem = {
  id: string;
  title?: string;
  type?: string;
  checked?: boolean;
  contexts?: string[];
  parentId?: string;
  documentUrlPatterns?: string[];
  targetUrlPatterns?: string[];
  enabled?: boolean;
  visible?: boolean;
};
/** Each extension's context menu items, in the order made. */
const menus = new Map<string, Map<string, MenuItem>>();
const menuOf = (extensionId: string) => {
  const items = menus.get(extensionId) ?? new Map<string, MenuItem>();
  menus.set(extensionId, items);
  return items;
};

/** The extensions' items for a right-click in `page` (browser.ts adds them to its menu). */
export function extensionMenuItems(
  page: WebContents,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const contexts = new Set(["all"]);
  if (params.isEditable) contexts.add("editable");
  if (params.selectionText.trim()) contexts.add("selection");
  if (params.linkURL) contexts.add("link");
  if (
    params.mediaType === "image" ||
    params.mediaType === "video" ||
    params.mediaType === "audio"
  ) {
    contexts.add(params.mediaType);
  }
  if (contexts.size === 1) contexts.add("page");
  if (params.frameURL) contexts.add("frame");
  const pageUrl = page.getURL();
  const target = params.linkURL || params.srcURL;
  const shown = (item: MenuItem) =>
    item.visible !== false &&
    (item.contexts ?? ["page"]).some((context) => contexts.has(context)) &&
    (!item.documentUrlPatterns || item.documentUrlPatterns.some((p) => urlMatches(p, pageUrl))) &&
    (!item.targetUrlPatterns ||
      (target !== "" && item.targetUrlPatterns.some((p) => urlMatches(p, target))));
  const groups: MenuItemConstructorOptions[] = [];
  for (const [extensionId, items] of menus) {
    const extension = getBrowserSession().extensions.getExtension(extensionId);
    if (!extension) continue;
    const build = (parentId?: string): MenuItemConstructorOptions[] =>
      [...items.values()]
        .filter((item) => item.parentId === parentId && shown(item))
        .map((item) => {
          if (item.type === "separator") return { type: "separator" as const };
          const children = build(item.id);
          const info = {
            menuItemId: item.id,
            ...(item.parentId ? { parentMenuItemId: item.parentId } : {}),
            editable: params.isEditable,
            pageUrl,
            ...(params.frameURL ? { frameUrl: params.frameURL } : {}),
            ...(params.linkURL ? { linkUrl: params.linkURL } : {}),
            ...(params.srcURL ? { srcUrl: params.srcURL } : {}),
            ...(params.selectionText ? { selectionText: params.selectionText } : {}),
            ...(params.mediaType !== "none" ? { mediaType: params.mediaType } : {}),
          };
          return {
            label: (item.title ?? extension.name).replace(/%s/g, params.selectionText.slice(0, 40)),
            enabled: item.enabled !== false,
            ...(item.type === "checkbox" || item.type === "radio"
              ? { type: item.type, checked: Boolean(item.checked) }
              : {}),
            ...(children.length > 0
              ? { submenu: children }
              : {
                  click: () =>
                    void deliver(extensionId, "contextMenus.onClicked", [
                      info,
                      tabOf(page.id, extensionId),
                    ]),
                }),
          };
        });
    const top = build();
    if (top.length === 0) continue;
    // One item shows as is; more go under the extension's name, as in Chrome.
    groups.push(top.length === 1 ? top[0]! : { label: extension.name, submenu: top });
  }
  return groups;
}

const notifications = new Map<string, Notification>();

function showNotification(extension: Extension, id: string, options: Record<string, unknown>) {
  notifications.get(id)?.close();
  const iconUrl = typeof options.iconUrl === "string" ? options.iconUrl : "";
  const icon = iconUrl.startsWith("data:")
    ? nativeImage.createFromDataURL(iconUrl)
    : iconUrl
      ? nativeImage.createFromPath(path.join(extension.path, iconUrl.replace(/^\//, "")))
      : undefined;
  const notification = new Notification({
    title: String(options.title ?? extension.name),
    body: String(options.message ?? ""),
    silent: Boolean(options.silent),
    ...(icon && !icon.isEmpty() ? { icon } : {}),
  });
  notification.on("click", () => void deliver(extension.id, "notifications.onClicked", [id]));
  notification.on("close", () => {
    notifications.delete(id);
    void deliver(extension.id, "notifications.onClosed", [id, true]);
  });
  notifications.set(id, notification);
  notification.show();
}

/** chrome.privacy's settings, per extension (this browser keeps none of Chrome's). */
const privacy = new Map<string, unknown>();

let downloadId = 0;

// ── chrome.* calls from extensions ───────────────────────────────────

type Call = (extension: Extension, args: unknown[], sender: WebContents | null) => unknown;

const tabIdOf = (value: unknown) => (typeof value === "number" ? value : activeTabId);

/** `tabs.query`'s filters this app can answer. */
function matches(tab: NonNullable<ReturnType<typeof tabOf>>, query: Record<string, unknown>) {
  const mainId = getMainWindow()?.id;
  if (query.active !== undefined && tab.active !== query.active) return false;
  if (query.highlighted !== undefined && tab.highlighted !== query.highlighted) return false;
  if ((query.currentWindow || query.lastFocusedWindow) && tab.windowId !== mainId) return false;
  if (typeof query.windowId === "number" && query.windowId >= 0 && tab.windowId !== query.windowId)
    return false;
  if (typeof query.status === "string" && tab.status !== query.status) return false;
  if (typeof query.title === "string" && tab.title !== query.title) return false;
  if (query.audible !== undefined && tab.audible !== query.audible) return false;
  if (query.url !== undefined) {
    const patterns = (Array.isArray(query.url) ? query.url : [query.url]) as string[];
    if (!tab.url || !patterns.some((pattern) => urlMatches(pattern, tab.url!))) return false;
  }
  return true;
}

/** Chrome's match patterns: <all_urls>, scheme://host/path with * wildcards. */
function urlMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/.test(url);
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/^\\\*:/, "(https?):")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

function setAction(
  key: keyof ActionDetails,
  value: (details: Record<string, unknown>, extension: Extension) => unknown,
): Call {
  return (extension, [details]) => {
    const record = (details ?? {}) as Record<string, unknown>;
    const state = actionState(extension.id);
    const target =
      typeof record.tabId === "number"
        ? (state.tabs.get(record.tabId) ??
          (state.tabs.set(record.tabId, {}), state.tabs.get(record.tabId)!))
        : state.all;
    (target as Record<string, unknown>)[key] = value(record, extension);
    actionsChanged();
  };
}

function getAction(key: keyof ReturnType<typeof resolvedAction>): Call {
  return (extension, [details]) => {
    const tabId = (details as { tabId?: number } | undefined)?.tabId;
    return resolvedAction(extension, tabId ?? -1)[key];
  };
}

const calls: Record<string, Call> = {
  "action.setTitle": setAction("title", (d) => d.title),
  "action.getTitle": getAction("title"),
  "action.setIcon": setAction("icon", (d, extension) => iconFromDetails(extension, d)),
  "action.setPopup": setAction("popup", (d) => d.popup),
  "action.getPopup": (extension, [details]) => {
    const popupPage = resolvedAction(extension, (details as { tabId?: number })?.tabId ?? -1).popup;
    return popupPage ? absolute(extension.id, popupPage) : "";
  },
  "action.setBadgeText": setAction("badgeText", (d) => d.text ?? ""),
  "action.getBadgeText": getAction("badgeText"),
  "action.setBadgeBackgroundColor": setAction("badgeBackgroundColor", (d) => cssColor(d.color)),
  "action.getBadgeBackgroundColor": getAction("badgeBackgroundColor"),
  "action.setBadgeTextColor": setAction("badgeTextColor", (d) => cssColor(d.color)),
  "action.getBadgeTextColor": getAction("badgeTextColor"),
  "action.enable": (extension, [tabId]) =>
    setAction("enabled", () => true)(extension, [{ tabId }], null),
  "action.disable": (extension, [tabId]) =>
    setAction("enabled", () => false)(extension, [{ tabId }], null),
  "action.isEnabled": (extension, [tabId]) =>
    resolvedAction(extension, typeof tabId === "number" ? tabId : -1).enabled,
  "action.openPopup": (extension) => {
    const page = resolvedAction(extension).popup;
    if (page && lastAnchor) openPopup(extension, page, lastAnchor);
    else if (page) broadcast("browser:openExtensionPopup", { id: extension.id });
  },
  "action.getUserSettings": () => ({ isOnToolbar: true }),

  "tabs.get": (extension, [tabId]) => tabOf(tabIdOf(tabId), extension.id),
  "tabs.getCurrent": (extension, _args, sender) =>
    sender && tabs.has(sender.id) ? tabOf(sender.id, extension.id) : undefined,
  "tabs.query": (extension, [query]) =>
    [...tabs.keys()]
      .map((tabId) => tabOf(tabId, extension.id))
      .filter((tab): tab is NonNullable<typeof tab> => tab !== null)
      .filter((tab) => matches(tab, (query ?? {}) as Record<string, unknown>)),
  "tabs.create": async (extension, [properties]) => {
    const { url = "about:blank", active = true } = (properties ?? {}) as {
      url?: string;
      active?: boolean;
    };
    const tabId = await createTab(absolute(extension.id, url), active);
    return tabId === null ? undefined : tabOf(tabId, extension.id);
  },
  "tabs.update": async (extension, args) => {
    const [first, second] = args;
    const tabId = typeof first === "number" ? first : activeTabId;
    const properties = ((typeof first === "number" ? second : first) ?? {}) as {
      url?: string;
      active?: boolean;
      muted?: boolean;
    };
    const contents = tabs.get(tabId)?.contents;
    if (!contents) return undefined;
    if (properties.url)
      await contents.loadURL(absolute(extension.id, properties.url)).catch(() => {});
    if (properties.muted !== undefined) contents.setAudioMuted(properties.muted);
    if (properties.active) broadcast("browser:selectTab", { webContentsId: tabId });
    return tabOf(tabId, extension.id);
  },
  "tabs.remove": (_extension, [ids]) => {
    for (const tabId of Array.isArray(ids) ? ids : [ids]) {
      if (tabs.has(tabId as number)) broadcast("browser:closeTab", { webContentsId: tabId });
    }
  },
  "tabs.goBack": (_extension, [tabId]) =>
    tabs.get(tabIdOf(tabId))?.contents.navigationHistory.goBack(),
  "tabs.goForward": (_extension, [tabId]) =>
    tabs.get(tabIdOf(tabId))?.contents.navigationHistory.goForward(),

  "windows.get": (extension, [windowId, info]) => {
    const window = BrowserWindow.fromId(windowId as number) ?? getMainWindow();
    return window
      ? windowOf(window, Boolean((info as { populate?: boolean })?.populate), extension.id)
      : undefined;
  },
  "windows.getCurrent": (extension, [info]) => {
    const window = getMainWindow();
    return window
      ? windowOf(window, Boolean((info as { populate?: boolean })?.populate), extension.id)
      : undefined;
  },
  "windows.getLastFocused": (extension, [info]) => {
    const window = getMainWindow();
    return window
      ? windowOf(window, Boolean((info as { populate?: boolean })?.populate), extension.id)
      : undefined;
  },
  "windows.getAll": (extension, [info]) => {
    const window = getMainWindow();
    return window
      ? [windowOf(window, Boolean((info as { populate?: boolean })?.populate), extension.id)]
      : [];
  },
  // A popup-type window (an extension's own UI) is one; anything else opens as a tab.
  "windows.create": async (extension, [data]) => {
    const { url, type, width, height, focused } = (data ?? {}) as {
      url?: string | string[];
      type?: string;
      width?: number;
      height?: number;
      focused?: boolean;
    };
    const first = Array.isArray(url) ? url[0] : url;
    const owner = getMainWindow();
    if ((type === "popup" || type === "panel") && first && owner) {
      const window = new BrowserWindow({
        width: width ?? 420,
        height: height ?? 640,
        show: focused !== false,
        webPreferences: {
          session: getBrowserSession(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      preparePage(owner, window.webContents);
      void window.loadURL(absolute(extension.id, first));
      return windowOf(window, false, extension.id);
    }
    if (first) await createTab(absolute(extension.id, first));
    return owner ? windowOf(owner, true, extension.id) : undefined;
  },
  "windows.update": (extension, [windowId, info]) => {
    const window = BrowserWindow.fromId(windowId as number);
    if (window && (info as { focused?: boolean })?.focused) window.focus();
    return window ? windowOf(window, false, extension.id) : undefined;
  },
  "windows.remove": (_extension, [windowId]) => {
    const window = BrowserWindow.fromId(windowId as number);
    if (window && window !== getMainWindow()) window.close();
  },

  "contextMenus.create": (extension, [properties]) => {
    const item = properties as MenuItem;
    menuOf(extension.id).set(item.id, item);
  },
  "contextMenus.update": (extension, [id, properties]) => {
    const items = menuOf(extension.id);
    const item = items.get(String(id));
    if (item) items.set(item.id, { ...item, ...(properties as Partial<MenuItem>), id: item.id });
  },
  "contextMenus.remove": (extension, [id]) => {
    const items = menuOf(extension.id);
    const drop = (each: string) => {
      items.delete(each);
      for (const child of [...items.values()].filter((item) => item.parentId === each)) {
        drop(child.id);
      }
    };
    drop(String(id));
  },
  "contextMenus.removeAll": (extension) => menus.delete(extension.id),

  "notifications.create": (extension, [id, options]) =>
    showNotification(extension, String(id), (options ?? {}) as Record<string, unknown>),
  "notifications.update": (extension, [id, options]) => {
    if (!notifications.has(String(id))) return false;
    showNotification(extension, String(id), (options ?? {}) as Record<string, unknown>);
    return true;
  },
  "notifications.clear": (_extension, [id]) => {
    const notification = notifications.get(String(id));
    notification?.close();
    return Boolean(notification);
  },
  "notifications.getAll": () =>
    Object.fromEntries([...notifications.keys()].map((id) => [id, true])),
  "notifications.getPermissionLevel": () => "granted",

  "downloads.download": (_extension, [options]) => {
    const { url } = (options ?? {}) as { url?: string };
    if (!url || !isPageUrl(url)) throw new Error("Can't download that address.");
    getBrowserSession().downloadURL(url);
    return ++downloadId;
  },
  "downloads.search": () => [],
  "downloads.pause": () => undefined,
  "downloads.resume": () => undefined,
  "downloads.cancel": () => undefined,
  "downloads.erase": () => [],
  "downloads.open": () => undefined,
  "downloads.show": () => undefined,
  "downloads.showDefaultFolder": () => void shell.openPath(app.getPath("downloads")),

  "privacy.get": (extension, [name]) => {
    const key = `${extension.id} ${String(name)}`;
    return {
      value: privacy.has(key) ? privacy.get(key) : true,
      levelOfControl: "controllable_by_this_extension",
    };
  },
  "privacy.set": (extension, [name, details]) => {
    const value = (details as { value?: unknown } | undefined)?.value;
    privacy.set(`${extension.id} ${String(name)}`, value);
    void deliver(extension.id, `privacy.onChange:${String(name)}`, [
      { value, levelOfControl: "controlled_by_this_extension" },
    ]);
  },
  "privacy.clear": (extension, [name]) => privacy.delete(`${extension.id} ${String(name)}`),

  "webNavigation.getAllFrames": (_extension, [details]) => {
    const contents = tabs.get((details as { tabId?: number })?.tabId ?? -1)?.contents;
    return contents
      ? contents.mainFrame.framesInSubtree.map((frame) => frameInfo(contents, frame))
      : null;
  },
  "webNavigation.getFrame": (_extension, [details]) => {
    const { tabId, frameId } = (details ?? {}) as { tabId?: number; frameId?: number };
    const contents = tabs.get(tabId ?? -1)?.contents;
    const frame = contents?.mainFrame.framesInSubtree.find(
      (each) => frameIdOf(contents, each) === frameId,
    );
    return contents && frame ? frameInfo(contents, frame) : null;
  },

  "tabs.captureVisibleTab": async (_extension, args) => {
    const options = (args.find((arg) => typeof arg === "object" && arg !== null) ?? {}) as {
      format?: string;
      quality?: number;
    };
    const contents = tabs.get(activeTabId)?.contents;
    if (!contents) throw new Error("No tab is showing.");
    const image = await contents.capturePage();
    return options.format === "jpeg"
      ? `data:image/jpeg;base64,${image.toJPEG(options.quality ?? 92).toString("base64")}`
      : image.toDataURL();
  },

  // What the manifest asked for is what it has; nothing optional is granted later.
  "permissions.contains": (extension, [request]) => {
    const manifest = manifestOf(extension);
    const { permissions = [], origins = [] } = (request ?? {}) as {
      permissions?: string[];
      origins?: string[];
    };
    const hosts = manifest.host_permissions ?? [];
    return (
      permissions.every((each) => (manifest.permissions ?? []).includes(each)) &&
      origins.every((origin) =>
        hosts.some((host) => host === origin || urlMatches(host, origin.replace(/\*/g, "x"))),
      )
    );
  },
  "permissions.getAll": (extension) => ({
    permissions: manifestOf(extension).permissions ?? [],
    origins: manifestOf(extension).host_permissions ?? [],
  }),
  "permissions.request": (extension, args, sender) =>
    calls["permissions.contains"]!(extension, args, sender),
  "permissions.remove": () => false,
  "permissions.addHostAccessRequest": () => undefined,
  "permissions.removeHostAccessRequest": () => undefined,

  "commands.getAll": (extension) =>
    Object.entries(manifestOf(extension).commands ?? {}).map(([name, command]) => ({
      name,
      description: command.description ?? "",
      shortcut: command.suggested_key?.mac ?? command.suggested_key?.default ?? "",
    })),
  "commands.update": () => undefined,
  "commands.reset": () => undefined,

  "management.setEnabled": () => {
    throw new Error("Extensions can't turn others on or off here.");
  },

  "runtime.openOptionsPage": (extension) => {
    const url = optionsUrlOf(extension.id, manifestOf(extension));
    if (url) void createTab(url);
  },
};

/** Who's calling: an extension page of that extension, or its worker. */
function callerOk(extensionId: string, url: string | undefined): boolean {
  return Boolean(url?.startsWith(`chrome-extension://${extensionId}/`));
}

async function handleCall(
  extensionId: string,
  name: string,
  args: unknown[],
  sender: WebContents | null,
) {
  const extension = getBrowserSession().extensions.getExtension(extensionId);
  const call = calls[name];
  if (!extension || !call) throw new Error(`chrome.${name} isn't available here.`);
  return call(extension, Array.isArray(args) ? args : [], sender);
}

type WorkerEvent = { serviceWorker?: ServiceWorkerMain; type?: string };

function senderUrl(event: IpcMainInvokeEvent | WorkerEvent): string | undefined {
  const worker = (event as WorkerEvent).serviceWorker;
  if (worker) return worker.scope;
  return (event as IpcMainInvokeEvent).senderFrame?.url;
}

const workersWired = new WeakSet<ServiceWorkerMain>();

function wire(target: { handle: typeof ipcMain.handle }, fromWorker: boolean): void {
  target.handle("crx:call", async (event, extensionId: string, name: string, args: unknown[]) => {
    if (typeof extensionId !== "string" || !callerOk(extensionId, senderUrl(event))) {
      throw new Error("Not an extension of this browser.");
    }
    const sender = fromWorker ? null : (event as IpcMainInvokeEvent).sender;
    return handleCall(extensionId, name, args, sender ?? null);
  });
  target.handle("crx:listen", (event, extensionId: string, name: string) => {
    if (typeof extensionId !== "string" || !callerOk(extensionId, senderUrl(event))) return;
    const page = fromWorker ? undefined : (event as IpcMainInvokeEvent).sender;
    onListen(extensionId, name, page);
  });
}

// ── Turning extensions off, on, and away ─────────────────────────────

const extensionsDir = () => path.join(app.getPath("userData"), "Extensions");
/** Turned-off extensions wait here, where the Web Store's loader doesn't look. */
const disabledDir = () => path.join(app.getPath("userData"), "Disabled Extensions");

/** The folder holding an extension's manifest.json under `root/<id>/` (its version's). */
function installedVersion(root: string, id: string): string | null {
  const dir = path.join(root, id);
  try {
    for (const entry of fs.readdirSync(dir).toSorted().toReversed()) {
      const candidate = path.join(dir, entry);
      if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
    }
  } catch {
    // not there
  }
  return null;
}

export type BrowserExtension = {
  id: string;
  name: string;
  version: string;
  description: string;
  /** A data: URL of its icon (about 64px), if it has one. */
  icon: string | null;
  /** Its options page, which opens in a tab. */
  optionsUrl: string | null;
  enabled: boolean;
  /** What it may read, in a sentence. */
  siteAccess: string;
  permissions: string[];
};

/** What an extension may touch, in a sentence (Chrome lists its permissions when adding one). */
export function reachOf(
  manifest: Manifest & { content_scripts?: { matches?: string[] }[] },
): string {
  const hosts = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []),
  ];
  if (hosts.some((host) => host === "<all_urls>" || /^\*:\/\/\*\/|^https?:\/\/\*\//.test(host))) {
    return "It can read and change what's on every site you visit in Otter Mail.";
  }
  const names = [...new Set(hosts.map((host) => host.replace(/^[^:]+:\/\/|\/.*$/g, "")))];
  return names.length > 0
    ? `It can read and change what's on ${names.slice(0, 3).join(", ")}${names.length > 3 ? " and other sites" : ""}.`
    : "It doesn't ask to read the sites you visit.";
}

function optionsUrlOf(id: string, manifest: Manifest): string | null {
  const page = manifest.options_ui?.page ?? manifest.options_page;
  return page ? absolute(id, page) : null;
}

function describe(
  id: string,
  dir: string,
  manifest: Manifest & { name?: string; version?: string },
  enabled: boolean,
  name = manifest.name ?? id,
): BrowserExtension {
  const icon = nativeImage.createFromPath(
    path.join(dir, (iconFile(manifest.icons, 64) ?? "").replace(/^\//, "")),
  );
  return {
    id,
    name,
    version: manifest.version ?? "",
    description: manifest.description ?? "",
    icon: icon.isEmpty() ? null : icon.toDataURL(),
    optionsUrl: enabled ? optionsUrlOf(id, manifest) : null,
    enabled,
    siteAccess: reachOf(manifest),
    permissions: manifest.permissions ?? [],
  };
}

/** Every installed extension, on or off. */
export function listExtensions(): BrowserExtension[] {
  const loaded = getBrowserSession()
    .extensions.getAllExtensions()
    .map((extension) =>
      describe(extension.id, extension.path, manifestOf(extension), true, extension.name),
    );
  const off: BrowserExtension[] = [];
  try {
    for (const id of fs.readdirSync(disabledDir())) {
      const dir = installedVersion(disabledDir(), id);
      if (!dir) continue;
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
      off.push(describe(id, dir, manifest, false));
    }
  } catch {
    // none turned off
  }
  return [...loaded, ...off].toSorted((a, b) => a.name.localeCompare(b.name));
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  const ses = getBrowserSession();
  if (!enabled) {
    if (!ses.extensions.getExtension(id)) return;
    ses.extensions.removeExtension(id);
    actions.delete(id);
    listening.delete(id);
    fs.mkdirSync(disabledDir(), { recursive: true });
    fs.renameSync(path.join(extensionsDir(), id), path.join(disabledDir(), id));
  } else {
    if (ses.extensions.getExtension(id)) return;
    fs.renameSync(path.join(disabledDir(), id), path.join(extensionsDir(), id));
    const dir = installedVersion(extensionsDir(), id);
    if (!dir) throw new Error("The extension's files are missing.");
    const extension = await ses.extensions.loadExtension(dir);
    if (manifestOf(extension).background?.service_worker) {
      await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${id}/`).catch(() => {});
    }
  }
  logger.info("extensions", enabled ? "Turned on" : "Turned off", { id });
  broadcast("browser:extensionsChanged");
  actionsChanged();
}

export async function removeExtension(id: string): Promise<void> {
  actions.delete(id);
  listening.delete(id);
  await uninstallExtension(id, { session: getBrowserSession() });
  fs.rmSync(path.join(disabledDir(), id), { recursive: true, force: true });
  broadcast("browser:extensionsChanged");
  actionsChanged();
}

/** Sets up extensions' side of the browser session: their preload, their calls, the toolbar. */
export function setupExtensions(preloadPath: string): void {
  const ses = getBrowserSession();
  for (const type of ["frame", "service-worker"] as const) {
    ses.registerPreloadScript({ id: `otter-extensions-${type}`, type, filePath: preloadPath });
  }
  wire(ipcMain, false);
  // A worker's calls may arrive on its own ipc rather than ipcMain.
  ses.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
    if (runningStatus !== "starting" && runningStatus !== "running") return;
    const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId);
    if (!worker || workersWired.has(worker) || !worker.scope.startsWith("chrome-extension://")) {
      return;
    }
    workersWired.add(worker);
    wire(worker.ipc as unknown as { handle: typeof ipcMain.handle }, true);
  });
  ses.extensions.on("extension-loaded", actionsChanged);
  ses.extensions.on("extension-unloaded", actionsChanged);
  const focus = (windowId: number) => emit(() => ["windows.onFocusChanged", [windowId]]);
  app.on("browser-window-focus", (_event, window) => focus(window.id));
  app.on("browser-window-blur", () => focus(-1));
}

/** Developer mode: an unpacked extension from a folder (kept until removed). */
export async function loadUnpacked(owner: BrowserWindow | null): Promise<BrowserExtension | null> {
  const options = {
    title: "Load an unpacked extension",
    buttonLabel: "Select",
    properties: ["openDirectory"] as "openDirectory"[],
  };
  const { canceled, filePaths } = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const dir = filePaths[0];
  if (canceled || !dir) return null;
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error("That folder has no manifest.json.");
  }
  // Copied in with the Web Store's: the loader picks it up from then on.
  const ses = getBrowserSession();
  const extension = await ses.extensions.loadExtension(dir, { allowFileAccess: true });
  const target = path.join(extensionsDir(), extension.id, extension.version || "0");
  if (path.resolve(dir) !== path.resolve(target)) {
    ses.extensions.removeExtension(extension.id);
    fs.rmSync(path.join(extensionsDir(), extension.id), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(dir, target, { recursive: true });
    await ses.extensions.loadExtension(target, { allowFileAccess: true });
  }
  broadcast("browser:extensionsChanged");
  return listExtensions().find((each) => each.id === extension.id) ?? null;
}
