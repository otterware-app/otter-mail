import { useLatest } from "../use-latest";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  CircleUserRoundIcon,
  EllipsisIcon,
  GripVerticalIcon,
  LayersIcon,
  LogInIcon,
  MessageSquareIcon,
  PlusIcon,
  RotateCwIcon,
  SettingsIcon,
} from "lucide-react";
import { AgentIcon } from "./agent-icon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./menu";
import { HintTooltip, cn } from "./ui";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { arrangeAccounts, setMailboxArrangement, useMailboxArrangement } from "../mailboxes";
import { useAccounts } from "./hooks";
import { AccountPicture } from "./account-picture";
import { useViewUnreadCounts } from "./hooks";
import type { MailboxOption } from "./top-bar";
import { useInboxUnread, useMailboxOptions } from "./top-bar";
import type { GmailAccount, MailView } from "./types";
import type { SettingsPane } from "./api";
import { useOtterAccount } from "../otter-account";
import { OtterAvatar } from "../settings/otter-account-pane";
import { requestProblemReport } from "../support/report-problem";
import { setSyncedPreference } from "../synced-preferences";
import { CHATS_SPACE } from "./spaces";
import { ViewMark } from "./view-icon";
import { shortcutText } from "../keybindings/keys";

/** A rail button: a square that lights up on hover, and stays lit where you are. */
const RAIL_BUTTON =
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring data-[state=open]:bg-sidebar-row-hover";
const RAIL_BUTTON_SELECTED = "bg-sidebar-row-selected text-sidebar-foreground";

const UNREAD_DOTS = "gmail:rail-unread-dots";
const RAIL = "gmail:rail";

/** Whether the rail dots the spaces with unread mail (Settings › General; off unless turned on). */
export function useRailUnreadDots(): [boolean, (on: boolean) => void] {
  const read = () => localStorage.getItem(UNREAD_DOTS) === "1";
  const [on, setOn] = useState(read);
  const readForEffect = useLatest(read);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === UNREAD_DOTS) setOn(readForEffect.current());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [readForEffect]);
  const set = (next: boolean) => {
    setSyncedPreference(UNREAD_DOTS, next ? "1" : "0");
    // The rail (another component) follows at once.
    window.dispatchEvent(new StorageEvent("storage", { key: UNREAD_DOTS }));
  };
  return [on, set];
}

/**
 * The rail's arrangement, on every device: the spaces kept out of it (they
 * wait in its … menu; new ones show) and the views' order. The mailboxes'
 * order is theirs (mailboxes.ts), the same as Settings › Mailboxes and ⌘1–9.
 */
type RailArrangement = { hidden: string[]; views: string[] };

function readRail(): RailArrangement {
  try {
    const value = JSON.parse(localStorage.getItem(RAIL) ?? "{}") as Partial<RailArrangement>;
    return { hidden: value.hidden ?? [], views: value.views ?? [] };
  } catch {
    return { hidden: [], views: [] };
  }
}

function useRail(): [RailArrangement, (next: RailArrangement) => void] {
  const [rail, setRail] = useState(readRail);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === RAIL) setRail(readRail());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const set = (next: RailArrangement) => {
    setSyncedPreference(RAIL, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key: RAIL }));
  };
  return [rail, set];
}

/** `items` in `order` (by id); ones it doesn't list follow, as they were. */
function inOrder<T extends { id: string }>(items: T[], order: string[]): T[] {
  const rank = (item: T) => {
    const i = order.indexOf(item.id);
    return i === -1 ? order.length : i;
  };
  return items
    .map((item, at) => ({ item, at }))
    .sort((x, y) => rank(x.item) - rank(y.item) || x.at - y.at)
    .map((x) => x.item);
}

/**
 * The rail down the window's left edge (ChatGPT's): the spaces (spaces.ts).
 * Each mailbox, then each view, then Chats (the AI workspace), then … (Otter
 * Code's): the spaces kept out of the rail, what the rail shows, and New
 * view. Who you are at the bottom, with the app's menu. With the setting on,
 * a dot marks a mailbox whose Inbox (or a view whose list) has unread mail.
 * It stays when the sidebar hides; then hovering a mailbox or Chats peeks at
 * its sidebar (`onHoverSpace`).
 */
export function SpaceRail({
  accounts,
  views: allViews,
  onNewView,
  onEditView,
  onHoverSpace,
  selectedSpaceId,
  onSelectSpace,
  settingsOpen,
  onOpenSettings,
  onSync,
  syncing,
}: {
  accounts: GmailAccount[];
  /** The custom views, each a space. */
  views: MailView[];
  onNewView: () => void;
  onEditView: (viewId: string) => void;
  /**
   * The space under the pointer, if it has a sidebar to peek at; null when it
   * leaves. Absent while the sidebar shows: the rail has tooltips instead.
   */
  onHoverSpace?: (spaceId: string | null) => void;
  /** The space showing; none is lit while Settings is. */
  selectedSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  settingsOpen: boolean;
  /** The app's menu: Settings (a pane, General by default) and Sync now. */
  onOpenSettings: (pane?: SettingsPane) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const options = useMailboxOptions(accounts);
  const [dots] = useRailUnreadDots();
  const [rail, setRail] = useRail();
  const hidden = new Set(rail.hidden);
  const setHidden = (id: string, hide: boolean) =>
    setRail({
      ...rail,
      hidden: hide
        ? [...rail.hidden.filter((h) => h !== id), id]
        : rail.hidden.filter((h) => h !== id),
    });
  const views = inOrder(allViews, rail.views);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [customizing, setCustomizing] = useState(false);
  const unread = useInboxUnread(accounts);
  const viewUnread = useViewUnreadCounts(views, accounts, dots);

  const shownOptions = options.filter((option) => !hidden.has(option.id));
  const shownViews = views.filter((view) => !hidden.has(view.id));
  const chatsShown = !hidden.has(CHATS_SPACE);
  const offRail = [
    ...options
      .filter((option) => hidden.has(option.id))
      .map((option) => ({ id: option.id, name: option.name, mark: mailboxMark(option, "size-5") })),
    ...views
      .filter((view) => hidden.has(view.id))
      .map((view) => ({ id: view.id, name: view.name, mark: <ViewMark view={view} /> })),
    ...(chatsShown ? [] : [{ id: CHATS_SPACE, name: "Chats", mark: <AgentIcon /> }]),
  ];
  // The space showing is one kept out of the rail: … stands for it.
  const elsewhere = !settingsOpen && offRail.some((space) => space.id === selectedSpaceId);

  /** A space's square: lit where you are, a dot for unread mail; named by a tooltip unless it peeks. */
  const spaceButton = ({
    id,
    name,
    mark,
    dot = false,
    peek,
    shortcut,
    tour,
  }: {
    id: string;
    name: string;
    mark: ReactNode;
    dot?: boolean;
    /** It has a sidebar to peek at. */
    peek: boolean;
    shortcut?: string;
    tour?: string;
  }) => {
    const selected = !settingsOpen && id === selectedSpaceId;
    const peeks = peek && onHoverSpace != null;
    const button = (
      <button
        type="button"
        aria-label={name}
        aria-current={selected ? "page" : undefined}
        data-tour={tour}
        onClick={() => onSelectSpace(id)}
        onMouseEnter={() => onHoverSpace?.(peeks ? id : null)}
        onDragEnter={() => onHoverSpace?.(peeks ? id : null)}
        className={cn(RAIL_BUTTON, selected && RAIL_BUTTON_SELECTED)}
      >
        {mark}
        {dot && dots ? (
          <span
            aria-hidden
            className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-sidebar-foreground"
          />
        ) : null}
      </button>
    );
    return peeks ? (
      button
    ) : (
      <HintTooltip label={name} hint={shortcut} side="right">
        {button}
      </HintTooltip>
    );
  };

  return (
    <nav
      aria-label="Spaces"
      data-app-sidebar=""
      onMouseLeave={() => onHoverSpace?.(null)}
      className="flex w-(--workspace-rail-width) shrink-0 flex-col items-center pb-(--sidebar-content-inset) text-sidebar-foreground"
    >
      {/* Under the title band, and past the panel's rounded corner: level with
          the sidebar's heading. A browser tab has no title band: the first
          space sits in line with the columns' headers. */}
      <div
        aria-hidden
        className="drag-region h-(--workspace-topbar-height) w-full shrink-0 web:hidden"
      />
      <div
        className="mt-(--radius-xl) flex flex-col items-center gap-1 web:mt-[calc((var(--workspace-topbar-height)-2.25rem)/2)]"
        data-tour="mailbox"
      >
        {shownOptions.map((option) => (
          <span key={option.id} className="contents">
            {spaceButton({
              id: option.id,
              name: option.name,
              mark: mailboxMark(option, "size-6"),
              dot: (unread[option.id] ?? 0) > 0,
              peek: true,
              shortcut: option.shortcut,
            })}
          </span>
        ))}
        {/* Views (filters across the mailboxes). Mailboxes are added in Settings › Mailboxes. */}
        {shownViews.length > 0 ? <span aria-hidden className="my-1 h-px w-5 bg-border" /> : null}
        {shownViews.map((view) => (
          <ContextMenu key={view.id}>
            <ContextMenuTrigger>
              {spaceButton({
                id: view.id,
                name: view.name,
                mark: <ViewMark view={view} />,
                dot: (viewUnread[view.id] ?? 0) > 0,
                peek: false,
              })}
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => onEditView(view.id)}>Edit view…</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        {/* The AI workspace spans every mailbox: a space of its own, after them. */}
        {chatsShown ? (
          <>
            <span aria-hidden className="my-1 h-px w-5 bg-border" />
            {spaceButton({
              id: CHATS_SPACE,
              name: "Chats",
              mark: <AgentIcon className="size-5" />,
              peek: true,
              shortcut: shortcutText("mod+shift+f"),
              tour: "chats",
            })}
          </>
        ) : null}
        <DropdownMenu>
          <HintTooltip label="More" side="right">
            <DropdownMenuTrigger asChild>
              <button
                ref={moreRef}
                type="button"
                aria-label="More"
                onMouseEnter={() => onHoverSpace?.(null)}
                className={cn(RAIL_BUTTON, elsewhere && RAIL_BUTTON_SELECTED)}
              >
                <EllipsisIcon className="size-5" />
              </button>
            </DropdownMenuTrigger>
          </HintTooltip>
          <DropdownMenuContent side="right" align="start" className="max-h-96 min-w-60">
            {/* Kept out of the rail, they're here to go to. */}
            {offRail.length > 0 ? (
              <>
                {offRail.map((space) => (
                  <DropdownMenuItem
                    key={space.id}
                    icon={space.mark}
                    onSelect={() => onSelectSpace(space.id)}
                  >
                    {space.name}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuLabel>Spaces in the rail</DropdownMenuLabel>
            {[...options, { id: CHATS_SPACE, name: "Chats" }].map((space) => (
              <DropdownMenuCheckboxItem
                key={space.id}
                checked={!hidden.has(space.id)}
                onCheckedChange={(on) => setHidden(space.id, !on)}
                // Stays open to pick several.
                onSelect={(e) => e.preventDefault()}
              >
                {space.name}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Views in the rail</DropdownMenuLabel>
            {views.map((view) => (
              <DropdownMenuCheckboxItem
                key={view.id}
                checked={!hidden.has(view.id)}
                onCheckedChange={(on) => setHidden(view.id, !on)}
                onSelect={(e) => e.preventDefault()}
              >
                {view.name}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuItem icon={<PlusIcon />} onSelect={onNewView}>
              New view…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* After the menu has closed, or its closing takes the popover with it. */}
            <DropdownMenuItem onSelect={() => setTimeout(() => setCustomizing(true))}>
              Customize…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <RailCustomize
          open={customizing}
          onOpenChange={setCustomizing}
          anchor={moreRef}
          options={options}
          views={views}
          hidden={hidden}
          onToggle={setHidden}
          onReorderViews={(order) => setRail({ ...rail, views: order })}
        />
      </div>
      <span className="flex-1" />
      <AccountMenu
        active={settingsOpen}
        onOpenSettings={onOpenSettings}
        onSync={onSync}
        syncing={syncing}
      />
    </nav>
  );
}

type Group = "mailboxes" | "views";

/**
 * The rail's Customize (Otter Code's): each space ticked to stand in the
 * rail, and dragged by its grip into order, mailboxes among mailboxes and
 * views among views. All mailboxes stays first, and Chats last.
 */
function RailCustomize({
  open,
  onOpenChange,
  anchor,
  options,
  views,
  hidden,
  onToggle,
  onReorderViews,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLButtonElement | null>;
  options: MailboxOption[];
  views: MailView[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string, hide: boolean) => void;
  onReorderViews: (order: string[]) => void;
}) {
  const allAccounts = useAccounts().data ?? [];
  const arrangement = useMailboxArrangement();
  const [drag, setDrag] = useState<{ group: Group; id: string } | null>(null);
  const [spot, setSpot] = useState<{ id: string; after: boolean } | null>(null);

  /** Moves `id` before or after `to.id`, in `order`. */
  const moved = (order: string[], id: string, to: { id: string; after: boolean }) => {
    const rest = order.filter((each) => each !== id);
    rest.splice(rest.indexOf(to.id) + (to.after ? 1 : 0), 0, id);
    return rest;
  };
  const drop = () => {
    if (drag && spot && drag.id !== spot.id) {
      if (drag.group === "views")
        onReorderViews(
          moved(
            views.map((view) => view.id),
            drag.id,
            spot,
          ),
        );
      else {
        // Mailboxes go by address, turned-off ones included (mailboxes.ts).
        const email = (id: string) => options.find((option) => option.id === id)?.account?.email;
        const from = email(drag.id);
        const to = email(spot.id);
        const order = arrangeAccounts(allAccounts, arrangement).map((account) => account.email);
        if (from && to)
          setMailboxArrangement({
            ...arrangement,
            order: moved(order, from, { id: to, after: spot.after }),
          });
      }
    }
    setDrag(null);
    setSpot(null);
  };

  const row = (id: string, name: string, mark: ReactNode, group?: Group) => (
    <div
      key={id}
      draggable={group != null}
      onDragStart={(e) => {
        if (!group) return;
        e.dataTransfer.effectAllowed = "move";
        setDrag({ group, id });
      }}
      onDragOver={(e) => {
        if (!group || drag?.group !== group) return;
        e.preventDefault();
        const box = e.currentTarget.getBoundingClientRect();
        setSpot(drag.id === id ? null : { id, after: e.clientY > box.top + box.height / 2 });
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop();
      }}
      onDragEnd={() => {
        setDrag(null);
        setSpot(null);
      }}
      className={cn("relative flex h-9 items-center gap-2 px-2", drag?.id === id && "opacity-40")}
    >
      {spot?.id === id ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary",
            spot.after ? "-bottom-px" : "-top-px",
          )}
        />
      ) : null}
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm text-foreground">
        <input
          type="checkbox"
          checked={!hidden.has(id)}
          onChange={(e) => onToggle(id, !e.target.checked)}
        />
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-4.5">
          {mark}
        </span>
        <span className="truncate">{name}</span>
      </label>
      {group ? (
        <GripVerticalIcon
          aria-hidden
          className="size-4 shrink-0 cursor-grab text-muted-foreground"
        />
      ) : null}
    </div>
  );
  const heading = (title: string) => (
    <div className="px-2 pt-2 pb-1 text-[13px] text-muted-foreground">{title}</div>
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup anchor={anchor} side="right" align="end" width="sm" padding="compact">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[13px] text-muted-foreground">Customize</span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="cursor-pointer rounded px-1 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Done
          </button>
        </div>
        {heading("Mailboxes")}
        {options.map((option) =>
          row(
            option.id,
            option.name,
            mailboxMark(option, "size-5"),
            option.account ? "mailboxes" : undefined,
          ),
        )}
        {views.length > 0 ? heading("Views") : null}
        {views.map((view) => row(view.id, view.name, <ViewMark view={view} />, "views"))}
        <div aria-hidden className="mx-2 my-1 h-px bg-border/70" />
        {row(CHATS_SPACE, "Chats", <AgentIcon />)}
      </PopoverPopup>
    </Popover>
  );
}

/** A mailbox's picture, or All mailboxes' layers. */
function mailboxMark(option: { account?: GmailAccount | null }, size: "size-5" | "size-6") {
  return option.account ? (
    <AccountPicture
      account={option.account}
      className={cn(size, "rounded-md", size === "size-6" ? "text-[11px]" : "text-[10px]")}
    />
  ) : (
    <LayersIcon className="size-5" />
  );
}

/**
 * The rail's foot: the Otter account (or a placeholder when signed out),
 * opening the app's menu: the account (or Sign in), Settings, feedback, and
 * Sync now (only while push isn't live; ⌘, and ⌘R work either way).
 */
function AccountMenu({
  active,
  onOpenSettings,
  onSync,
  syncing,
}: {
  /** Settings is showing. */
  active: boolean;
  onOpenSettings: (pane?: SettingsPane) => void;
  onSync: () => void;
  syncing: boolean;
}) {
  const otter = useOtterAccount();
  const user = otter?.user ?? null;
  return (
    <DropdownMenu>
      <HintTooltip label={user ? (user.name ?? user.email) : "Settings"} side="right">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account and settings"
            className={cn(RAIL_BUTTON, active && RAIL_BUTTON_SELECTED)}
          >
            {user ? (
              <OtterAvatar user={user} className="size-6" />
            ) : (
              <CircleUserRoundIcon className="size-5" />
            )}
          </button>
        </DropdownMenuTrigger>
      </HintTooltip>
      <DropdownMenuContent side="right" align="end" className="min-w-56">
        {user ? (
          <DropdownMenuItem
            icon={<OtterAvatar user={user} className="size-5" />}
            onSelect={() => onOpenSettings("otter")}
            className="h-auto py-1.5"
          >
            <span className="block truncate text-foreground">{user.name ?? user.email}</span>
            {user.name ? (
              <span className="block truncate text-[13px] text-muted-foreground">{user.email}</span>
            ) : null}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon={<LogInIcon />} onSelect={() => onOpenSettings("otter")}>
            Sign in to Otter Mail
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<SettingsIcon />}
          accelerator={shortcutText("mod+,")}
          onSelect={() => onOpenSettings()}
        >
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem icon={<MessageSquareIcon />} onSelect={requestProblemReport}>
          Send feedback
        </DropdownMenuItem>
        {otter?.realtime === "live" ? null : (
          <DropdownMenuItem
            icon={<RotateCwIcon className={syncing ? "animate-spin" : undefined} />}
            accelerator={shortcutText("mod+r")}
            disabled={syncing}
            onSelect={onSync}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
