/**
 * The agent over the mail (⌘I): a small window at the workspace's bottom right
 * (over the browser when it's open), showing one chat with the mail on screen
 * as its context. Open in workspace takes the chat to the AI workspace, where
 * what it used and made are tabs.
 * Closed, its launcher stays in the corner: it spins while a chat works, and
 * a dot says one waits on you or finished while you were away.
 */

import { useEffect, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  HistoryIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MinusIcon,
  SquarePenIcon,
} from "lucide-react";
import { AgentIcon } from "./agent-icon";

import { useChatProvider } from "./agent-providers";
import { gmailApi, type ChatChange, type ChatSession } from "./api";
import type { MailChatContext } from "./chat-context";
import { HistoryList } from "./chat-history";
import {
  deleteConversation,
  isBlank,
  newChat,
  openServerSession,
  showChat,
  useChats,
  watchChat,
} from "./chat-store";
import { ChatView } from "./chat-view";
import { HintTooltip, IconBtn, cn } from "./ui";

export function ChatWindow({
  context,
  onClearQuote,
  onOpenChange,
  onOpenWorkspace,
  onClose,
  inputRef,
}: {
  context: MailChatContext;
  onClearQuote: () => void;
  onOpenChange: (change: ChatChange) => Promise<void>;
  onOpenWorkspace: (chatId: string) => void;
  onClose: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const activeId = useChats((s) => s.activeId);
  const conversations = useChats((s) => s.conversations);
  const active = conversations.find((c) => c.id === activeId);
  const chat = useChatProvider(active);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Its replies are seen while it's open.
  useEffect(() => {
    watchChat(activeId);
    return () => watchChat(null);
  }, [activeId]);
  // Opening it puts you in its composer.
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [inputRef]);

  // Other sessions persisted on the provider (Hermes WebUI, Codex threads…), fetched when history opens.
  const sessionsAvailable = Boolean(chat.provider?.sessions && chat.usable);
  const serverSessions = useQuery<ChatSession[]>({
    queryKey: ["agent-sessions", chat.kind],
    queryFn: () => gmailApi.agentSessions(chat.kind, 40),
    enabled: historyOpen && sessionsAvailable,
    staleTime: 15_000,
  });

  const startNew = () => {
    setHistoryOpen(false);
    newChat(chat.selectedKind);
    inputRef.current?.focus();
  };

  return (
    <div
      role="dialog"
      aria-label="Agent"
      data-tour="agent"
      className="absolute bottom-4 right-4 web:bottom-3 web:right-3 z-30 flex h-[min(38rem,calc(100%-4.5rem))] w-[min(27rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-canvas shadow-[0_24px_60px_-20px_rgb(0_0_0/45%)] dark:shadow-[0_24px_60px_-20px_rgb(0_0_0/80%)]"
    >
      <div className="relative flex h-11 shrink-0 items-center gap-1 border-b border-border/60 ps-3.5 pe-1.5">
        <AgentIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {active && !isBlank(active) ? active.title : "New chat"}
        </span>
        <HintTooltip label="Chat history" side="bottom">
          <IconBtn
            label="Chat history"
            active={historyOpen}
            className="size-7"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <HistoryIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        <HintTooltip label="New chat" shortcut="agent.newChat" side="bottom">
          <IconBtn label="New chat" className="size-7" onClick={startNew}>
            <SquarePenIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        <HintTooltip label="Open in workspace" shortcut="agent.openWorkspace" side="bottom">
          <IconBtn
            label="Open in workspace"
            className="size-7"
            onClick={() => onOpenWorkspace(activeId)}
          >
            <Maximize2Icon className="size-4" />
          </IconBtn>
        </HintTooltip>
        <HintTooltip label="Close" shortcut="agent.toggle" side="bottom">
          <IconBtn label="Close" className="size-7" onClick={onClose}>
            <MinusIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
      </div>
      {historyOpen ? (
        <HistoryList
          className="right-1.5 top-10"
          backdropClassName="top-11"
          conversations={conversations}
          activeId={activeId}
          onPick={(id) => {
            setHistoryOpen(false);
            showChat(id);
          }}
          onDelete={(id) => deleteConversation(id, chat.selectedKind)}
          onClose={() => setHistoryOpen(false)}
          serverSessions={
            sessionsAvailable && serverSessions.data
              ? serverSessions.data.filter(
                  (s) => s.messageCount > 0 && !conversations.some((c) => c.sessionId === s.id),
                )
              : undefined
          }
          serverLoading={sessionsAvailable && serverSessions.isPending}
          onPickServer={(session) => {
            setHistoryOpen(false);
            openServerSession(session, chat.kind, chat.name);
            inputRef.current?.focus();
          }}
          providerName={chat.name}
        />
      ) : null}
      {activeId ? (
        <ChatView
          compact
          chatId={activeId}
          context={context}
          onClearQuote={onClearQuote}
          inputRef={inputRef}
          onOpenChange={onOpenChange}
        />
      ) : null}
    </div>
  );
}

/** The closed window's corner: opens it (⌘I), and shows how the chats are doing. */
export function ChatLauncher({ onOpen }: { onOpen: () => void }) {
  const working = useChats((s) => Object.keys(s.runs).length > 0);
  const waiting = useChats((s) => s.approvals.length > 0 || s.questions.length > 0);
  const finished = useChats((s) => s.unseen.size > 0);
  const label = waiting
    ? "Ask the agent — waiting for you"
    : finished
      ? "Ask the agent — a chat finished"
      : working
        ? "Ask the agent — working"
        : "Ask the agent";
  return (
    <HintTooltip label={label} shortcut="agent.toggle" side="top">
      <button
        type="button"
        aria-label={label}
        data-tour="agent"
        onClick={onOpen}
        className="absolute bottom-5 right-5 web:bottom-4 web:right-4 z-30 flex size-11 cursor-pointer items-center justify-center rounded-full border border-foreground/10 bg-canvas text-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/45%)] outline-none transition-transform duration-150 hover:scale-105 focus-visible:ring-2 focus-visible:ring-focus-ring dark:shadow-[0_12px_32px_-12px_rgb(0_0_0/80%)]"
      >
        {working && !waiting ? (
          <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <AgentIcon className="size-5" />
        )}
        {waiting || finished ? (
          <span
            aria-hidden
            className={cn(
              "absolute right-0.5 top-0.5 size-2.5 rounded-full ring-2 ring-canvas",
              waiting ? "bg-warning" : "bg-primary",
            )}
          />
        ) : null}
      </button>
    </HintTooltip>
  );
}
