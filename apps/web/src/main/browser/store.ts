/**
 * The agent panel's browser (the Mac app's): its tabs, which sit after the
 * chats' in the panel's strip, and where links from mail and chat open. The
 * pages are `<webview>`s (browser-view.tsx) in a session of their own, with
 * the Chrome Web Store's extensions (apps/desktop/src/services/browser.ts).
 */

import { useEffect } from "react";
import { create } from "zustand";

import { features } from "../features";

export type BrowserTab = {
  id: string;
  /** Where it is; "" for a new tab, which shows the start page. */
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
};

/** Where links from mail and chat open (Settings › Browser). */
export type OpenLinksIn = "app" | "browser";

type BrowserState = {
  tabs: BrowserTab[];
  /** The tab showing in the panel; null while a chat is. */
  activeId: string | null;
  /** Counts tabs asking to be seen: the home view opens the panel (and leaves Settings). */
  revealed: number;
  /** Open Location (⌘L): that tab's address bar takes focus (`seq` tells requests apart). */
  addressFocus: { tabId: string; seq: number } | null;
  openLinksIn: OpenLinksIn;
  /** Extensions with their button on the toolbar, in order. */
  pinned: string[];
  /** The toolbar's Extensions button (the puzzle), unless hidden from its menu. */
  extensionsButton: boolean;
};

const TABS_KEY = "gmail:browser-tabs";
const LINKS_KEY = "gmail:browser-open-links";
const PINNED_KEY = "gmail:browser-pinned";
const EXTENSIONS_BUTTON_KEY = "gmail:browser-extensions-button";

function savedPinned(): string[] {
  try {
    const pinned: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]");
    return Array.isArray(pinned) ? pinned.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export const CHROME_WEB_STORE_URL = "https://chromewebstore.google.com/";

/** Tabs come back after a restart, their pages loading once they're shown. */
function savedTabs(): Pick<BrowserState, "tabs" | "activeId"> {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? "") as {
      tabs?: { id?: unknown; url?: unknown; title?: unknown; favicon?: unknown }[];
      activeId?: unknown;
    };
    const tabs = (saved.tabs ?? []).flatMap((tab) =>
      typeof tab.id === "string" && typeof tab.url === "string"
        ? [
            {
              id: tab.id,
              url: tab.url,
              title: typeof tab.title === "string" ? tab.title : "",
              favicon: typeof tab.favicon === "string" ? tab.favicon : null,
              loading: false,
            },
          ]
        : [],
    );
    const activeId = tabs.find((tab) => tab.id === saved.activeId)?.id ?? null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

export const useBrowser = create<BrowserState>(() => ({
  ...savedTabs(),
  revealed: 0,
  addressFocus: null,
  openLinksIn: localStorage.getItem(LINKS_KEY) === "browser" ? "browser" : "app",
  pinned: savedPinned(),
  extensionsButton: localStorage.getItem(EXTENSIONS_BUTTON_KEY) !== "0",
}));

useBrowser.subscribe((state, prev) => {
  if (state.tabs === prev.tabs && state.activeId === prev.activeId) return;
  const tabs = state.tabs.map(({ id, url, title, favicon }) => ({ id, url, title, favicon }));
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId: state.activeId }));
});

const { getState: get, setState: set } = useBrowser;

/** A tab's address as the strip and the address bar name it: the host. */
export function hostOf(url: string): string {
  return URL.parse(url)?.host.replace(/^www\./, "") ?? url;
}

/**
 * What the address bar makes of what's typed: an address (https:// unless
 * it says otherwise; http:// for this Mac), or a Google search.
 */
export function addressToUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^(https?|chrome-extension):\/\//i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/i.test(text)) return `http://${text}`;
  if (/^[^\s/:]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

function blankTab(url: string): BrowserTab {
  return {
    id: crypto.randomUUID(),
    url,
    title: url ? hostOf(url) : "",
    favicon: null,
    loading: false,
  };
}

/** Opens `url` in a tab after the one showing, and shows it unless `background`. */
export function openTab(url: string, { background = false } = {}): void {
  const tab = blankTab(url);
  set((s) => {
    const at = s.tabs.findIndex((t) => t.id === s.activeId);
    const tabs = at < 0 ? [...s.tabs, tab] : s.tabs.toSpliced(at + 1, 0, tab);
    return background ? { tabs } : { tabs, activeId: tab.id, revealed: s.revealed + 1 };
  });
}

/** ⌘T or the strip's +: a new start page, in a tab at the end. */
export function newTab(): void {
  const tab = blankTab("");
  set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id, revealed: s.revealed + 1 }));
}

/** ⌘L: the showing tab's address bar, or a new tab's while a chat shows. */
export function focusAddress(): void {
  const tabId = get().activeId;
  if (!tabId) {
    newTab();
    return;
  }
  set((s) => ({
    revealed: s.revealed + 1,
    addressFocus: { tabId, seq: (s.addressFocus?.seq ?? 0) + 1 },
  }));
}

/** Shows a tab; null shows the chat. */
export function selectTab(id: string | null): void {
  set({ activeId: id });
}

/** Closes a tab; prefer the one before it, then the one after it, else the chat. */
export function closeTab(id: string): void {
  set((s) => {
    const at = s.tabs.findIndex((tab) => tab.id === id);
    if (at < 0) return s;
    const tabs = s.tabs.toSpliced(at, 1);
    const activeId = s.activeId === id ? (tabs[at - 1]?.id ?? tabs[at]?.id ?? null) : s.activeId;
    return { tabs, activeId };
  });
}

export function updateTab(id: string, patch: Partial<Omit<BrowserTab, "id">>): void {
  set((s) => ({ tabs: s.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) }));
}

export function setPinned(id: string, pinned: boolean): void {
  set((s) => {
    const next = pinned
      ? [...s.pinned.filter((each) => each !== id), id]
      : s.pinned.filter((each) => each !== id);
    localStorage.setItem(PINNED_KEY, JSON.stringify(next));
    return { pinned: next };
  });
}

export function setExtensionsButton(shown: boolean): void {
  localStorage.setItem(EXTENSIONS_BUTTON_KEY, shown ? "1" : "0");
  set({ extensionsButton: shown });
}

export function setOpenLinksIn(value: OpenLinksIn): void {
  localStorage.setItem(LINKS_KEY, value);
  set({ openLinksIn: value });
}

/**
 * A link from mail or chat: a tab in the agent panel (Mac), unless Settings › Browser says
 * otherwise. ⌘-click (`flip`) opens it the other way.
 */
export function openLink(url: string, { flip = false } = {}): void {
  const inApp = (get().openLinksIn === "app") !== flip;
  if (features.browser && /^https?:/i.test(url) && inApp) {
    openTab(url);
    return;
  }
  void window.desktopBridge.openExternal(url).catch(() => {});
}

/**
 * Electron's `<webview>` reports this when its element goes after its page did
 * (a tab or the panel closing): nothing's wrong, and it mustn't crowd the
 * support report's renderer errors out.
 */
function quietDetachError(event: ErrorEvent): void {
  if (!/Invalid guestInstanceId/.test(event.message)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** The main window's part: tabs pages open, and the File menu's New Tab and Open Location. */
export function useBrowserEvents(): void {
  useEffect(() => {
    if (!features.browser) return;
    window.addEventListener("error", quietDetachError, true);
    const offs = [
      window.desktopBridge.on("browser:openTab", (params) => {
        const { url, background } = params as { url: string; background?: boolean };
        openTab(url, { background });
      }),
      window.desktopBridge.on("browser:newTab", newTab),
      window.desktopBridge.on("browser:focusAddress", focusAddress),
    ];
    return () => {
      window.removeEventListener("error", quietDetachError, true);
      offs.forEach((off) => off());
    };
  }, []);
}
