import { describe, expect, it } from "vite-plus/test";
import { mostRecentTab, movePanelTab, orderedPanelTabs, tabDragTarget } from "./panel-tabs";

describe("chat and browser tab navigation", () => {
  it("reaches both end slots at their midpoints, including tabs of different widths", () => {
    const tabs = [
      { id: "wide-chat", left: 0, width: 176 },
      { id: "page-1", left: 180, width: 128 },
      { id: "page-2", left: 312, width: 128 },
    ];
    expect(tabDragTarget(tabs, "wide-chat", 376)).toEqual({ id: "page-2", after: true });
    expect(tabDragTarget(tabs, "page-2", 88)).toEqual({ id: "wide-chat", after: false });
    const equal = tabs.map((tab, at) => ({ ...tab, left: at * 132, width: 128 }));
    expect(tabDragTarget(equal, "wide-chat", 328)).toEqual({ id: "page-2", after: true });
    expect(tabDragTarget(equal, "page-2", 64)).toEqual({ id: "wide-chat", after: false });
  });

  it("reorders at neighbouring midpoints while dragging, without reversing at the same pointer position", () => {
    const layout = (ids: string[]) => ids.map((id, at) => ({ id, left: at * 132, width: 128 }));
    const tabs = ["chat-1", "page-1", "chat-2", "page-2"];
    expect(tabDragTarget(layout(tabs), "chat-1", 195)).toBeNull();
    const target = tabDragTarget(layout(tabs), "chat-1", 200)!;
    expect(target).toEqual({ id: "page-1", after: true });
    const moved = movePanelTab(tabs, "chat-1", target.id, target.after);
    expect(tabDragTarget(layout(moved), "chat-1", 200)).toBeNull();
    expect(tabDragTarget(layout(moved), "chat-1", 50)).toEqual({ id: "page-1", after: false });
    expect(tabDragTarget(layout(tabs), "chat-1", 460)).toEqual({ id: "page-2", after: true });
  });

  it("moves chats and pages across each other without changing viewing history", () => {
    const tabs = ["chat-1", "chat-2", "page-1", "page-2"];
    const moved = movePanelTab(tabs, "page-2", "chat-1", false);
    expect(moved).toEqual(["page-2", "chat-1", "chat-2", "page-1"]);
    expect(mostRecentTab(moved, "chat-1", ["chat-1", "page-1", "page-2"])).toBe("page-1");
    expect(movePanelTab(moved, "chat-1", "page-1", true)).toEqual([
      "page-2",
      "chat-2",
      "page-1",
      "chat-1",
    ]);
    expect(tabs).toEqual(["chat-1", "chat-2", "page-1", "page-2"]);
  });

  it("restores mixed order, removes closed tabs, and places new tabs beside their source neighbour", () => {
    expect(
      orderedPanelTabs(
        ["page-2", "closed", "chat-1", "page-1", "chat-2"],
        ["chat-1", "new-chat", "chat-2", "page-1", "new-page", "page-2"],
      ),
    ).toEqual(["page-2", "chat-1", "new-chat", "page-1", "new-page", "chat-2"]);
    expect(orderedPanelTabs([], ["chat-1", "page-1"])).toEqual(["chat-1", "page-1"]);
    expect(orderedPanelTabs(["chat-1"], [])).toEqual([]);
  });

  it("closes through viewing history, skipping tabs already closed", () => {
    let tabs = ["chat-1", "chat-2", "page-1", "page-2"];
    let active = "page-1";
    const recent = ["page-1", "chat-1", "page-2", "chat-2"];
    const closed: string[] = [];
    while (active) {
      closed.push(active);
      const next = mostRecentTab(tabs, active, recent);
      tabs = tabs.filter((id) => id !== active);
      active = next ?? "";
    }
    expect(closed).toEqual(["page-1", "chat-1", "page-2", "chat-2"]);
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
