/**
 * The AI workspace (the Chats space): a chat on the left and, on the right,
 * what it used, made and opened, as tabs: conversations and drafts (in the
 * reader), pages (the Mac app's browser) and files. A chat with nothing open
 * has the width to itself. What the agent makes opens as it makes it, and
 * links and files in the chat open here too. The tab showing is the next
 * message's context, as the open conversation is in the mail.
 */

import {
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { FileIcon, FilePenLineIcon, GlobeIcon, MailIcon, TriangleAlertIcon } from "lucide-react";
import { chatTabId, type ChatTabRef } from "@otter-mail/contracts/chats";

import { BrowserPages } from "../browser/browser-view";
import {
  chatPageId,
  closeChatPage,
  ensureChatPage,
  routeLinks,
  useBrowser,
} from "../browser/store";
import { features } from "../features";
import { useCommandHandlers } from "../keybindings/dispatch";
import { useLatest } from "../use-latest";
import { mailApi, type ChatChange } from "./api";
import { useMailChatContext } from "./chat-context";
import {
  closeChatTab,
  newChat,
  openChatTab,
  reorderChatTabs,
  showChatTab,
  useChats,
  watchChat,
  type ChatTab,
} from "./chat-store";
import { ChatView } from "./chat-view";
import { FilePreview } from "./attachment-preview";
import { MessageReader } from "./message-reader";
import { PanelTab } from "./panel-tab";
import { mostRecentTab } from "./panel-tabs";
import { useChatProvider } from "./agent-providers";
import { usePanelTabDrag } from "./use-panel-tab-drag";
import { cn } from "./ui";

const TAB_ICONS = { thread: MailIcon, draft: FilePenLineIcon, page: GlobeIcon, file: FileIcon };

/** The message a conversation or draft tab opens at: the conversation's latest, the draft's own. */
function useTabMessage(ref: ChatTabRef | undefined) {
  const mail = ref?.kind === "thread" || ref?.kind === "draft" ? ref : null;
  return useQuery({
    queryKey: ["chat-tab-message", mail ? chatTabId(mail) : null],
    enabled: mail !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      if (!mail) return null;
      if (mail.kind === "draft") {
        const version = await mailApi.getDraftVersion(mail.accountId, mail.id);
        if (!version.messageId) throw new Error("This draft was sent or deleted.");
        await mailApi.loadDraftVersion(mail.accountId, mail.id, version.messageId);
        return version.messageId;
      }
      const messages = await mailApi.getThread(mail.accountId, mail.id);
      const last = messages.at(-1);
      if (!last) throw new Error("This conversation is no longer available.");
      return last.id;
    },
  });
}

/** The chat's width beside its tabs, dragged on the seam between them. */
function useChatWidth() {
  const key = "gmail:pane:workspace-chat";
  const [width, setWidth] = useState(() => Number(localStorage.getItem(key)) || 460);
  const start = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    // Pages and message frames must not swallow the release.
    const cover = document.createElement("div");
    cover.className = "no-drag fixed inset-0 z-[200] cursor-col-resize";
    document.body.append(cover);
    let latest = startWidth;
    const move = (ev: PointerEvent) => {
      latest = Math.min(900, Math.max(340, startWidth + ev.clientX - startX));
      setWidth(latest);
    };
    const up = () => {
      cover.remove();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(key, String(latest));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { width, start };
}

export function ChatWorkspace({
  chatId,
  titleLeading,
  titleTrailing,
  inputRef,
  closeTabRef,
  onNavigate,
  onSelectChat,
}: {
  /** ⌘W: closes the tab showing, if there is one. */
  closeTabRef: MutableRefObject<(() => boolean) | null>;
  chatId: string;
  /** Start of the chat's title band (room for the window's controls, the sidebar hidden). */
  titleLeading?: ReactNode;
  /** End of the rightmost title band (room for the browser toggle). */
  titleTrailing?: ReactNode;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** A result that isn't a tab (a label, a view, a theme): the app goes there. */
  onNavigate: (change: ChatChange) => Promise<void>;
  onSelectChat: (chatId: string) => void;
}) {
  const convo = useChats((s) => s.conversations.find((c) => c.id === chatId));
  const activeTab = useChats((s) => s.activeTabs[chatId]);
  const { selectedKind } = useChatProvider(undefined);
  // Pages need the Mac app's browser; elsewhere they're links.
  const tabs = (convo?.tabs ?? []).filter((t) => features.browser || t.ref.kind !== "page");
  const shown = tabs.find((t) => t.id === activeTab) ?? tabs.at(-1);
  const message = useTabMessage(shown?.ref);
  const mail = shown?.ref.kind === "thread" || shown?.ref.kind === "draft" ? shown.ref : null;
  const context = useMailChatContext({
    accountId: mail && message.data ? mail.accountId : null,
    messageId: mail ? (message.data ?? null) : null,
  });
  const { width, start } = useChatWidth();

  // Its replies are seen while it shows here.
  useEffect(() => {
    watchChat(chatId);
    return () => watchChat(null);
  }, [chatId]);

  // A chat this device doesn't have (deleted, or a new one's address after a restart): the
  // chat showing instead, or a new one.
  const ready = useChats((s) => s.ready);
  const missing = ready && !convo;
  const onSelectChatRef = useLatest(onSelectChat);
  useEffect(() => {
    if (!missing) return;
    const { activeId, conversations } = useChats.getState();
    const there = activeId !== chatId && conversations.some((c) => c.id === activeId);
    onSelectChatRef.current(there ? activeId : newChat(selectedKind));
  }, [missing, chatId, selectedKind, onSelectChatRef]);

  const open = (ref: ChatTabRef, title: string) => openChatTab(chatId, ref, title);
  const openChange = async (change: ChatChange) => {
    const { target } = change;
    if (target.kind === "thread" || target.kind === "draft")
      open({ kind: target.kind, accountId: target.accountId, id: target.id }, change.title);
    else if (target.kind === "event" && target.url && features.browser)
      open({ kind: "page", url: target.url }, change.title);
    else await onNavigate(change);
  };
  // Links from the chat and its conversations open as its pages (Mac).
  useEffect(() => {
    routeLinks((url) => openChatTab(chatId, { kind: "page", url }, url));
    return () => routeLinks(null);
  }, [chatId]);
  const close = (tab: ChatTab) => {
    if (tab.ref.kind === "page") closeChatPage(chatId, tab.id);
    closeChatTab(chatId, tab.id);
  };
  useEffect(() => {
    closeTabRef.current = () => {
      if (!shown) return false;
      close(shown);
      return true;
    };
    return () => {
      closeTabRef.current = null;
    };
  });

  // Ctrl+Tab: the tab shown before, within the workspace.
  const recentRef = useRef<string[]>([]);
  const shownId = shown?.id;
  useEffect(() => {
    if (!shownId) return;
    recentRef.current = [shownId, ...recentRef.current.filter((id) => id !== shownId)];
  }, [shownId, recentRef]);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousTab = () => {
    const id = mostRecentTab(
      tabs.map((t) => t.id),
      shown?.id ?? "",
      recentRef.current,
    );
    if (!id) return false;
    showChatTab(chatId, id);
    return true;
  };
  useCommandHandlers({
    "tab.previous": (event) => {
      if (!(event.target instanceof Node) || !workspaceRef.current?.contains(event.target))
        return false;
      return previousTab();
    },
  });
  // Control + Tab in one of the chat's pages (their keys never reach the window's dispatcher).
  useEffect(() => window.desktopBridge.on("browser:previousTab", previousTab));
  const {
    ref: stripRef,
    draggingId,
    handlers,
  } = usePanelTabDrag((order) => reorderChatTabs(chatId, order));

  // The chat's pages, kept in the browser while it shows.
  const pages = tabs.filter((t) => t.ref.kind === "page");
  useEffect(() => {
    for (const tab of pages)
      if (tab.ref.kind === "page") ensureChatPage(chatId, tab.id, tab.ref.url, tab.title);
  });
  const allPages = useBrowser((s) => s.tabs);
  const pageTabs = allPages.filter((t) => t.chatId === chatId);

  const chat = (
    <ChatView
      chatId={chatId}
      context={context}
      inputRef={inputRef}
      onOpenChange={openChange}
      onOpenFile={(href) => open({ kind: "file", href }, href.split(/[\\/]/).pop() || href)}
    />
  );

  return (
    <div ref={workspaceRef} className="relative flex min-h-0 min-w-0 flex-1" data-tour="workspace">
      <div
        style={tabs.length > 0 ? { flexBasis: width } : undefined}
        className={cn(
          "flex min-h-0 flex-col",
          // Beside its tabs, it gives way first, down to a readable column.
          tabs.length > 0 ? "min-w-[300px] shrink" : "min-w-0 flex-1",
        )}
      >
        {/* data-toolbar: the window's own drag strip steps back, so it can't swallow the tabs' clicks. */}
        <div
          data-toolbar=""
          className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-2 px-4"
        >
          {titleLeading}
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {convo && convo.turns.length > 0 ? convo.title : "New chat"}
          </span>
          {tabs.length > 0 ? null : titleTrailing}
        </div>
        {chat}
      </div>
      {tabs.length > 0 ? (
        <>
          <div className="relative z-20 w-0 shrink-0" aria-hidden>
            <div
              onPointerDown={start}
              className="no-drag group absolute inset-y-0 -left-[3px] flex w-1.5 cursor-col-resize justify-center"
            >
              <div className="w-px bg-border/70 group-hover:bg-input" />
            </div>
          </div>
          <div className="flex min-h-0 min-w-[360px] flex-[1_1_0] flex-col">
            <div className="drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-3">
              <div
                role="tablist"
                ref={stripRef}
                aria-label="What this chat opened"
                className="no-drag scroll-fade-x relative flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
                {...handlers}
              >
                {tabs.map((tab) => {
                  const Icon = TAB_ICONS[tab.ref.kind];
                  const page =
                    tab.ref.kind === "page"
                      ? pageTabs.find((t) => t.id === chatPageId(chatId, tab.id))
                      : undefined;
                  const title = page?.title || tab.title;
                  return (
                    <PanelTab
                      key={tab.id}
                      id={tab.id}
                      title={title}
                      tooltip={tab.ref.kind === "page" ? `${title}\n${tab.ref.url}` : title}
                      selected={tab.id === shown?.id}
                      dragging={draggingId === tab.id}
                      onSelect={() => showChatTab(chatId, tab.id)}
                      onClose={() => close(tab)}
                      icon={<Icon className="size-3.5" />}
                    />
                  );
                })}
              </div>
              <span className="min-w-0 flex-1" />
              {titleTrailing}
            </div>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {shown && (shown.ref.kind === "thread" || shown.ref.kind === "draft") ? (
                message.error ? (
                  <TabProblem message={message.error.message} />
                ) : message.data ? (
                  <MessageReader
                    key={shown.id}
                    accountId={shown.ref.accountId}
                    messageId={message.data}
                    autoFocusDraft={false}
                    onDeselect={() => close(shown)}
                    onAdvance={() => close(shown)}
                  />
                ) : null
              ) : shown?.ref.kind === "file" ? (
                <FileTab key={shown.id} chatId={chatId} href={shown.ref.href} />
              ) : null}
              {features.browser && pageTabs.length > 0 ? (
                <BrowserPages
                  tabs={pageTabs}
                  activeId={shown?.ref.kind === "page" ? chatPageId(chatId, shown.id) : null}
                  className={shown?.ref.kind === "page" ? undefined : "absolute! inset-0"}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function TabProblem({ message }: { message: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <TriangleAlertIcon className="size-5 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** A file the agent wrote or linked, read through its chat's agent. */
function FileTab({ chatId, href }: { chatId: string; href: string }) {
  const convo = useChats((s) => s.conversations.find((c) => c.id === chatId));
  const file = useQuery({
    queryKey: ["chat-file", convo?.provider, convo?.sessionId, href],
    enabled: Boolean(convo),
    retry: false,
    queryFn: () => mailApi.agentReadFile(convo!.provider, convo!.sessionId ?? "", href),
  });
  if (file.error)
    return (
      <TabProblem
        message={
          convo?.device && convo.device.name
            ? `This file is on ${convo.device.name}, where the chat ran.`
            : file.error.message
        }
      />
    );
  if (!file.data) return null;
  const data = file.data;
  return <FilePreview file={{ ...data, load: async () => data.data }} />;
}
