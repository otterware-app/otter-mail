import { useLatest } from "../use-latest";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HistoryIcon,
  Maximize2Icon,
  Minimize2Icon,
  MousePointer2Icon,
  PlusIcon,
} from "lucide-react";
import { IconBtn, HintTooltip, cn } from "./ui";
import { PanelControlSlot } from "./top-bar";
import { PanelTab } from "./panel-tab";
import { mostRecentTab, orderedPanelTabs } from "./panel-tabs";
import { usePanelTabDrag } from "./use-panel-tab-drag";
import { gmailApi, type ChatChange, type ChatSession } from "./api";
import { useChatProvider } from "./agent-providers";
import { useMailChatContext, type QuoteContext } from "./chat-context";
import {
  closeChat,
  deleteConversation,
  ensureChat,
  newChat,
  openServerSession,
  resumeRuns,
  switchTo,
  useChats,
} from "./chat-store";
import { HistoryList } from "./chat-history";
import { ChatView } from "./chat-view";
import { useCommandHandlers, useKeybindingContext } from "../keybindings/dispatch";
import type { GmailMessageSummary } from "./types";
import { features } from "../features";
import { BrowserPages, BrowserTabIcon } from "../browser/browser-view";
import {
  closeTab as closeBrowserTab,
  hostOf,
  newTab,
  selectTab,
  useBrowser,
  type BrowserTab,
} from "../browser/store";

const PANEL_TABS_KEY = "gmail:panel-tabs";

function loadPanelTabOrder(): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(PANEL_TABS_KEY) ?? "[]");
    return Array.isArray(order) ? order.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

type ChatTab = {
  id: string;
  title: string;
  state: "idle" | "working" | "approval" | "unseen";
};

const TAB_STATE_LABEL: Record<ChatTab["state"], string | null> = {
  idle: null,
  working: "Working",
  approval: "Waiting for your approval",
  unseen: "Finished",
};

/**
 * The panel's strip: draggable pill tabs for chats and browser pages,
 * always shown, so the current chat is named even when it's the only one.
 * A chat's icon carries its state (working, waiting on an approval,
 * or finished while you were elsewhere).
 */
function AgentTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
}: {
  tabs: (ChatTab | BrowserTab)[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (order: string[]) => void;
}) {
  const { ref, draggingId, handlers } = usePanelTabDrag(onReorder);
  return (
    <div
      role="tablist"
      ref={ref}
      aria-label="Open chats and pages"
      className="no-drag scroll-fade-x relative flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      {...handlers}
    >
      {tabs.map((tab) => {
        const page = "url" in tab;
        const status = page ? null : TAB_STATE_LABEL[tab.state];
        const title = page ? tab.title || (tab.url ? hostOf(tab.url) : "New tab") : tab.title;
        return (
          <PanelTab
            key={tab.id}
            id={tab.id}
            title={title}
            tooltip={
              page && tab.url ? `${title}\n${tab.url}` : status ? `${title} — ${status}` : title
            }
            selected={tab.id === activeId}
            dragging={draggingId === tab.id}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
            icon={
              page ? (
                <BrowserTabIcon tab={tab} />
              ) : (
                <>
                  <MousePointer2Icon className="size-3.5" />
                  {tab.state !== "idle" ? (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-canvas",
                        tab.state === "approval" ? "bg-warning" : "bg-primary",
                        tab.state === "working" && "animate-status-pulse",
                      )}
                    />
                  ) : null}
                </>
              )
            }
          />
        );
      })}
    </div>
  );
}

/**
 * Right-side agent panel: the open chats (chat-store.ts) and, in the Mac
 * app, browser pages, as tabs in one strip, with the history dropdown. The
 * active chat shows in a ChatView, with the mail on screen as its context.
 */
export function AgentChatPanel({
  accountId,
  messageId,
  selectedRows,
  quote,
  onClearQuote,
  closeTabRef,
  newTabRef,
  onClosePanel,
  project,
  onOpenChange,
  expanded = false,
  onToggleExpanded,
}: {
  /** The panel fills the window (the mail hides), for a page or a long chat. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** The project on screen: attached along with (or without) a conversation. */
  project?: { id: string; name: string } | null;
  /** Account of the open conversation (context attach), null when none. */
  accountId: string | null;
  messageId: string | null;
  /** Multi-selected list rows; take priority over the open conversation. */
  selectedRows?: GmailMessageSummary[];
  /** A highlighted excerpt to attach; overrides the auto-derived context. */
  quote?: QuoteContext | null;
  onClearQuote?: () => void;
  /** ⌘W: closes the active chat or page, including the last tab. */
  closeTabRef?: MutableRefObject<(() => boolean) | null>;
  /** Global ⌘T: a new chat on shells without browser pages. */
  newTabRef?: MutableRefObject<((reuseEmpty?: boolean) => void) | null>;
  /** Closing the last tab closes the panel. */
  onClosePanel?: () => void;
  onOpenChange: (change: ChatChange) => Promise<void>;
}) {
  const conversations = useChats((s) => s.conversations);
  const activeId = useChats((s) => s.activeId);
  const chatTabs = useChats((s) => s.tabs);
  const runs = useChats((s) => s.runs);
  const approvals = useChats((s) => s.approvals);
  const unseen = useChats((s) => s.unseen);
  const active = conversations.find((c) => c.id === activeId);
  const chat = useChatProvider(active);
  const context = useMailChatContext({ accountId, messageId, selectedRows, quote, project });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The browser's tab showing over the chat (Mac), if one is.
  const browserTabId = useBrowser((s) => (features.browser ? s.activeId : null));
  const browserTabs = useBrowser((s) => s.tabs);
  const [tabOrder, setTabOrder] = useState(loadPanelTabOrder);
  const panelTabs = orderedPanelTabs(tabOrder, [
    ...chatTabs,
    ...(features.browser ? browserTabs.map((tab) => tab.id) : []),
  ]);
  if (panelTabs.length !== tabOrder.length || panelTabs.some((id, at) => id !== tabOrder[at])) {
    setTabOrder(panelTabs);
  }
  const panelTabsRef = useLatest(panelTabs);
  useEffect(() => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(tabOrder));
  }, [tabOrder]);
  const panelRef = useRef<HTMLDivElement>(null);
  const recentTabsRef = useRef<string[]>([]);
  useEffect(() => {
    const tabs = new Set([
      ...chatTabs,
      ...(features.browser ? browserTabs.map((tab) => tab.id) : []),
    ]);
    const shown = browserTabId ?? activeId;
    recentTabsRef.current = [
      ...(tabs.has(shown) ? [shown] : []),
      ...recentTabsRef.current.filter((id) => id !== shown && tabs.has(id)),
    ];
  }, [activeId, browserTabId, chatTabs, browserTabs]);
  // The final page can close through its × or an extension, leaving a fresh chat.
  useEffect(() => {
    if (!browserTabId && chatTabs.length === 0) ensureChat();
  }, [browserTabId, chatTabs.length]);

  const [historyOpen, setHistoryOpen] = useState(false);

  // A turn the app quit during is picked up once its provider can run.
  useEffect(() => {
    const providers = chat.state?.providers;
    if (!providers) return;
    resumeRuns(providers);
    return useChats.subscribe((s, prev) => {
      if (s.conversations !== prev.conversations || s.runs !== prev.runs) resumeRuns(providers);
    });
  }, [chat.state]);

  // Other sessions persisted on the provider (Hermes WebUI, Codex threads…), fetched when history opens.
  const sessionsAvailable = Boolean(chat.provider?.sessions && chat.usable);
  const serverSessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["agent-sessions", chat.kind],
    queryFn: () => gmailApi.agentSessions(chat.kind, 40),
    enabled: historyOpen && sessionsAvailable,
    staleTime: 15_000,
  });

  /** A fresh chat, in a new tab beside the current one. */
  const newChatTab = (reuseEmpty = true) => {
    selectTab(null);
    setHistoryOpen(false);
    newChat(chat.selectedKind, reuseEmpty);
    inputRef.current?.focus();
  };
  useEffect(() => {
    if (!newTabRef) return;
    newTabRef.current = newChatTab;
    return () => {
      newTabRef.current = null;
    };
  });

  /** Shows a chat: its tab if open, else a new tab. */
  const showChat = (id: string) => {
    selectTab(null);
    setHistoryOpen(false);
    switchTo(id);
  };

  /**
   * Closes a chat or page, returning to the last viewed tab. Chats stay in history
   * (a running turn finishes there).
   * The last tab closes the panel, leaving a fresh "New chat" for next time.
   */
  const closeTab = (id: string) => {
    const s = useChats.getState();
    const browser = useBrowser.getState();
    const pages = features.browser ? browser.tabs : [];
    const tabs = orderedPanelTabs(panelTabsRef.current, [...s.tabs, ...pages.map((tab) => tab.id)]);
    if (!tabs.includes(id)) return;
    const shown = (features.browser ? browser.activeId : null) ?? s.activeId;
    const next = mostRecentTab(tabs, id, recentTabsRef.current);
    if (tabs.length < 2) onClosePanel?.();
    if (pages.some((tab) => tab.id === id)) {
      closeBrowserTab(id);
      if (shown === id && next) showPanelTab(next);
      return;
    }
    closeChat(id, chat.selectedKind, { pagesOpen: pages.length > 0 });
    if (shown === id && next) showPanelTab(next);
  };

  const focusPanelTab = () => {
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };
  const showPanelTab = (id: string) => {
    if (useBrowser.getState().tabs.some((tab) => tab.id === id)) selectTab(id);
    else showChat(id);
    focusPanelTab();
  };
  const previousTab = () => {
    const s = useChats.getState();
    const browser = useBrowser.getState();
    const tabs = orderedPanelTabs(panelTabsRef.current, [
      ...s.tabs,
      ...(features.browser ? browser.tabs.map((tab) => tab.id) : []),
    ]);
    const shown = (features.browser ? browser.activeId : null) ?? s.activeId;
    const id = mostRecentTab(tabs, shown, recentTabsRef.current);
    if (!id) return false;
    showPanelTab(id);
    return true;
  };
  useCommandHandlers({
    "agent.newChat": () => newChatTab(),
    "agent.previousTab": (event) => {
      if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target))
        return false;
      return previousTab();
    },
  });
  useEffect(() => {
    if (!features.browser) return;
    return window.desktopBridge.on("browser:previousTab", previousTab);
  });

  const closeActiveTab = () => {
    const page = useBrowser.getState().activeId;
    if (features.browser && page) {
      closeTab(page);
      return true;
    }
    closeTab(useChats.getState().activeId);
    return true;
  };
  useEffect(() => {
    if (!closeTabRef) return;
    closeTabRef.current = closeActiveTab;
    return () => {
      closeTabRef.current = null;
    };
  });

  useKeybindingContext("agentOpen", browserTabId === null);

  return (
    <div ref={panelRef} className="relative flex h-full min-w-0 flex-col">
      {/* Header: chat actions on the left; the panel toggle stays at the
          window's top-right, exactly where it sits while the panel is closed. */}
      <div
        className={cn(
          "drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-3",
          // Filling the window, the strip starts by the traffic lights (with none,
          // a browser tab's or Linux's, it keeps its own inset).
          expanded &&
            "pl-[max(--spacing(3),calc(var(--workspace-controls-left)-var(--workspace-rail-width)))]",
        )}
      >
        <AgentTabs
          tabs={panelTabs.map((id) => {
            const page = features.browser ? browserTabs.find((tab) => tab.id === id) : null;
            if (page) return page;
            const convo = conversations.find((c) => c.id === id);
            const tabRun = runs[id];
            return {
              id,
              title: convo && convo.turns.length > 0 ? convo.title : "New chat",
              state: tabRun
                ? approvals.some((a) => a.requestId === tabRun.requestId)
                  ? "approval"
                  : "working"
                : unseen.has(id)
                  ? "unseen"
                  : "idle",
            };
          })}
          activeId={browserTabId ?? activeId}
          onSelect={showPanelTab}
          onClose={closeTab}
          onReorder={setTabOrder}
        />
        {/* Right after the tabs, like a browser's new-tab button: with the
            browser, its start page (which offers a new chat too). */}
        {features.browser ? (
          <HintTooltip label="New tab" shortcut="agent.newTab" side="bottom">
            <IconBtn label="New tab" className="size-8 shrink-0" onClick={newTab}>
              <PlusIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : (
          <HintTooltip label="New chat" shortcut="agent.newChat" side="bottom">
            <IconBtn label="New chat" className="size-8 shrink-0" onClick={() => newChatTab()}>
              <PlusIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        )}
        <span className="min-w-0 flex-1" />
        <HintTooltip label="Chat history" side="bottom">
          <IconBtn
            label="Chat history"
            active={historyOpen}
            className="size-8 shrink-0"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <HistoryIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        {onToggleExpanded ? (
          <HintTooltip
            label={expanded ? "Collapse panel" : "Expand panel"}
            shortcut="agent.toggleExpanded"
            side="bottom"
          >
            <IconBtn
              label={expanded ? "Collapse panel" : "Expand panel"}
              active={expanded}
              className="size-8 shrink-0"
              onClick={onToggleExpanded}
            >
              {expanded ? (
                <Minimize2Icon className="size-4" />
              ) : (
                <Maximize2Icon className="size-4" />
              )}
            </IconBtn>
          </HintTooltip>
        ) : null}
        {/* The pinned agent toggle (home view) sits here. */}
        <PanelControlSlot />
      </div>

      {features.browser ? <BrowserPages onNewChat={() => newChatTab()} /> : null}

      {historyOpen ? (
        <HistoryList
          conversations={conversations}
          activeId={activeId}
          onPick={showChat}
          onDelete={(id) => deleteConversation(id, chat.selectedKind)}
          onClose={() => setHistoryOpen(false)}
          serverSessions={
            sessionsAvailable && serverSessionsQuery.data
              ? serverSessionsQuery.data.filter(
                  (s) => s.messageCount > 0 && !conversations.some((c) => c.sessionId === s.id),
                )
              : undefined
          }
          serverLoading={sessionsAvailable && serverSessionsQuery.isPending}
          onPickServer={(session) => {
            selectTab(null);
            setHistoryOpen(false);
            openServerSession(session, chat.kind, chat.name);
            inputRef.current?.focus();
          }}
          providerName={chat.name}
        />
      ) : null}

      <ChatView
        chatId={activeId}
        context={context}
        onClearQuote={onClearQuote}
        inputRef={inputRef}
        onOpenChange={onOpenChange}
      />
    </div>
  );
}
