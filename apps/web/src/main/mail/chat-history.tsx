import { useEffect, useState } from "react";
import { CheckIcon, HistoryIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { ChatSession } from "./api";
import { cn } from "./ui";
import { isBlank, type Conversation } from "./chat-store";

/** Human label for a session's origin (WebUI, CLI, this API, …). */
function sourceLabel(source: string): string {
  switch (source) {
    case "hermes_browser":
      return "WebUI";
    case "api_server":
      return "API";
    case "cli":
      return "CLI";
    case "codex":
      return "Codex";
    case "openrouter":
      return "OpenRouter";
    default:
      return source.charAt(0).toUpperCase() + source.slice(1);
  }
}

function formatAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Dropdown sheet of past conversations plus, when the provider keeps them, the
 * other sessions persisted there (Hermes WebUI, earlier Codex threads, …).
 * Escape/backdrop-click closes it.
 */
export function HistoryList({
  conversations,
  activeId,
  onPick,
  onDelete,
  onClose,
  serverSessions,
  serverLoading,
  onPickServer,
  providerName,
  className,
  backdropClassName,
}: {
  providerName: string;
  /** Where the sheet sits, under its button. */
  className?: string;
  /** What the click-away backdrop covers. */
  backdropClassName?: string;
  conversations: Conversation[];
  activeId: string;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  /** Undefined when the server has no Sessions API (section hidden). */
  serverSessions?: ChatSession[];
  serverLoading: boolean;
  onPickServer: (session: ChatSession) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const all = conversations.filter((c) => !isBlank(c));
  const items = all.filter((c) => matches(c.title));
  const showServer = serverSessions !== undefined || serverLoading;
  const server = (serverSessions ?? []).filter((s) => matches(s.title || s.preview || s.id));
  const nothingYet = all.length === 0 && (serverSessions?.length ?? 0) === 0 && !serverLoading;
  // Section labels only when there are two sections to tell apart.
  const labelled = showServer && all.length > 0;

  const row =
    "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]";
  return (
    <>
      <div
        className={cn("absolute inset-x-0 bottom-0 z-10", backdropClassName)}
        onClick={onClose}
        aria-hidden
      />
      {/* Under the History button, like a menu, not across the window. */}
      <div
        className={cn(
          "absolute z-20 flex max-h-[70%] w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-xl border border-foreground/10 bg-popover text-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]",
          className,
        )}
      >
        {nothingYet ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <HistoryIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />
            <span className="text-sm text-foreground">No past chats yet</span>
            <span className="text-[13px] text-muted-foreground">
              Chats you finish show up here.
            </span>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-foreground/10 px-3 py-2">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {labelled ? (
                <div className="px-2 pb-1 pt-1 text-[13px] text-muted-foreground">Recent</div>
              ) : null}
              {items.map((c) => (
                <div key={c.id} className="group/row relative">
                  <button type="button" onClick={() => onPick(c.id)} className={row}>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.id === activeId ? (
                      <CheckIcon className="size-4 shrink-0 text-foreground group-hover/row:invisible" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground group-hover/row:invisible">
                        {formatAgo(c.updatedAt)}
                      </span>
                    )}
                  </button>
                  {/* Delete takes the time's place on hover. */}
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    aria-label="Delete chat"
                    title="Delete chat"
                    className="absolute right-1 top-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/[0.08] hover:text-destructive-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              ))}
              {showServer ? (
                <>
                  {labelled ? (
                    <div className="px-2 pb-1 pt-2.5 text-[13px] text-muted-foreground">
                      On {providerName}
                    </div>
                  ) : null}
                  {server.map((sess) => (
                    <button
                      key={sess.id}
                      type="button"
                      onClick={() => onPickServer(sess)}
                      title={sourceLabel(sess.source)}
                      className={row}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {sess.title || sess.preview || sess.id}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatAgo(sess.lastActive)}
                      </span>
                    </button>
                  ))}
                  {serverLoading && server.length === 0 ? (
                    <div className="px-2 py-2 text-[13px] text-muted-foreground">
                      Loading {providerName} sessions…
                    </div>
                  ) : null}
                </>
              ) : null}
              {q && items.length === 0 && server.length === 0 ? (
                <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  No chats match “{query.trim()}”
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}
