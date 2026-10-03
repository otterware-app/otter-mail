import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
  vi.stubGlobal("window", { desktopBridge: { features: { browser: true } } });
});
afterEach(() => vi.unstubAllGlobals());

describe("closing browser tabs", () => {
  it("keeps selecting a remaining page when closing from the left", async () => {
    const { openTab, selectTab, closeTab, useBrowser } = await import("./store");
    openTab("https://example.com/first");
    openTab("https://example.com/second");
    openTab("https://example.com/third");
    const [first, second, third] = useBrowser.getState().tabs;
    selectTab(first.id);
    closeTab(first.id);
    expect(useBrowser.getState().activeId).toBe(second.id);
    closeTab(second.id);
    expect(useBrowser.getState().activeId).toBe(third.id);
    closeTab(third.id);
    expect(useBrowser.getState().activeId).toBeNull();
    expect(useBrowser.getState().tabs).toEqual([]);
  });

  it("prefers the left page and preserves the selection when closing a background page", async () => {
    const { openTab, selectTab, closeTab, useBrowser } = await import("./store");
    openTab("https://example.com/first");
    openTab("https://example.com/second");
    openTab("https://example.com/third");
    const [first, second, third] = useBrowser.getState().tabs;
    selectTab(second.id);
    closeTab(second.id);
    expect(useBrowser.getState().activeId).toBe(first.id);
    closeTab(third.id);
    expect(useBrowser.getState().activeId).toBe(first.id);
    expect(useBrowser.getState().tabs.map((tab) => tab.id)).toEqual([first.id]);
  });
});
