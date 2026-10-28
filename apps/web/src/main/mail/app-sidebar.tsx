/**
 * The sidebar, the window's only one (Notion's): Search or ask (the command
 * palette), a tab for each mailbox and one for Chats, then the tab's page. A mailbox: New message, its folders and
 * labels, then the views. Chats: the AI workspace's chats. Sync health, an
 * update and you (with Settings) at its foot.
 */

import { useState, type ReactNode } from "react";
import {
  CircleUserRoundIcon,
  LogInIcon,
  MessageSquareIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
} from "lucide-react";

import { shortcutText } from "../keybindings/keys";
import { useShortcutLabel } from "../keybindings/store";
import { useOtterAccount } from "../otter-account";
import { OtterAvatar } from "../settings/otter-account-pane";
import { requestProblemReport } from "../support/report-problem";
import { UpdateCard } from "../updates";
import { AccountPicture } from "./account-picture";
import { MailboxFolders, SearchRow, type SidebarSearch } from "./accounts-sidebar";
import { AddMailboxMenu } from "./add-mailbox";
import { AgentIcon } from "./agent-icon";
import type { SettingsPane } from "./api";
import { ChatsSidebar } from "./chats-sidebar";
import { useAddAccount, useViewUnreadCounts } from "./hooks";
import { ScheduledMailButton } from "./mail-schedule";
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
import { NewRow, SIDEBAR_ROW, Section, SectionAddButton, SidebarBody, SkRow } from "./sidebar-ui";
import { CHATS_SPACE, VIEW_LIST } from "./spaces";
import { MailboxHealth } from "./sync-health";
import { toast } from "./toast";
import { useInboxUnread, useMailboxOptions, type MailboxOption } from "./top-bar";
import type { MailAccount, MailView } from "./types";
import { HintTooltip, cn } from "./ui";
import { ViewMark } from "./view-icon";

export function AppSidebar({
  accounts,
  views,
  spaceId,
  labelId,
  settingsOpen,
  onGo,
  onCompose,
  onNewChat,
  onNewView,
  onEditView,
  onOpenPalette,
  onOpenSettings,
  onSync,
  syncing,
  searches,
  onSelectSearch,
  onCloseSearch,
}: {
  /** The mailboxes that are on. */
  accounts: MailAccount[];
  /** The user's views. */
  views: MailView[];
  /** The space showing (spaces.ts), and its folder, label, list or chat. */
  spaceId: string | null;
  labelId: string;
  settingsOpen: boolean;
  /** Goes to a space: where it opens, or `labelId` in it. */
  onGo: (spaceId: string, labelId?: string) => void;
  onCompose: () => void;
  onNewChat: () => void;
  onNewView: () => void;
  onEditView: (viewId: string) => void;
  onOpenPalette: () => void;
  /** The account menu's Settings (a pane, General by default). */
  onOpenSettings: (pane?: SettingsPane) => void;
  onSync: () => void;
  syncing: boolean;
  /** Searches opened from a folder (⌘F), nested under it. */
  searches: SidebarSearch[];
  onSelectSearch: (id: string) => void;
  onCloseSearch: (id: string) => void;
}) {
  const chats = spaceId === CHATS_SPACE;
  const options = useMailboxOptions(accounts);
  const isMailbox = (id: string | null) => options.some((option) => option.id === id);
  // The mailbox whose folders show: the one you're in, or (in Chats or a
  // view) the one you were last in.
  const [lastMailbox, setLastMailbox] = useState<string | null>(null);
  if (isMailbox(spaceId) && spaceId !== lastMailbox) setLastMailbox(spaceId);
  const mailbox = isMailbox(spaceId)
    ? spaceId
    : isMailbox(lastMailbox)
      ? lastMailbox
      : (options[0]?.id ?? null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 px-(--sidebar-content-inset) pb-2 pt-(--sidebar-content-inset)">
        <SearchField onOpen={onOpenPalette} />
        <SidebarTabs
          options={options}
          accounts={accounts}
          selectedId={chats ? CHATS_SPACE : mailbox}
          onSelect={(id) => onGo(id)}
        />
      </div>
      {chats ? (
        <ChatsSidebar
          selectedId={labelId}
          onSelect={(id) => onGo(CHATS_SPACE, id)}
          onNewChat={onNewChat}
        />
      ) : (
        <MailPage
          accounts={accounts}
          views={views}
          mailbox={mailbox}
          spaceId={spaceId}
          labelId={labelId}
          onGo={onGo}
          onCompose={onCompose}
          onNewView={onNewView}
          onEditView={onEditView}
          searches={searches}
          onSelectSearch={onSelectSearch}
          onCloseSearch={onCloseSearch}
        />
      )}
      {chats ? null : (
        <MailboxHealth
          accountIds={
            accounts.some((a) => a.id === spaceId) && spaceId
              ? [spaceId]
              : accounts.map((a) => a.id)
          }
        />
      )}
      <UpdateCard />
      <AccountMenu
        active={settingsOpen}
        onOpenSettings={onOpenSettings}
        onSync={onSync}
        syncing={syncing}
      />
    </div>
  );
}

/** Notion's "Search or ask": the command palette, which searches mail and asks the agent. */
function SearchField({ onOpen }: { onOpen: () => void }) {
  const shortcut = useShortcutLabel("commandPalette.toggle");
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border border-sidebar-line bg-canvas/60 ps-2.5 pe-1.5 text-sm text-sidebar-muted-foreground outline-none transition-colors hover:border-input hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <SearchIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search or ask</span>
      {shortcut ? (
        <kbd className="shrink-0 rounded-md bg-sidebar-row-hover px-1.5 font-sans text-[11px] leading-5 text-sidebar-muted-foreground">
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

/**
 * The tabs (Notion's Home, Chat, Meetings): each mailbox, then Chats. The one
 * showing is named, the others are their pictures (a dot for unread mail).
 * Switching slides: one name opens as the other folds.
 */
function SidebarTabs({
  options,
  accounts,
  selectedId,
  onSelect,
}: {
  options: MailboxOption[];
  accounts: MailAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const unread = useInboxUnread(accounts);
  const tab = ({
    id,
    label,
    icon,
    hint,
    dot = false,
    tour,
  }: {
    id: string;
    label: string;
    icon: ReactNode;
    hint?: string;
    dot?: boolean;
    tour?: string;
  }) => {
    const selected = id === selectedId;
    return (
      <HintTooltip key={id} label={label} hint={hint} disabled={selected}>
        <button
          type="button"
          aria-label={label}
          aria-current={selected ? "page" : undefined}
          data-tour={tour}
          onClick={() => onSelect(id)}
          className={cn(
            "flex h-8 min-w-0 shrink-0 cursor-pointer items-center rounded-lg px-1.5 text-sm font-medium outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none",
            selected
              ? "shrink bg-sidebar-row-selected text-sidebar-foreground"
              : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          )}
        >
          <span className="relative flex size-5 shrink-0 items-center justify-center [&>svg]:size-4">
            {icon}
            {dot && !selected ? (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-sidebar-foreground ring-2 ring-sidebar-surface"
              />
            ) : null}
          </span>
          {/* Its width opens from nothing (a grid track 0fr → 1fr, its padding
              clipped while folded), and it fades in. */}
          <span
            aria-hidden
            className={cn(
              "grid min-w-0 overflow-hidden transition-[grid-template-columns,opacity] duration-200 ease-out motion-reduce:transition-none",
              selected
                ? "grid-cols-[minmax(0,1fr)] opacity-100"
                : "grid-cols-[minmax(0,0fr)] opacity-0",
            )}
          >
            <span className="truncate ps-2 pe-1">{label}</span>
          </span>
        </button>
      </HintTooltip>
    );
  };
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-tour="mailbox">
      {options.map((option) =>
        tab({
          id: option.id,
          label: option.name,
          icon: (
            <AccountPicture account={option.account} className="size-5 rounded-md text-[10px]" />
          ),
          hint: option.shortcut,
          dot: (unread[option.id] ?? 0) > 0,
        }),
      )}
      {tab({ id: CHATS_SPACE, label: "Chats", icon: <AgentIcon />, tour: "chats" })}
    </div>
  );
}

function MailPage({
  accounts,
  views,
  mailbox,
  spaceId,
  labelId,
  onGo,
  onCompose,
  onNewView,
  onEditView,
  searches,
  onSelectSearch,
  onCloseSearch,
}: {
  accounts: MailAccount[];
  views: MailView[];
  /** The mailbox whose folders show (its tab is the one picked). */
  mailbox: string | null;
  spaceId: string | null;
  labelId: string;
  onGo: (spaceId: string, labelId?: string) => void;
  onCompose: () => void;
  onNewView: () => void;
  onEditView: (viewId: string) => void;
  searches: SidebarSearch[];
  onSelectSearch: (id: string) => void;
  onCloseSearch: (id: string) => void;
}) {
  const viewUnread = useViewUnreadCounts(views, accounts);
  const addAccount = useAddAccount();
  const showing = mailbox != null && mailbox === spaceId;

  const addGmail = async () => {
    console.log("[AppSidebar:addAccount]");
    try {
      const account = await addAccount.mutateAsync();
      if (account) onGo(account.id);
    } catch (err) {
      toast.error("Couldn't add the account", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };
  const searchRows = (parent: string, depth: number) =>
    searches
      .filter((search) => search.parent === parent)
      .map((search) => (
        <SearchRow
          key={search.id}
          search={search}
          depth={depth}
          onSelect={() => onSelectSearch(search.id)}
          onClose={() => onCloseSearch(search.id)}
        />
      ));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NewRow
        icon={<SquarePenIcon />}
        label="New message"
        shortcut="compose.new"
        tour="compose"
        onClick={onCompose}
      />
      <ScheduledMailButton />
      <SidebarBody>
        {mailbox ? (
          <MailboxFolders
            key={mailbox}
            mailboxId={mailbox}
            selectedLabelId={showing ? labelId : ""}
            onSelectLabel={(label) => onGo(mailbox, label)}
            searchRows={showing ? searchRows : undefined}
          />
        ) : (
          <AddMailboxMenu onGmail={() => void addGmail()} onAdded={(a) => onGo(a.id)}>
            <button
              type="button"
              className={`${SIDEBAR_ROW} px-(--sidebar-row-content-inset) text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground`}
            >
              <PlusIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
              <span className="truncate">Add mailbox</span>
            </button>
          </AddMailboxMenu>
        )}

        {/* Views: one list of what their filters find, across the mailboxes. */}
        <Section title="Views" action={<SectionAddButton label="New view" onClick={onNewView} />}>
          {views.map((view) => (
            <ContextMenu key={view.id}>
              <ContextMenuTrigger>
                <SkRow
                  icon={
                    <span className="flex size-4 items-center justify-center [&>svg]:size-4">
                      <ViewMark view={view} className="text-[14px]" />
                    </span>
                  }
                  title={view.name}
                  selected={view.id === spaceId}
                  badge={viewUnread[view.id] ?? 0}
                  onClick={() => onGo(view.id, VIEW_LIST)}
                />
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onEditView(view.id)}>Edit view…</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </Section>
      </SidebarBody>
    </div>
  );
}

/**
 * The sidebar's foot: the Otter account (or Settings when signed out),
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
    <div className="shrink-0 px-(--sidebar-content-inset) pb-(--sidebar-content-inset)">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account and settings"
            className={cn(
              SIDEBAR_ROW,
              "px-(--sidebar-row-content-inset) text-sidebar-foreground data-[state=open]:bg-sidebar-row-hover",
              active ? "bg-sidebar-row-selected" : "hover:bg-sidebar-row-hover",
            )}
          >
            {user ? (
              <OtterAvatar user={user} className="size-5" />
            ) : (
              <CircleUserRoundIcon className="size-4 text-sidebar-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">
              {user ? (user.name ?? user.email) : "Settings"}
            </span>
            <SettingsIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-56">
          {user ? (
            <DropdownMenuItem
              icon={<OtterAvatar user={user} className="size-5" />}
              onSelect={() => onOpenSettings("otter")}
              className="h-auto py-1.5"
            >
              <span className="block truncate text-foreground">{user.name ?? user.email}</span>
              {user.name ? (
                <span className="block truncate text-[13px] text-muted-foreground">
                  {user.email}
                </span>
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
    </div>
  );
}
