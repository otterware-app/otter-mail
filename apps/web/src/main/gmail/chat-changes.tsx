import { useState } from "react";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  FilePenLineIcon,
  ListFilterIcon,
  MailIcon,
  PaletteIcon,
  TagIcon,
} from "lucide-react";
import type { ChatChange } from "./api";
import { cn } from "./ui";
import { toast } from "./toast";

export function chatChangeKey({ target }: ChatChange): string {
  return JSON.stringify([target.kind, "accountId" in target ? target.accountId : null, target.id]);
}

/** One row per result, keeping its latest name and whether this turn created it. */
export function mergeChatChanges(changes: ChatChange[]): ChatChange[] {
  const results = new Map<string, ChatChange>();
  for (const change of changes) {
    const key = chatChangeKey(change);
    const previous = results.get(key);
    results.set(key, {
      ...change,
      title: change.action === "deleted" && previous ? previous.title : change.title,
      action:
        previous?.action === "created" && change.action === "updated" ? "created" : change.action,
    });
  }
  return [...results.values()];
}

const KINDS = {
  draft: { label: "draft", icon: FilePenLineIcon },
  thread: { label: "conversation", icon: MailIcon },
  label: { label: "label", icon: TagIcon },
  view: { label: "view", icon: ListFilterIcon },
  theme: { label: "theme", icon: PaletteIcon },
  event: { label: "event", icon: CalendarIcon },
};

export function ChatChanges({
  changes,
  onOpen,
}: {
  changes: ChatChange[];
  onOpen: (change: ChatChange) => Promise<void>;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  if (changes.length === 0) return null;
  const open = async (change: ChatChange) => {
    const key = chatChangeKey(change);
    setOpening(key);
    try {
      await onOpen(change);
    } catch (error) {
      toast.error("Couldn't open this item", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOpening((current) => (current === key ? null : current));
    }
  };
  return (
    <section aria-label="Chat changes" className="my-2 min-w-0 px-1">
      <ul className="overflow-hidden rounded-lg border border-border/60">
        {changes.map((change) => {
          const key = chatChangeKey(change);
          const { label, icon: Icon } = KINDS[change.target.kind];
          const action = `${change.action[0].toUpperCase()}${change.action.slice(1)}`;
          const description = `${action} ${label}`;
          const canOpen =
            change.action !== "deleted" &&
            (change.target.kind !== "event" || Boolean(change.target.url));
          const content = (
            <>
              <Icon className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {change.title}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">{action}</span>
              {canOpen ? (
                <ArrowUpRightIcon className="size-3 shrink-0 text-icon-muted" aria-hidden />
              ) : null}
            </>
          );
          const rowClass = "flex w-full items-center gap-2 px-2 py-1 text-left";
          return (
            <li key={key} className="border-b border-border/40 last:border-b-0">
              {canOpen ? (
                <button
                  type="button"
                  aria-label={`Open ${label}: ${change.title}`}
                  title={`${description}: ${change.title}`}
                  aria-busy={opening === key}
                  onClick={() => void open(change)}
                  className={cn(
                    rowClass,
                    "outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
                    opening === key && "animate-status-pulse",
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className={rowClass} title={`${description}: ${change.title}`}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
