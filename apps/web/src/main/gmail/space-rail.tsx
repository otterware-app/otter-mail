import { useLatest } from "../use-latest";
import { useEffect, useState, type ReactNode } from "react";
import {
  CircleUserRoundIcon,
  FolderClosedIcon,
  LayersIcon,
  LogInIcon,
  MessageSquareIcon,
  PlusIcon,
  RotateCwIcon,
  SettingsIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./menu";
import { HintTooltip, cn } from "./ui";
import { AccountPicture } from "./account-picture";
import { useViewUnreadCounts } from "./hooks";
import { useInboxUnread, useMailboxOptions } from "./top-bar";
import type { GmailAccount, MailView } from "./types";
import type { SettingsPane } from "./api";
import { useOtterAccount } from "../otter-account";
import { OtterAvatar } from "../settings/otter-account-pane";
import { requestProblemReport } from "../support/report-problem";
import { setSyncedPreference } from "../synced-preferences";
import { PROJECTS_SPACE } from "./spaces";
import { ViewMark } from "./view-icon";

/** A rail button: a square that lights up on hover, and stays lit where you are. */
const RAIL_BUTTON =
  "relative flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring data-[state=open]:bg-sidebar-row-hover";
const RAIL_BUTTON_SELECTED = "bg-sidebar-row-selected text-sidebar-foreground";

const UNREAD_DOTS = "gmail:rail-unread-dots";

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
 * The rail down the window's left edge (ChatGPT's): the spaces (spaces.ts).
 * Each mailbox, then each view with the + that makes one, then Projects; who
 * you are at the bottom, with the app's menu. With the setting on, a dot
 * marks a mailbox whose Inbox (or a view whose list) has unread mail. It stays
 * when the sidebar hides; then hovering a mailbox or Projects peeks at its
 * sidebar (`onHoverSpace`).
 */
export function SpaceRail({
  accounts,
  views,
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
  const unread = useInboxUnread(accounts);
  const viewUnread = useViewUnreadCounts(views, accounts, dots);

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
          the sidebar's heading. */}
      <div aria-hidden className="drag-region h-(--workspace-topbar-height) w-full shrink-0" />
      <div className="mt-(--radius-xl) flex flex-col items-center gap-1" data-tour="mailbox">
        {options.map((option) => (
          <span key={option.id} className="contents">
            {spaceButton({
              id: option.id,
              name: option.name,
              mark: option.account ? (
                <AccountPicture
                  account={option.account}
                  className="size-6 rounded-md text-[11px]"
                />
              ) : (
                <LayersIcon className="size-5" />
              ),
              dot: (unread[option.id] ?? 0) > 0,
              peek: true,
              shortcut: option.shortcut,
            })}
          </span>
        ))}
        {/* Views (filters across the mailboxes), and the + that makes one.
            Mailboxes are added in Settings › Mailboxes. */}
        <span aria-hidden className="my-1 h-px w-5 bg-border" />
        {views.map((view) => (
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
        <HintTooltip label="New view" side="right">
          <button
            type="button"
            aria-label="New view"
            onMouseEnter={() => onHoverSpace?.(null)}
            onClick={onNewView}
            className={RAIL_BUTTON}
          >
            <PlusIcon className="size-4.5" />
          </button>
        </HintTooltip>
        {/* Projects span every mailbox: a space of their own, after them. */}
        <span aria-hidden className="my-1 h-px w-5 bg-border" />
        {spaceButton({
          id: PROJECTS_SPACE,
          name: "Projects",
          mark: <FolderClosedIcon className="size-5" />,
          peek: true,
          tour: "projects",
        })}
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
          accelerator="⌘,"
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
            accelerator="⌘R"
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
