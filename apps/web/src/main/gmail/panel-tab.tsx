import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { cn } from "./ui";

/**
 * One of the agent panel's pill tabs (Codex's): a chat or a browser page.
 * The × closes it (always on the selected tab, on hover otherwise), and so
 * does a middle-click, as in a browser. In a strip too narrow for them all,
 * tabs give way down to a width that still names them, then the strip
 * scrolls, and a tab that gets selected scrolls into view.
 */
export function PanelTab({
  title,
  tooltip = title,
  icon,
  selected,
  onSelect,
  onClose,
}: {
  title: string;
  tooltip?: string;
  icon: ReactNode;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      title={tooltip}
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button === 1) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group/tab flex h-7 min-w-32 max-w-44 shrink cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
        selected
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
      )}
    >
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{title}</span>
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring",
          selected ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100",
        )}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
