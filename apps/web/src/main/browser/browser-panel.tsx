/**
 * The browser panel beside the mail (the Mac app's): its tabs in a strip,
 * with + for a new one, then the page showing. Links from mail and the small
 * chat window open here; closing its last tab closes it.
 */

import { useEffect, useRef, type MutableRefObject } from "react";
import { PlusIcon } from "lucide-react";

import { useCommandHandlers } from "../keybindings/dispatch";
import { PanelTab } from "../gmail/panel-tab";
import { mostRecentTab } from "../gmail/panel-tabs";
import { PanelControlSlot } from "../gmail/top-bar";
import { HintTooltip, IconBtn } from "../gmail/ui";
import { usePanelTabDrag } from "../gmail/use-panel-tab-drag";
import { BrowserPages, BrowserTabIcon } from "./browser-view";
import { closeTab, hostOf, newTab, panelTabs, reorderTabs, selectTab, useBrowser } from "./store";

export function BrowserPanel({
  closeTabRef,
  onClosePanel,
}: {
  /** ⌘W: closes the page showing, including the last. */
  closeTabRef: MutableRefObject<(() => boolean) | null>;
  /** Closing the last tab closes the panel. */
  onClosePanel: () => void;
}) {
  const allTabs = useBrowser((s) => s.tabs);
  const activeId = useBrowser((s) => s.activeId);
  const tabs = panelTabs(allTabs);
  const panelRef = useRef<HTMLDivElement>(null);
  const { ref, draggingId, handlers } = usePanelTabDrag(reorderTabs);

  // The tabs most recently shown first, for Ctrl+Tab and for what shows after a close.
  const recentRef = useRef<string[]>([]);
  useEffect(() => {
    const open = new Set(panelTabs(allTabs).map((tab) => tab.id));
    recentRef.current = [
      ...(activeId && open.has(activeId) ? [activeId] : []),
      ...recentRef.current.filter((id) => id !== activeId && open.has(id)),
    ];
  }, [activeId, allTabs]);

  const focusSelected = () =>
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
    );
  const close = (id: string) => {
    const ids = panelTabs(useBrowser.getState().tabs).map((tab) => tab.id);
    if (ids.length < 2) onClosePanel();
    const next = mostRecentTab(ids, id, recentRef.current);
    const shown = useBrowser.getState().activeId;
    closeTab(id);
    if (shown === id && next) selectTab(next);
  };
  const previousTab = () => {
    const ids = panelTabs(useBrowser.getState().tabs).map((tab) => tab.id);
    const id = mostRecentTab(ids, useBrowser.getState().activeId ?? "", recentRef.current);
    if (!id) return false;
    selectTab(id);
    focusSelected();
    return true;
  };
  useCommandHandlers({
    "tab.previous": (event) => {
      if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target))
        return false;
      return previousTab();
    },
  });
  useEffect(() => window.desktopBridge.on("browser:previousTab", previousTab));
  useEffect(() => {
    closeTabRef.current = () => {
      const shown = useBrowser.getState().activeId;
      if (shown) close(shown);
      return true;
    };
    return () => {
      closeTabRef.current = null;
    };
  });

  return (
    <div ref={panelRef} className="relative flex h-full min-w-0 flex-col">
      <div className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-3">
        <div
          role="tablist"
          ref={ref}
          aria-label="Open pages"
          className="no-drag scroll-fade-x relative flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          {...handlers}
        >
          {tabs.map((tab) => {
            const title = tab.title || (tab.url ? hostOf(tab.url) : "New tab");
            return (
              <PanelTab
                key={tab.id}
                id={tab.id}
                title={title}
                tooltip={tab.url ? `${title}\n${tab.url}` : title}
                selected={tab.id === activeId}
                dragging={draggingId === tab.id}
                onSelect={() => {
                  selectTab(tab.id);
                  focusSelected();
                }}
                onClose={() => close(tab.id)}
                icon={<BrowserTabIcon tab={tab} />}
              />
            );
          })}
        </div>
        <HintTooltip label="New tab" shortcut="browser.newTab" side="bottom">
          <IconBtn label="New tab" className="size-8 shrink-0" onClick={newTab}>
            <PlusIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        <span className="min-w-0 flex-1" />
        {/* The pinned panel toggle (home view) sits here. */}
        <PanelControlSlot />
      </div>
      <BrowserPages tabs={tabs} activeId={activeId} className="rounded-t-xl" />
    </div>
  );
}
