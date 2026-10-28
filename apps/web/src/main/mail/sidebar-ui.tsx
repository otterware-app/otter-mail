/**
 * What the sidebar is built from (Notion's): the New row, sections of rows,
 * and the scrolling body. Its Mail and Chats pages draw with these.
 */

import {
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { ScrollArea } from "~/components/ui/scroll-area";

import type { KeybindingCommand } from "../keybindings/commands";
import { HintTooltip, UnreadPill } from "./ui";

export type RowDragProps = {
  draggable?: boolean;
  onDragStart?: (e: ReactDragEvent<HTMLButtonElement>) => void;
  onDragOver?: (e: ReactDragEvent<HTMLButtonElement>) => void;
  onDragLeave?: (e: ReactDragEvent<HTMLButtonElement>) => void;
  onDrop?: (e: ReactDragEvent<HTMLButtonElement>) => void;
};

/** A sidebar row's box (Settings' nav mirrors it). */
export const SIDEBAR_ROW =
  "group flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg text-left text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:bg-sidebar-row-active";

/** A space's New row (ChatGPT's "New chat"): the first thing under the heading. */
export function NewRow({
  icon,
  label,
  shortcut,
  tour,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: KeybindingCommand;
  /** Its `data-tour` part, for the tour's spotlight. */
  tour?: string;
  onClick: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col px-(--sidebar-content-inset)" data-tour={tour}>
      <HintTooltip label={label} shortcut={shortcut}>
        <button
          type="button"
          onClick={onClick}
          className={`${SIDEBAR_ROW} px-(--sidebar-row-content-inset) text-sidebar-foreground hover:bg-sidebar-row-hover`}
        >
          <span className="flex shrink-0 text-sidebar-muted-foreground group-hover:text-sidebar-foreground [&_svg]:size-4">
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </button>
      </HintTooltip>
    </div>
  );
}

/** A sidebar's scrolling body, under its heading and New row. */
export function SidebarBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea
      className="flex-1"
      viewportClassName="scroll-fade-y px-(--sidebar-content-inset) pb-8 pt-3"
    >
      {children}
    </ScrollArea>
  );
}

/** Sidebar row (Codex): 14px regular text, muted icon, a rounded pill on hover
    and when selected; counts live in the badge only. */
export function SkRow({
  icon,
  title,
  selected,
  badge,
  trailing,
  depth = 0,
  onClick,
  dragProps,
  dropActive,
  dot,
}: {
  icon: ReactNode;
  title: string;
  selected?: boolean;
  badge?: number;
  trailing?: ReactNode;
  depth?: number;
  onClick?: () => void;
  dragProps?: RowDragProps;
  dropActive?: boolean;
  /** A small dot on the right: something is waiting here (a kept search). */
  dot?: boolean;
}) {
  const style: CSSProperties = { paddingLeft: 10 + depth * 16 };
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      {...dragProps}
      className={[
        SIDEBAR_ROW,
        "pr-(--sidebar-row-content-inset)",
        selected
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        dropActive ? "bg-sidebar-row-hover ring-1 ring-inset ring-primary/70" : "",
      ].join(" ")}
    >
      <span
        className={[
          "flex shrink-0 items-center",
          selected
            ? "text-sidebar-foreground"
            : "text-sidebar-muted-foreground group-hover:text-sidebar-foreground",
        ].join(" ")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {trailing ? (
        // One trailing slot: the count at rest, the row action on hover, so
        // the action never reserves dead space next to the count.
        <span className="relative ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end">
          {badge != null && badge > 0 ? (
            <span className="group-hover:invisible group-focus-within:invisible">
              <UnreadPill count={badge} />
            </span>
          ) : null}
          <span className="absolute inset-y-0 right-0 flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {trailing}
          </span>
        </span>
      ) : badge != null ? (
        <UnreadPill count={badge} />
      ) : dot ? (
        <span aria-hidden className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
      ) : null}
    </button>
  );
}

export function Section({
  title,
  action,
  children,
  dropZone,
  tour,
  depth = 0,
  defaultOpen = true,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  /** Folded until opened. */
  defaultOpen?: boolean;
  /** Nested under a row (a mailbox's labels), indented like its rows. */
  depth?: number;
  /** Its `data-tour` part, for the tour's spotlight. */
  tour?: string;
  dropZone?: {
    active: boolean;
    onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
    onDragLeave: (e: ReactDragEvent<HTMLDivElement>) => void;
    onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  };
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={depth > 0 ? "mt-1" : "mt-4"} data-tour={tour}>
      <div
        className={[
          "group flex h-8 items-center gap-1 rounded-lg pr-1",
          dropZone?.active ? "bg-sidebar-row-hover ring-1 ring-inset ring-primary/70" : "",
        ].join(" ")}
        onDragOver={dropZone?.onDragOver}
        onDragLeave={dropZone?.onDragLeave}
        onDrop={dropZone?.onDrop}
      >
        {/* A plain muted heading (Codex's "Projects"); the chevron shows on
            hover, or while the section is collapsed. */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={depth > 0 ? { paddingLeft: 10 + depth * 16 } : undefined}
          className="flex h-8 items-center gap-1 rounded-lg px-(--sidebar-row-content-inset) text-[13px] font-normal text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
          aria-label={`Toggle ${title}`}
        >
          {title}
          <ChevronDownIcon
            className={[
              "size-3.5 transition-[opacity,transform]",
              open ? "opacity-0 group-hover:opacity-100" : "-rotate-90",
            ].join(" ")}
          />
        </button>
        <span className="flex-1" />
        <span className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          {action}
        </span>
      </div>
      {open ? children : null}
    </div>
  );
}

/** A section heading's action button (+). */
const SECTION_ACTION =
  "flex size-6 items-center justify-center rounded-md text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring data-[state=open]:bg-sidebar-row-hover";

export function SectionAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <HintTooltip label={label}>
      <button type="button" aria-label={label} onClick={onClick} className={SECTION_ACTION}>
        <PlusIcon className="size-4" />
      </button>
    </HintTooltip>
  );
}
