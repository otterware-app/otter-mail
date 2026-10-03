import { describe, expect, it } from "vite-plus/test";
import { mostRecentTab, tabAfterClose } from "./panel-tabs";

describe("chat and browser tab navigation", () => {
  it("continues closing to the right after reaching the first chat", () => {
    let tabs = ["chat-1", "chat-2", "page-1", "page-2"];
    let active = "page-1";
    const closed: string[] = [];
    while (active) {
      closed.push(active);
      const next = tabAfterClose(tabs, active);
      tabs = tabs.filter((id) => id !== active);
      active = next ?? "";
    }
    expect(closed).toEqual(["page-1", "chat-2", "chat-1", "page-2"]);
    expect(tabs).toEqual([]);
  });

  it("selects the most recently visited chat or page instead of its neighbour", () => {
    const tabs = ["chat-1", "chat-2", "page-1", "page-2"];
    const recent = ["page-2", "chat-1", "page-1", "chat-2"];
    expect(mostRecentTab(tabs, "page-2", recent)).toBe("chat-1");
    expect(mostRecentTab(tabs, "chat-1", ["chat-1", ...recent])).toBe("page-2");
  });

  it("skips closed tabs and can switch to an unvisited restored tab", () => {
    const recent = ["page-2", "closed-chat", "chat-1"];
    expect(mostRecentTab(["chat-1", "page-2"], "page-2", recent)).toBe("chat-1");
    expect(mostRecentTab(["chat-1", "page-2"], "page-2", ["page-2"])).toBe("chat-1");
    expect(mostRecentTab(["page-2"], "page-2", recent)).toBeNull();
  });
});
