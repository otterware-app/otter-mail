import { addEmailToTodoist } from "../integrations/todoist";
import type React from "react";
import type { ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DIM_READ_MESSAGES,
  OPEN_MESSAGES_WITH_ARROWS,
  GROUP_MESSAGES_BY_DAY,
  useInterfaceToggle,
  useMessageListStyle,
} from "../theme/interface-settings";
import { Dialog } from "~/components/ui/dialog";
import { EmptyState } from "~/components/ui/empty-state";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Text } from "~/components/ui/text";
import { SnoozeDialog } from "./mail-schedule";
import { toast } from "./toast";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "./menu";
import {
  ArchiveIcon,
  RotateCwIcon,
  ArchiveXIcon,
  MousePointer2Icon,
  FlagIcon,
  MailIcon,
  MailOpenIcon,
  RotateCcwIcon,
  InboxIcon,
  SearchIcon,
  SearchXIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
  CircleChevronDownIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  PaperclipIcon,
  FolderIcon,
  SquarePenIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { IconBtn, HintTooltip, cn } from "./ui";
import {
  useMessages,
  useCombinedMessages,
  useCombinedCounts,
  useGmailSearch,
  useModifyMessage,
  useModifyThread,
  useTrashMessage,
  useTrashThread,
  useUntrashMessage,
  useUntrashThread,
  useThreads,
  useAllAccountLabels,
  useDeleteThreadsForever,
  useLabelResolver,
  useSyncAccountLabels,
  useAccounts,
} from "./hooks";
import { LabelChip, InboxChip, ImportantMarker } from "./label-chip";
import { SignedOutMailbox } from "./signed-out-mailbox";
import { LabelOverlay, type LabelOverlayMode } from "./label-overlay";
import { useCapabilities } from "./capabilities";
import { moveToFolder, renderLabelChoices, useLabelChoices } from "./label-picker-menu";
import { INBOX_VIEW_ID, STARRED_VIEW_ID, SENT_VIEW_ID, DRAFTS_VIEW_ID } from "./custom-views";
import { isTypingTarget } from "./keyboard";
import { useCommandHandlers } from "../keybindings/dispatch";
import { SEARCH_HINT, SearchHeader } from "./search-header";
import { labelSearchToken, viewSearchQuery } from "./gmail-query";
import { getAccountColor, getAccountDisplayName } from "./account-style";
import { ALL_MAIL_LABEL_ID, SYSTEM_LABEL_NAMES, labelDisplayName } from "./label-names";
import { decodeEntities } from "./text";
import { parseAddressEntry, senderLabel, splitAddressList } from "./address";
import type { GmailAccount, GmailLabel, GmailMessageSummary, ViewRule } from "./types";
import { pickAdvanceTarget } from "./advance-direction";
import { beginUndoGroup, clearUndo } from "./undo";
import { isMoveSourceLabel, setThreadDragImage, writeThreadDrag } from "./thread-drag";
import { useProjectThreads } from "./projects";
import { AddToProjectItems } from "./project-menus";

type ResolveLabel = (accountId: string | undefined, labelId: string) => GmailLabel | undefined;

/** Cross-account query descriptor for the Combined mailbox. */
export type CombinedList = { viewId: string; name: string; rules: ViewRule[] };

/** Mailbox + account identity shown next to the date in Combined view rows.
    mailbox is null when every selection in the view is the same mailbox (e.g.
    built-in Inbox), where naming it on every row would be redundant. */
type CombinedMeta = { mailbox: string | null; accountName: string; accountColor: string };

type MessageListProps = {
  /** Room for the panel toggle when the list fills the workspace. */
  headerTrailing?: ReactNode;
  /** The floating reader shares this list's conversation navigation. */
  renderFloatingReader?: (navigation: ReactNode, title: string) => ReactNode;
  /** Rendered at the start of the title band (window title when the sidebar is hidden). */
  headerLeading?: ReactNode;
  /** Clip the list to the shared panel's corners where it meets the frame. */
  roundedLeft?: boolean;
  roundedRight?: boolean;
  /** A view's space has no sidebar: the list names it, and New message and Edit are here. */
  space?: { name: string; onCompose: () => void; onEdit: () => void };
  /** Active account — used for account-mode queries and as a fallback owner id. */
  accountId: string;
  labelId: string;
  /** When set, the list is cross-account (Combined mailbox). */
  combined: CombinedList | null;
  /** All connected account ids, for resolving label chips across accounts. */
  accountIds: string[];
  /** Connected accounts (name/color), for the Combined view's mailbox-account line. */
  accounts: GmailAccount[];
  selectedMessageId: string | null;
  /** A single message of the selected row's conversation shown on its own. */
  focusedMessageId: string | null;
  /** Selects a row; `focusId` picks one message of its conversation instead
      of the whole conversation. */
  onSelectMessage: (
    messageId: string,
    accountId: string,
    focusId?: string,
    options?: { autoFocusDraft?: boolean },
  ) => void;
  /** Clears the selection (mark-unread returns to the list, Gmail-style). */
  onDeselect: () => void;
  /** Reader actions (archive/trash) advance through here; false = no next row. */
  advanceRef: React.MutableRefObject<(fromMessageId: string) => boolean>;
  /** Reports the multi-selected rows so the chat panel can attach them. */
  onSelectionChange?: (rows: GmailMessageSummary[]) => void;
  /** Opens the in-app agent chat panel. */
  onOpenChat?: () => void;
  /** Opens the Search mailbox prefilled with this mailbox (search icon, ⌘F). */
  onSearchView?: () => void;
  /** This mailbox as a Gmail query (`in:inbox`, `label:acme`), kept current. */
  viewQueryRef?: React.MutableRefObject<string>;

  /** Set when this is the Search mailbox (Gmail's own search). */
  search?: SearchMode;
  /**
   * Set when the list is a project's conversations, or every active
   * project's (ALL_PROJECTS), with `combined` for its cross-mailbox rows
   * (rules empty).
   */
  project?: { id: string };
};

/** The Search mailbox: the query that ran, its account scope, and its controls. */
export type SearchMode = {
  /** Which open search this is (each keeps its own bar state). */
  id: string;
  query: string;
  /** The parent view's operators, kept when clearing. */
  base: string;
  onClear: () => void;
  accountIds: string[];
  onSearch: (q: string) => void;
  onExit: () => void;
  onScope: (accountIds: string[]) => void;
  focusRef: React.RefObject<HTMLInputElement | null>;
  /** Text typed but not run, kept while you're in another mailbox. */
  draft: string;
  onDraftChange: (draft: string) => void;
  /** A message is open in the reader (Escape closes that first). */
  messageOpen: boolean;
};

/** A row's labels: rows are conversations, so the union over its messages
 *  (falls back to the message's own labels for message-level search rows). */
function rowLabels(message: GmailMessageSummary): string[] {
  return message.threadLabelIds ?? message.labelIds;
}

function ruleMailboxName(rule: ViewRule, resolveLabel: ResolveLabel): string | null {
  if (rule.allOf.length === 0) return null;
  return rule.allOf
    .map((labelId) => {
      const label = resolveLabel(rule.accountId, labelId);
      return label ? labelDisplayName(label) : (SYSTEM_LABEL_NAMES[labelId] ?? labelId);
    })
    .join(" + ");
}

function resolveCombinedMeta(
  message: GmailMessageSummary,
  combined: CombinedList | null,
  accounts: GmailAccount[],
  resolveLabel: ResolveLabel,
): CombinedMeta | null {
  if (!combined || !message.accountId) return null;
  // Account-scoped view slices read like plain label browsing — naming the
  // (only) account on every row would be noise.
  if (
    combined.rules.length > 0 &&
    combined.rules.every((r) => r.accountId === combined.rules[0].accountId)
  ) {
    return null;
  }
  const account = accounts.find((a) => a.id === message.accountId);
  if (!account) return null;
  const matched = combined.rules.find(
    (r) =>
      r.accountId === message.accountId &&
      r.allOf.every((id) => rowLabels(message).includes(id)) &&
      !r.noneOf.some((id) => rowLabels(message).includes(id)),
  );
  // Thread representatives may not carry the matched labels themselves (e.g.
  // your own reply in an Inbox view) — still show which account the row is from.
  if (!matched) {
    return {
      mailbox: null,
      accountName: getAccountDisplayName(account),
      accountColor: getAccountColor(account),
    };
  }
  // When the whole view is one mailbox (built-in Inbox/Sent, or the same
  // labels required everywhere), the mailbox prefix is obvious — omit it.
  const mailbox = ruleMailboxName(matched, resolveLabel);
  const uniform = combined.rules.every((r) => ruleMailboxName(r, resolveLabel) === mailbox);
  return {
    mailbox: uniform ? null : mailbox,
    accountName: getAccountDisplayName(account),
    accountColor: getAccountColor(account),
  };
}

function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  } else {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

type MessageDay = { day: number; messages: GmailMessageSummary[] };

function groupMessagesByDay(messages: GmailMessageSummary[]): MessageDay[] {
  const days = new Map<number, MessageDay>();
  for (const message of messages) {
    const day = new Date(message.date).setHours(0, 0, 0, 0);
    let group = days.get(day);
    if (!group) {
      group = { day, messages: [] };
      days.set(day, group);
    }
    group.messages.push(message);
  }
  return [...days.values()].sort((a, b) => b.day - a.day);
}

function MessageDayGroup({
  group,
  collapsed,
  onToggle,
  children,
}: {
  group: MessageDay;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const date = new Date(group.day);
  const label =
    group.day === today.getTime()
      ? "Today"
      : group.day === yesterday.getTime()
        ? "Yesterday"
        : date.toLocaleDateString([], {
            weekday: "short",
            month: "short",
            day: "numeric",
            ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
          });
  const unread = group.messages.filter((message) => message.threadUnread ?? message.unread).length;
  return (
    <section data-message-day={group.day}>
      <h3 className="sticky top-0 z-10 bg-canvas">
        <button
          type="button"
          data-message-day-header=""
          aria-label={`${label}, ${group.messages.length} conversation${group.messages.length === 1 ? "" : "s"}${unread > 0 ? `, ${unread} unread` : ""}`}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex h-8 w-full cursor-pointer items-center gap-1.5 border-y border-border/60 px-4 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", collapsed && "-rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{label}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {group.messages.length}
          </span>
          {unread > 0 ? <span className="shrink-0 text-primary">· {unread} unread</span> : null}
        </button>
      </h3>
      <div id={bodyId} hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}

type MessageRowProps = {
  message: GmailMessageSummary;
  selected: boolean;
  /** Part of the cmd/shift multi-selection. */
  checked: boolean;
  onRowClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Fallback owner id when a summary has no accountId (e.g. live search results). */
  accountId: string;
  resolveLabel: ResolveLabel;
  /** Mailbox + account line shown next to the date, only in Combined view. */
  combinedMeta: CombinedMeta | null;
  /** Mark rows still in the inbox (shown when browsing non-inbox views). */
  showInboxChip: boolean;
  /** Labels that define the current view; every row has them, so no chip. */
  viewLabelIds: ReadonlySet<string>;
  /** Opens the permanent-delete confirm (offered on trashed/junk rows only). */
  onDeleteForever: () => void;
  /** Opens this conversation in the in-app agent chat panel. */
  onChatAgent: () => void;
  /** Closes the reader — used after marking the open row unread, so the
      reader's auto mark-read doesn't immediately undo it (Gmail does this too). */
  onDeselect: () => void;
  /** Its conversation's messages are listed under it. */
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Starts dragging this row (or the whole multi-selection) onto a label. */
  onDragStart: (e: React.DragEvent<HTMLButtonElement>) => void;
};

function MessageRow({
  message,
  selected,
  checked,
  onRowClick,
  accountId,
  resolveLabel,
  combinedMeta,
  showInboxChip,
  viewLabelIds,
  onDeleteForever,
  onChatAgent,
  onDeselect,
  expanded,
  onToggleExpanded,
  onDragStart,
}: MessageRowProps) {
  const modifyMessage = useModifyMessage();
  const modifyThread = useModifyThread();
  const trashThread = useTrashThread();
  const untrashThread = useUntrashThread();

  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const ownerAccountId = message.accountId ?? accountId;
  const threadId = message.threadId || message.id;
  const threadCount = message.threadCount ?? 1;

  const labelIds = rowLabels(message);
  const messageLabels = labelIds
    .filter((id) => !viewLabelIds.has(id))
    .map((id) => resolveLabel(ownerAccountId, id))
    .filter((l): l is GmailLabel => l != null && l.type === "user");
  // At most two chips; the rest collapse into "+N".
  const MAX_CHIPS = 2;
  const shownLabels = messageLabels.slice(0, MAX_CHIPS);
  const hiddenLabelCount = messageLabels.length - shownLabels.length;

  // Labels apply to the whole conversation, like Gmail's list.
  const labelChoices = useLabelChoices({ accountId: ownerAccountId, threadId, labelIds });

  const handleToggleRead = () => {
    const isUnread = message.threadUnread ?? message.unread;
    console.log("[MessageList:toggleRead]", { threadId, isUnread });
    if (isUnread) {
      void modifyThread.mutateAsync({
        accountId: ownerAccountId,
        threadId,
        removeLabelIds: ["UNREAD"],
      });
    } else {
      void modifyMessage.mutateAsync({
        accountId: ownerAccountId,
        messageId: message.id,
        addLabelIds: ["UNREAD"],
      });
      if (selected) onDeselect();
    }
  };

  const junk = labelIds.includes("SPAM");

  const handleJunk = () => {
    console.log("[MessageList:junkToggle]", { threadId, junk });
    void modifyThread.mutateAsync({
      accountId: ownerAccountId,
      threadId,
      addLabelIds: junk ? ["INBOX"] : ["SPAM"],
      removeLabelIds: junk ? ["SPAM"] : ["INBOX"],
    });
  };

  const handleStarToggle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    console.log("[MessageList:starToggle]", {
      messageId: message.id,
      starred: message.starred,
    });
    if (message.starred) {
      void modifyMessage.mutateAsync({
        accountId: ownerAccountId,
        messageId: message.id,
        removeLabelIds: ["STARRED"],
      });
    } else {
      void modifyMessage.mutateAsync({
        accountId: ownerAccountId,
        messageId: message.id,
        addLabelIds: ["STARRED"],
      });
    }
  };

  const inInbox = labelIds.includes("INBOX");

  const handleArchive = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    console.log("[MessageList:archiveToggle]", { threadId, inInbox });
    void modifyThread.mutateAsync({
      accountId: ownerAccountId,
      threadId,
      addLabelIds: inInbox ? undefined : ["INBOX"],
      removeLabelIds: inInbox ? ["INBOX"] : undefined,
    });
  };

  const trashed = labelIds.includes("TRASH");

  const handleTrash = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    console.log("[MessageList:trashToggle]", { threadId, trashed });
    if (trashed) {
      void untrashThread.mutateAsync({ accountId: ownerAccountId, threadId });
      return;
    }
    void trashThread.mutateAsync({ accountId: ownerAccountId, threadId });
  };

  // Keyboard selection (j/k) can land on a row outside the viewport — keep the
  // selected row visible. "nearest" makes this a no-op for click selection;
  // "instant" keeps held-down j/k from queueing smooth-scroll animations that
  // continue after the key is released.
  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (selected && row && !row.closest("[inert]"))
      row.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selected]);

  const unread = message.threadUnread ?? message.unread;
  // The thread's latest message is an unsent draft: flag it like Gmail does,
  // and name who it's going to instead of yourself.
  const isDraft = message.labelIds.includes("DRAFT");
  const draftTo = isDraft
    ? splitAddressList(message.to)
        .map((entry) => {
          const { name, email } = parseAddressEntry(entry);
          return name || email.split("@")[0];
        })
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            ref={rowRef}
            type="button"
            data-message-row=""
            data-message-id={message.id}
            data-draft={isDraft || undefined}
            data-flagged={message.starred || undefined}
            data-unread={unread || undefined}
            data-read={(!unread && !isDraft) || undefined}
            data-selected={selected || undefined}
            data-checked={checked || undefined}
            onClick={onRowClick}
            draggable
            onDragStart={onDragStart}
            // shift-click must not start a text selection
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
            }}
            className={[
              "message-list-row group relative flex w-full cursor-pointer select-none items-start gap-2.5 overflow-hidden px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              selected
                ? "bg-sidebar-row-active"
                : checked
                  ? "bg-sidebar-row-hover"
                  : "hover:bg-sidebar-row-hover",
              // Every row in the multi-selection is outlined — the open one too.
              checked ? "ring-1 ring-inset ring-primary/70" : "",
            ].join(" ")}
          >
            <div className="message-list-row-content flex min-w-0 flex-1 flex-col">
              <div className="message-list-row-header flex items-center justify-between gap-2">
                <span className="message-list-sender flex min-w-0 flex-1 items-center gap-1.5">
                  {unread && !selected ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  ) : null}
                  {labelIds.includes("IMPORTANT") ? <ImportantMarker muted /> : null}
                  {isDraft ? (
                    <span className="shrink-0 text-sm font-medium leading-snug text-destructive-foreground">
                      Draft
                    </span>
                  ) : null}
                  <span
                    className={[
                      "message-list-sender-name min-w-0 truncate text-sm leading-snug",
                      isDraft
                        ? "text-muted-foreground"
                        : unread
                          ? "font-medium text-foreground"
                          : "font-normal text-foreground",
                    ].join(" ")}
                  >
                    {isDraft
                      ? draftTo
                        ? `to ${draftTo}`
                        : ""
                      : senderLabel(message.fromName, message.fromEmail, ownerAccountId)}
                  </span>
                </span>
                <div className="message-list-meta flex shrink-0 items-center gap-1.5">
                  {threadCount > 1 ? (
                    // Count + chevron: lists the conversation's messages
                    // under the row (Apple Mail). A span, since the row is
                    // already a button.
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={expanded ? "Hide messages" : `Show ${threadCount} messages`}
                      aria-expanded={expanded}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleExpanded();
                      }}
                      className="-my-0.5 flex items-center gap-0.5 rounded-sm px-0.5 text-xs tabular-nums text-muted-foreground hover:text-foreground"
                    >
                      {threadCount}
                      <CircleChevronDownIcon
                        className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
                      />
                    </span>
                  ) : null}
                  {combinedMeta ? (
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: combinedMeta.accountColor }}
                      title={
                        combinedMeta.mailbox
                          ? `${combinedMeta.accountName} · ${combinedMeta.mailbox}`
                          : combinedMeta.accountName
                      }
                      aria-label={combinedMeta.accountName}
                    />
                  ) : null}
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatRelativeDate(message.date)}
                  </span>
                </div>
              </div>
              <div className="message-list-preview flex min-w-0 flex-col gap-0.5">
                <span className="message-list-subject truncate text-[13px] leading-snug text-foreground/90">
                  {message.subject || "(no subject)"}
                </span>
                <span className="message-list-snippet truncate text-[13px] leading-snug text-muted-foreground/75">
                  {decodeEntities(message.snippet) || " "}
                </span>
              </div>
              {/* Chips only when they add something beyond the current view. */}
              {(showInboxChip && labelIds.includes("INBOX")) || shownLabels.length > 0 ? (
                <div className="message-list-labels mt-1 flex h-5 items-center gap-1 overflow-hidden">
                  {showInboxChip && labelIds.includes("INBOX") ? (
                    <InboxChip selected={selected} />
                  ) : null}
                  {shownLabels.map((label) => (
                    <LabelChip key={label.id} label={label} selected={selected} />
                  ))}
                  {hiddenLabelCount > 0 ? (
                    <span className="text-2xs tabular-nums text-muted-foreground">
                      +{hiddenLabelCount}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </button>
        </ContextMenuTrigger>
        {message.starred ? (
          <button
            type="button"
            onClick={handleStarToggle}
            className="message-list-flag"
            aria-label="Unflag"
          >
            <FlagIcon className="size-4 fill-current text-(--red)" />
          </button>
        ) : null}
        <ContextMenuContent>
          <ContextMenuItem
            icon={unread ? "envelope.open" : "envelope.badge"}
            onSelect={handleToggleRead}
          >
            {unread ? "Mark as read" : "Mark as unread"}
          </ContextMenuItem>
          <ContextMenuItem
            icon={message.starred ? "flag.slash" : "flag"}
            onSelect={() => handleStarToggle()}
          >
            {message.starred ? "Unflag" : "Flag"}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon="cursorarrow" onSelect={onChatAgent}>
            Open in agent chat
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              addEmailToTodoist({
                accountId: message.accountId ?? accountId,
                messageId: message.id,
                subject: message.subject,
              })
            }
          >
            Add to Todoist…
          </ContextMenuItem>
          <ContextMenuSub label="Add to project">
            <AddToProjectItems
              threads={[
                {
                  accountId: message.accountId ?? accountId,
                  threadId: message.threadId || message.id,
                },
              ]}
              suggestedName={message.subject}
              Item={ContextMenuItem}
              Separator={ContextMenuSeparator}
            />
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuSub label={labelChoices.folders ? "Move to folder" : "Label"}>
            {renderLabelChoices(labelChoices, {
              Item: ContextMenuItem,
              CheckboxItem: ContextMenuCheckboxItem,
              Sub: ContextMenuSub,
              Separator: ContextMenuSeparator,
            })}
          </ContextMenuSub>
          <ContextMenuSeparator />
          {trashed || junk ? null : (
            <ContextMenuItem
              icon={inInbox ? "archivebox" : "tray.and.arrow.down"}
              onSelect={() => handleArchive()}
            >
              {inInbox ? "Archive" : "Move to inbox"}
            </ContextMenuItem>
          )}
          {inInbox && !trashed && !junk && (
            <ContextMenuItem onSelect={() => setSnoozeOpen(true)}>Snooze…</ContextMenuItem>
          )}
          {trashed ? null : (
            <ContextMenuItem icon={junk ? "checkmark.shield" : "xmark.bin"} onSelect={handleJunk}>
              {junk ? "Not junk" : "Move to junk"}
            </ContextMenuItem>
          )}
          {trashed ? (
            <ContextMenuItem icon="trash.slash" onSelect={() => handleTrash()}>
              Restore from trash
            </ContextMenuItem>
          ) : (
            <ContextMenuItem icon="trash" color="red" onSelect={() => handleTrash()}>
              Move to trash
            </ContextMenuItem>
          )}
          {trashed || junk ? (
            <ContextMenuItem icon="trash.fill" color="red" onSelect={onDeleteForever}>
              Delete forever…
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {snoozeOpen && (
        <SnoozeDialog
          accountId={ownerAccountId}
          threadId={threadId}
          onClose={() => setSnoozeOpen(false)}
          onDone={selected ? onDeselect : undefined}
        />
      )}
    </div>
  );
}

/** One message of an expanded conversation, listed under its row (newest
    first, like the list): sender, date, and a line of its text. Opening it
    shows just this message. */
function ThreadMessageRow({
  message,
  selected,
  onClick,
}: {
  message: GmailMessageSummary;
  selected: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const row = ref.current;
    if (selected && row && !row.closest("[inert]"))
      row.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [selected]);
  const isDraft = message.labelIds.includes("DRAFT");
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      data-read={(!message.unread && !isDraft) || undefined}
      data-selected={selected || undefined}
      className={cn(
        "message-list-thread-row group flex w-full cursor-pointer select-none flex-col gap-0.5 rounded-lg py-2 pr-3 pl-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        selected ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {message.unread && !selected ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
          ) : null}
          {isDraft ? (
            <span className="shrink-0 text-[13px] font-medium text-destructive-foreground">
              Draft
            </span>
          ) : null}
          <span
            className={cn(
              "message-list-sender-name min-w-0 truncate text-[13px] text-foreground",
              message.unread && "font-medium",
            )}
          >
            {senderLabel(message.fromName, message.fromEmail, message.accountId)}
          </span>
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatRelativeDate(message.date)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="message-list-snippet min-w-0 flex-1 truncate text-[13px] text-muted-foreground/75">
          {decodeEntities(message.snippet) || " "}
        </span>
        {message.hasAttachments ? (
          <PaperclipIcon className="size-3 shrink-0 text-muted-foreground/55" aria-hidden />
        ) : null}
      </span>
    </button>
  );
}

/**
 * The unread filter's icon (Apple Mail's): a ring round three narrowing
 * lines, filled with the lines cut out while showing unread only.
 */
function UnreadFilterIcon({ on, className }: { on: boolean; className?: string }) {
  return on ? (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path
        fillRule="evenodd"
        d="M12 1a11 11 0 1 1 0 22 11 11 0 0 1 0-22ZM7.5 8a1 1 0 0 0 0 2h9a1 1 0 0 0 0-2h-9Zm2 3.5a1 1 0 0 0 0 2h5a1 1 0 0 0 0-2h-5ZM11 15a1 1 0 0 0 0 2h2a1 1 0 0 0 0-2h-2Z"
      />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M7.5 9h9M9.5 12.5h5M11 16h2" />
    </svg>
  );
}

function formatConversationSummary(total: number, unread: number): string {
  const conversations = `${total.toLocaleString()} conversation${total === 1 ? "" : "s"}`;
  return unread > 0 ? `${conversations} · ${unread.toLocaleString()} unread` : conversations;
}

/** "260 messages, 7 unread" — omits the unread clause when nothing is unread. */
function formatMailboxSummary(total: number, unread: number): string {
  const messages = `${total.toLocaleString()} message${total === 1 ? "" : "s"}`;
  return unread > 0 ? `${messages} · ${unread.toLocaleString()} unread` : messages;
}

export function MessageList({
  headerLeading,
  headerTrailing,
  roundedLeft,
  roundedRight,
  renderFloatingReader,
  space,
  accountId,
  labelId,
  combined,
  accountIds,
  accounts,
  selectedMessageId: openMessageId,
  focusedMessageId: openFocusedMessageId,
  onSelectMessage,
  onDeselect,
  advanceRef,
  onSelectionChange,
  onOpenChat,
  onSearchView,
  viewQueryRef,
  search,
  project,
}: MessageListProps) {
  const messageListStyle = useMessageListStyle();
  const groupByDay = useInterfaceToggle(GROUP_MESSAGES_BY_DAY);
  const dimReadMessages = useInterfaceToggle(DIM_READ_MESSAGES);
  const openMessagesWithArrows = useInterfaceToggle(OPEN_MESSAGES_WITH_ARROWS);
  const [cursor, setCursor] = useState<{ messageId: string; focusId?: string } | null>(null);
  const selectedMessageId = openMessageId ?? cursor?.messageId ?? null;
  const focusedMessageId = openMessageId ? openFocusedMessageId : (cursor?.focusId ?? null);
  const [collapsedDays, setCollapsedDays] = useState<ReadonlySet<number>>(new Set());
  const isCombined = combined != null;
  // This device isn't signed in to the mailbox (e.g. it was added on another device).
  const signedOutAccount = useAccounts().data?.find(
    (account) => account.id === accountId && account.signedOut,
  );
  // "All / Unread" mode switcher — a segmented control in the header, not a
  // buried icon toggle, so the current display mode is always visible.
  const [mailboxMode, setMailboxMode] = useState<"all" | "unread">("all");
  const unreadOnly = mailboxMode === "unread" && !search;

  // The Search mailbox runs Gmail's own search (the truth, every operator);
  // the header's search icon opens it scoped to this mailbox, where its
  // chips (starred, attachments, dates…) narrow it.
  const globalSearching = search !== undefined;

  const searching = globalSearching;
  const searchQuery = search?.query ?? "";

  // All hooks are always called (rules of hooks); the inactive ones are disabled.
  const accountMessages = useMessages(isCombined || searching ? null : accountId, labelId);
  const combinedMessages = useCombinedMessages(
    combined?.rules ?? [],
    combined?.viewId ?? "",
    isCombined && !searching,
  );
  const gmailSearch = useGmailSearch(searchQuery, search?.accountIds ?? [], globalSearching);
  const projectThreads = useProjectThreads(project && !searching ? project.id : null);
  const messagesQuery = globalSearching
    ? gmailSearch
    : project
      ? projectThreads
      : isCombined
        ? combinedMessages
        : accountMessages;

  const resolveLabel = useLabelResolver(isCombined ? accountIds : [accountId]);
  // Combined mode has no single "active account" to drive per-account label
  // sync (see useAccountSync), so the header's counts need their own refresh loop.
  useSyncAccountLabels(accountIds, isCombined);

  // Header title + "N messages, M unread". Combined counts come from the local
  // store (rules can't be summed from Gmail's per-label counters); account mode
  // still uses Gmail's own label counters.
  // All Mail has no Gmail label (so no counters): count it from the store too.
  const allMailRules =
    !isCombined && labelId === ALL_MAIL_LABEL_ID ? [{ accountId, allOf: [], noneOf: [] }] : [];
  const combinedCounts = useCombinedCounts(
    isCombined ? (combined?.rules ?? []) : allMailRules,
    isCombined ? (combined?.viewId ?? "") : `${accountId}:${ALL_MAIL_LABEL_ID}`,
    isCombined || allMailRules.length > 0,
  );
  const activeLabel = resolveLabel(accountId, labelId);
  if (viewQueryRef && !search) {
    const nameOf = (owner: string, id: string) => resolveLabel(owner, id)?.name ?? null;
    viewQueryRef.current = isCombined
      ? viewSearchQuery(combined.rules, nameOf)
      : (labelSearchToken(labelId, nameOf(accountId, labelId)) ?? "");
  }
  const projectRows = projectThreads.data?.pages[0]?.messages;
  const { mailboxTotal, mailboxUnread } = project
    ? {
        mailboxTotal: projectRows?.length ?? 0,
        mailboxUnread: projectRows?.filter((m) => m.threadUnread ?? m.unread).length ?? 0,
      }
    : isCombined || allMailRules.length > 0
      ? {
          mailboxTotal: combinedCounts.data?.total ?? 0,
          mailboxUnread: combinedCounts.data?.unread ?? 0,
        }
      : { mailboxTotal: activeLabel?.total ?? 0, mailboxUnread: activeLabel?.unread ?? 0 };

  // Search pages are merged per account; a conversation seen on an earlier
  // page isn't repeated.
  const allMessages: GmailMessageSummary[] = useMemo(() => {
    const pages: { messages: GmailMessageSummary[] }[] = messagesQuery.data?.pages ?? [];
    const rows = pages.flatMap((p) => p.messages);
    if (!globalSearching) return rows;
    const seen = new Set<string>();
    return rows.filter((m) => {
      const key = `${m.accountId ?? ""}:${m.threadId || m.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [messagesQuery.data, globalSearching]);
  // In Unread mode, clicking a message marks it read (optimistically), which
  // would normally drop it from this filter instantly. Keep the currently
  // selected row pinned in place — Gmail-style — so it only disappears once the
  // selection moves to another message.
  const filteredMessages = unreadOnly
    ? allMessages.filter((m) => (m.threadUnread ?? m.unread) || m.id === openMessageId)
    : allMessages;
  const dayGroups = groupByDay ? groupMessagesByDay(filteredMessages) : [];
  const visibleMessages = groupByDay
    ? dayGroups.flatMap((group) => (collapsedDays.has(group.day) ? [] : group.messages))
    : filteredMessages;
  const hasNextPage = messagesQuery.hasNextPage;
  const isFetchingNextPage = messagesQuery.isFetchingNextPage;

  // Gmail-style list shortcuts: j/k and the arrow keys move the selection
  // (Apple Mail-style — arrows never scroll the list), e/#/! archive/trash/
  // junk the selected thread (advancing to the next row), s toggles the flag,
  // Shift+U/Shift+I set unread/read. Latest state is read through a ref so the
  // window listener mounts once.
  const listModifyMessage = useModifyMessage();
  const listModifyThread = useModifyThread();
  const listTrashThread = useTrashThread();
  const listUntrashThread = useUntrashThread();
  const listTrashMessage = useTrashMessage();
  const listUntrashMessage = useUntrashMessage();

  const selectForNavigation = (row: GmailMessageSummary, focusId?: string) => {
    setCursor({ messageId: row.id, focusId });
    if (openMessageId || openMessagesWithArrows) {
      onSelectMessage(row.id, row.accountId ?? accountId, focusId, { autoFocusDraft: false });
    }
  };

  const selectedRow = filteredMessages.find((m) => m.id === selectedMessageId) ?? null;
  const selectedOwner = selectedRow ? (selectedRow.accountId ?? accountId) : null;
  const selectedCapabilities = useCapabilities(selectedOwner);
  const { multipleLabels } = useCapabilities(accountId);

  // Conversations opened up in place (Apple Mail), keyed `${owner}:${threadId}`;
  // cleared with the multi-selection when the view changes.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const threadKey = (m: GmailMessageSummary) => `${m.accountId ?? accountId}:${m.threadId || m.id}`;
  const expandedRows = visibleMessages.filter(
    (m) => (m.threadCount ?? 1) > 1 && expanded.has(threadKey(m)),
  );
  const threadsByKey = useThreads(
    expandedRows.map((m) => ({
      accountId: m.accountId ?? accountId,
      threadId: m.threadId || m.id,
    })),
  );
  /** An expanded row's messages, newest first (like the list); [] when collapsed. */
  const threadMessagesOf = (m: GmailMessageSummary): GmailMessageSummary[] =>
    expanded.has(threadKey(m)) ? [...(threadsByKey.get(threadKey(m)) ?? [])].reverse() : [];
  // What ↑/↓ walk through: every row, and the messages of expanded ones.
  type NavItem = { row: GmailMessageSummary; focus: GmailMessageSummary | null };
  const navItems: NavItem[] = visibleMessages.flatMap((row) => [
    { row, focus: null },
    ...threadMessagesOf(row).map((m) => ({ row, focus: m })),
  ]);
  const focusedMessage =
    (selectedRow && threadMessagesOf(selectedRow).find((m) => m.id === focusedMessageId)) ?? null;

  /** After the message open from `row`'s conversation leaves it: open its
      neighbor there, or the whole conversation when none is left. */
  const advanceFocusIn = (row: GmailMessageSummary, focus: GmailMessageSummary) => {
    const siblings = threadMessagesOf(row);
    const next = pickAdvanceTarget(
      siblings,
      siblings.findIndex((m) => m.id === focus.id),
    );
    selectForNavigation(row, next?.id);
  };

  const setThreadExpanded = (row: GmailMessageSummary, open: boolean) => {
    const key = threadKey(row);
    console.log("[MessageList:expandThread]", { key, open });
    setExpanded((prev) => {
      if (prev.has(key) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
    // Collapsing the conversation a message is open from falls back to the
    // whole conversation.
    if (!open && row.id === selectedMessageId && focusedMessageId) {
      setCursor({ messageId: row.id });
      if (openMessageId)
        onSelectMessage(row.id, row.accountId ?? accountId, undefined, { autoFocusDraft: false });
    }
  };

  // The single label the current view IS (Gmail's v "move" needs a label to
  // leave). Built-in combined views map to their system label; rule-based
  // custom views and search results have no single label, so v is unavailable.
  const COMBINED_VIEW_LABELS: Record<string, string> = {
    [INBOX_VIEW_ID]: "INBOX",
    [STARRED_VIEW_ID]: "STARRED",
    [SENT_VIEW_ID]: "SENT",
    [DRAFTS_VIEW_ID]: "DRAFT",
  };
  const moveContextLabelId = searching
    ? null
    : isCombined
      ? (COMBINED_VIEW_LABELS[combined.viewId] ?? null)
      : labelId;

  const [labelOverlay, setLabelOverlay] = useState<LabelOverlayMode | null>(null);

  // Cmd/shift multi-selection (bulk action bar). Anchor = last plain/cmd click,
  // falling back to the open message, so shift-click ranges feel native.
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  /** The selection's other end, where Shift+↑/↓ go on from. */
  const extentRef = useRef<string | null>(null);
  const clearChecked = () => {
    setChecked(new Set());
    anchorRef.current = null;
    extentRef.current = null;
  };
  const toggleDay = (group: MessageDay) => {
    const collapsing = !collapsedDays.has(group.day);
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (collapsing) next.add(group.day);
      else next.delete(group.day);
      return next;
    });
    if (collapsing) {
      const hiddenIds = new Set(group.messages.map((message) => message.id));
      setChecked((prev) => new Set([...prev].filter((id) => !hiddenIds.has(id))));
      if (cursor && hiddenIds.has(cursor.messageId)) setCursor(null);
      if (anchorRef.current && hiddenIds.has(anchorRef.current)) anchorRef.current = null;
    }
  };
  useEffect(() => {
    clearChecked();
    setExpanded(new Set());
    setCollapsedDays(new Set());
    setCursor(null);
  }, [accountId, labelId, combined?.viewId, searching, search?.id, searchQuery, unreadOnly]);

  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  // Capture phase: Escape clears the multi-selection before home-view's
  // Escape closes the reader.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || checkedRef.current.size === 0 || isTypingTarget(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setChecked(new Set());
      anchorRef.current = null;
      extentRef.current = null;
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, []);

  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchorRef.current = id;
    extentRef.current = null;
  };

  const rangeSelect = (id: string) => {
    const ids = visibleMessages.map((m) => m.id);
    const from = anchorRef.current ?? selectedMessageId ?? id;
    const a = ids.indexOf(from);
    const b = ids.indexOf(id);
    if (a === -1 || b === -1) {
      toggleChecked(id);
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setChecked((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) next.add(ids[i]);
      return next;
    });
    extentRef.current = id;
  };

  const openMessage = (row: GmailMessageSummary, focus?: GmailMessageSummary) => {
    const owner = row.accountId ?? accountId;
    // Clicks read the conversation immediately; keyboard browsing stays debounced in the reader.
    if (focus ? focus.unread : (row.threadUnread ?? row.unread)) {
      if (focus) {
        listModifyMessage.mutate({
          accountId: owner,
          messageId: focus.id,
          removeLabelIds: ["UNREAD"],
        });
      } else {
        listModifyThread.mutate({
          accountId: owner,
          threadId: row.threadId || row.id,
          removeLabelIds: ["UNREAD"],
        });
      }
    }
    setCursor({ messageId: row.id, focusId: focus?.id });
    onSelectMessage(row.id, owner, focus?.id);
  };

  const handleRowClick = (e: React.MouseEvent, message: GmailMessageSummary) => {
    // Cmd+click (or Option+click) adds/removes one row, Finder-style. The
    // open message counts as already selected, so the first Cmd+click keeps
    // it instead of starting over.
    if ((e.metaKey || e.altKey) && !e.shiftKey) {
      if (
        checkedRef.current.size === 0 &&
        selectedMessageId &&
        selectedMessageId !== message.id &&
        visibleMessages.some((m) => m.id === selectedMessageId)
      ) {
        setChecked(new Set([selectedMessageId]));
      }
      toggleChecked(message.id);
      return;
    }
    if (e.shiftKey) {
      rangeSelect(message.id);
      return;
    }
    clearChecked();
    anchorRef.current = message.id;
    console.log("[MessageList:selectMessage]", { messageId: message.id });
    openMessage(message);
  };

  const checkedRows = visibleMessages.filter((m) => checked.has(m.id));

  // Surface the multi-selection to the chat panel. Keyed on the id signature
  // so it only fires when the set actually changes (checkedRows is a fresh
  // array every render).
  const selectionSig = checkedRows.map((m) => `${m.accountId ?? accountId}:${m.id}`).join(",");
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;
  const checkedRowsRef = useRef(checkedRows);
  checkedRowsRef.current = checkedRows;
  useEffect(() => {
    selectionRef.current?.(checkedRowsRef.current);
  }, [selectionSig]);
  /** Runs an action on every checked row. `undoable` actions register one
      undo per row; grouped, a single z restores the whole selection. */
  const bulk = (
    label: string,
    run: (m: GmailMessageSummary) => void,
    { undoable = true }: { undoable?: boolean } = {},
  ) => {
    console.log("[MessageList:bulk]", { action: label, count: checkedRows.length });
    if (undoable) beginUndoGroup(checkedRows.length);
    for (const m of checkedRows) run(m);
    clearChecked();
  };
  const bulkArchive = () =>
    bulk(
      "archive",
      (m) =>
        void listModifyThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
          removeLabelIds: ["INBOX"],
        }),
    );
  const bulkTrash = () =>
    bulk(
      "trash",
      (m) =>
        void listTrashThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
        }),
    );
  const bulkJunk = () =>
    bulk(
      "junk",
      (m) =>
        void listModifyThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
          addLabelIds: ["SPAM"],
          removeLabelIds: ["INBOX"],
        }),
    );
  const bulkMarkRead = () =>
    bulk(
      "read",
      (m) =>
        void listModifyThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
          removeLabelIds: ["UNREAD"],
        }),
      { undoable: false }, // mark-read never registers an undo
    );
  const bulkUntrash = () =>
    bulk(
      "untrash",
      (m) =>
        void listUntrashThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
        }),
      { undoable: false },
    );
  const listDeleteForever = useDeleteThreadsForever();
  const [confirmDeleteRows, setConfirmDeleteRows] = useState<GmailMessageSummary[] | null>(null);
  const handleDeleteForeverConfirm = () => {
    const rows = confirmDeleteRows ?? [];
    setConfirmDeleteRows(null);
    console.log("[MessageList:deleteForever]", { count: rows.length });
    const byAccount = new Map<string, string[]>();
    for (const m of rows) {
      const owner = m.accountId ?? accountId;
      const threadIds = byAccount.get(owner) ?? [];
      threadIds.push(m.threadId || m.id);
      byAccount.set(owner, threadIds);
    }
    for (const [owner, threadIds] of byAccount) {
      void listDeleteForever.mutateAsync({ accountId: owner, threadIds });
    }
    // Nothing to undo into: an older undo would now target deleted mail.
    clearUndo();
    clearChecked();
  };
  const bulkNotJunk = () =>
    bulk(
      "notJunk",
      (m) =>
        void listModifyThread.mutateAsync({
          accountId: m.accountId ?? accountId,
          threadId: m.threadId || m.id,
          addLabelIds: ["INBOX"],
          removeLabelIds: ["SPAM"],
        }),
    );
  // Trash/spam rows only surface in their own views, so a uniform selection
  // decides the bar's vocabulary; mixed selections fall back to the default.
  const allTrashed =
    checkedRows.length > 0 && checkedRows.every((m) => rowLabels(m).includes("TRASH"));
  const allJunk =
    !allTrashed &&
    checkedRows.length > 0 &&
    checkedRows.every((m) => rowLabels(m).includes("SPAM"));

  // Delete acts on the multi-selection when there is one; read through a ref so
  // the window listener (mounted once) sees the current rows.
  const trashCheckedRef = useRef(bulkTrash);
  trashCheckedRef.current = allTrashed ? bulkUntrash : bulkTrash;

  const bulkMarkUnread = () => {
    // Gmail-style: marking the open conversation unread returns to the list
    // (and keeps the reader from instantly re-marking it read).
    if (selectedMessageId && checked.has(selectedMessageId)) onDeselect();
    bulk(
      "unread",
      (m) =>
        void listModifyMessage.mutateAsync({
          accountId: m.accountId ?? accountId,
          messageId: m.id,
          addLabelIds: ["UNREAD"],
        }),
    );
  };

  const advanceFrom = (rowId: string) => {
    const idx = visibleMessages.findIndex((m) => m.id === rowId);
    const next = pickAdvanceTarget(visibleMessages, idx);
    if (next) selectForNavigation(next);
    else onDeselect();
  };
  advanceRef.current = (fromMessageId: string) => {
    // A single message open from an expanded conversation moves on within it.
    if (focusedMessage && selectedRow && fromMessageId === selectedRow.id) {
      advanceFocusIn(selectedRow, focusedMessage);
      return true;
    }
    const idx = visibleMessages.findIndex((m) => m.id === fromMessageId);
    if (idx === -1) return false;
    const next = pickAdvanceTarget(visibleMessages, idx);
    if (!next) return false;
    selectForNavigation(next);
    return true;
  };

  const handleOverlayPick = (pickedId: string, wasApplied: boolean) => {
    const row = selectedRow;
    if (!row || !labelOverlay) return;
    const owner = row.accountId ?? accountId;
    const rowThreadId = row.threadId || row.id;
    if (labelOverlay === "label" && !selectedCapabilities.multipleLabels) {
      // One folder per message: "Label as" moves the conversation there.
      if (wasApplied) return;
      const labels = allLabels.find((l) => l.accountId === owner)?.labels ?? [];
      const move = moveToFolder(rowLabels(row), pickedId, labels);
      console.log("[MessageList:moveToFolder]", { rowThreadId, pickedId });
      if (moveContextLabelId && move.removeLabelIds.includes(moveContextLabelId)) {
        advanceFrom(row.id);
      }
      void listModifyThread.mutateAsync({ accountId: owner, threadId: rowThreadId, ...move });
      return;
    }
    if (labelOverlay === "label") {
      console.log("[MessageList:labelAs]", { rowThreadId, pickedId, wasApplied });
      void listModifyThread.mutateAsync({
        accountId: owner,
        threadId: rowThreadId,
        addLabelIds: wasApplied ? undefined : [pickedId],
        removeLabelIds: wasApplied ? [pickedId] : undefined,
      });
      return;
    }
    // Move: apply the picked label and leave the current one.
    const removable = moveContextLabelId && isMoveSourceLabel(moveContextLabelId, pickedId);
    console.log("[MessageList:moveTo]", { rowThreadId, pickedId, from: moveContextLabelId });
    if (removable) advanceFrom(row.id);
    void listModifyThread.mutateAsync({
      accountId: owner,
      threadId: rowThreadId,
      addLabelIds: pickedId === moveContextLabelId ? undefined : [pickedId],
      removeLabelIds: removable ? [moveContextLabelId] : undefined,
    });
  };

  const allLabels = useAllAccountLabels(accountIds);

  const shortcutState = useRef({
    visibleMessages,
    selectedRow,
    selectedMessageId,
    accountId,
    moveContextLabelId,
    navItems,
    focusedMessage,
    allLabels,
  });
  shortcutState.current = {
    visibleMessages,
    selectedRow,
    selectedMessageId,
    accountId,
    moveContextLabelId,
    navItems,
    focusedMessage,
    allLabels,
  };
  // Keyboard commands on the open/selected row (Settings › Keybindings).
  // Each handler returns false when it doesn't apply, so the key passes on.
  const rowCommand =
    (
      fn: (ctx: {
        rows: GmailMessageSummary[];
        idx: number;
        row: GmailMessageSummary | undefined;
        owner: string;
        threadId: string;
        select: (m: GmailMessageSummary) => void;
        advance: () => void;
        /** The single message open from an expanded conversation, if any. */
        focus: GmailMessageSummary | null;
        /** After `focus` is archived/trashed: open its neighbor in the
            conversation, or the whole conversation when it was the only one. */
        advanceFocus: () => void;
      }) => boolean | void,
    ) =>
    (e: KeyboardEvent) => {
      // Held-down key repeats can outpace rendering and pile up in the event
      // queue, replaying moves long after the key is released — drop repeats
      // that have been waiting more than a beat.
      if (e.repeat && performance.now() - e.timeStamp > 80) return;
      const {
        visibleMessages: rows,
        selectedRow: openRow,
        selectedMessageId: selId,
        accountId: fallbackAccount,
        focusedMessage: focus,
      } = shortcutState.current;
      if (rows.length === 0 && !openRow) return false;
      const idx = rows.findIndex((m) => m.id === selId);
      const row = idx >= 0 ? rows[idx] : (openRow ?? undefined);
      const select = (m: GmailMessageSummary) => selectForNavigation(m);
      return fn({
        rows,
        idx,
        row,
        owner: row ? (row.accountId ?? fallbackAccount) : "",
        threadId: row ? row.threadId || row.id : "",
        select,
        advance: () => {
          const next = pickAdvanceTarget(rows, idx);
          if (next) select(next);
          else onDeselect();
        },
        focus,
        advanceFocus: () => {
          if (row && focus) advanceFocusIn(row, focus);
        },
      });
    };
  /** ↑/↓ over rows and the messages of expanded conversations. */
  const navCommand = (step: 1 | -1) => (e: KeyboardEvent) => {
    if (e.repeat && performance.now() - e.timeStamp > 80) return;
    const {
      navItems: nav,
      selectedMessageId: selId,
      focusedMessage: focus,
    } = shortcutState.current;
    if (nav.length === 0) return false;
    // A plain move drops a multi-selection and goes on from where Shift+↑/↓ left it.
    const extent = extentRef.current;
    let idx = extent ? nav.findIndex((n) => n.row.id === extent && !n.focus) : -1;
    if (idx === -1)
      idx = nav.findIndex(
        (n) => n.row.id === selId && (n.focus?.id ?? null) === (focus?.id ?? null),
      );
    if (checkedRef.current.size > 0) clearChecked();
    // Handled even at the ends of the list — arrows must never scroll it.
    const target = idx === -1 ? nav[0] : nav[idx + step];
    if (!target) return;
    selectForNavigation(target.row, target.focus?.id);
  };
  /** Shift+↑/↓: selects from the anchor to a row past the extent, so heading
      back toward the anchor shrinks the selection (Finder-style). */
  const extendCommand = (step: 1 | -1) => (e: KeyboardEvent) => {
    if (e.repeat && performance.now() - e.timeStamp > 80) return;
    // Nothing to select in a list the reader covers (Full inbox).
    if (scrollRef.current?.closest("[inert]")) return false;
    const { visibleMessages: rows, selectedMessageId: selId } = shortcutState.current;
    const ids = rows.map((m) => m.id);
    // With nothing selected yet, the selection starts at the current row.
    const anchor = ids.indexOf(
      (checkedRef.current.size > 0 ? anchorRef.current : null) ?? selId ?? "",
    );
    // No current row: move onto the first, like ↓.
    if (anchor === -1) return navCommand(step)(e);
    const extent = extentRef.current ? ids.indexOf(extentRef.current) : -1;
    const to = (extent === -1 ? anchor : extent) + step;
    if (to < 0 || to >= ids.length) return;
    anchorRef.current = ids[anchor];
    extentRef.current = ids[to];
    setChecked(new Set(ids.slice(Math.min(anchor, to), Math.max(anchor, to) + 1)));
    scrollRef.current
      ?.querySelector(`[data-message-id="${CSS.escape(ids[to])}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "instant" });
  };
  useCommandHandlers({
    "list.next": navCommand(1),
    "list.previous": navCommand(-1),
    "list.extendSelectionDown": extendCommand(1),
    "list.extendSelectionUp": extendCommand(-1),
    "list.open": rowCommand(({ row, focus }) => {
      if (!row) return false;
      openMessage(row, focus ?? undefined);
    }),
    "list.expandThread": rowCommand(({ row }) => {
      if (!row || (row.threadCount ?? 1) <= 1) return false;
      setThreadExpanded(row, true);
    }),
    "list.collapseThread": rowCommand(({ row }) => {
      if (!row || !expanded.has(threadKey(row))) return false;
      setThreadExpanded(row, false);
    }),
    // With rows multi-selected, triage keys act on the whole selection; with
    // one message of a conversation open, on that message alone.
    "message.archive": rowCommand(({ row, owner, threadId, advance, focus, advanceFocus }) => {
      if (checkedRef.current.size > 0) return bulkArchive();
      if (!row) return false;
      if (focus) {
        const focusInInbox = focus.labelIds.includes("INBOX");
        if (focusInInbox) advanceFocus();
        void listModifyMessage.mutateAsync({
          accountId: owner,
          messageId: focus.id,
          addLabelIds: focusInInbox ? undefined : ["INBOX"],
          removeLabelIds: focusInInbox ? ["INBOX"] : undefined,
        });
        return;
      }
      // Archived rows un-archive; rows still in the inbox archive (and
      // advance, since they leave the current view).
      const rowInInbox = rowLabels(row).includes("INBOX");
      if (rowInInbox) advance();
      void listModifyThread.mutateAsync({
        accountId: owner,
        threadId,
        addLabelIds: rowInInbox ? undefined : ["INBOX"],
        removeLabelIds: rowInInbox ? ["INBOX"] : undefined,
      });
    }),
    "message.trash": rowCommand(({ row, owner, threadId, advance, focus, advanceFocus }) => {
      if (checkedRef.current.size > 0) {
        trashCheckedRef.current();
        return;
      }
      if (!row) return false;
      if (focus) {
        if (focus.labelIds.includes("TRASH")) {
          void listUntrashMessage.mutateAsync({ accountId: owner, messageId: focus.id });
        } else {
          advanceFocus();
          void listTrashMessage.mutateAsync({ accountId: owner, messageId: focus.id });
        }
        return;
      }
      // Trashed rows restore in place; live rows trash and advance.
      if (rowLabels(row).includes("TRASH")) {
        void listUntrashThread.mutateAsync({ accountId: owner, threadId });
      } else {
        advance();
        void listTrashThread.mutateAsync({ accountId: owner, threadId });
      }
    }),
    "message.junk": rowCommand(({ row, owner, threadId, advance, focus, advanceFocus }) => {
      if (checkedRef.current.size > 0) return allJunk ? bulkNotJunk() : bulkJunk();
      if (!row) return false;
      if (focus) {
        const focusJunk = focus.labelIds.includes("SPAM");
        advanceFocus();
        void listModifyMessage.mutateAsync({
          accountId: owner,
          messageId: focus.id,
          addLabelIds: focusJunk ? ["INBOX"] : ["SPAM"],
          removeLabelIds: focusJunk ? ["SPAM"] : ["INBOX"],
        });
        return;
      }
      // Junk rows come back to the inbox; either way the row leaves the view.
      const rowJunk = rowLabels(row).includes("SPAM");
      advance();
      void listModifyThread.mutateAsync({
        accountId: owner,
        threadId,
        addLabelIds: rowJunk ? ["INBOX"] : ["SPAM"],
        removeLabelIds: rowJunk ? ["SPAM"] : ["INBOX"],
      });
    }),
    "message.star": rowCommand(({ row, owner, focus }) => {
      if (!row) return false;
      const target = focus ?? row;
      void listModifyMessage.mutateAsync({
        accountId: owner,
        messageId: target.id,
        addLabelIds: target.starred ? undefined : ["STARRED"],
        removeLabelIds: target.starred ? ["STARRED"] : undefined,
      });
    }),
    "message.markUnread": rowCommand(({ row, owner, focus }) => {
      if (checkedRef.current.size > 0) return bulkMarkUnread();
      if (!row) return false;
      void listModifyMessage.mutateAsync({
        accountId: owner,
        messageId: (focus ?? row).id,
        addLabelIds: ["UNREAD"],
      });
      // Gmail returns to the list on mark-unread; also keeps the open
      // reader from immediately re-marking it read.
      onDeselect();
    }),
    "message.markRead": rowCommand(({ row, owner, threadId, focus }) => {
      if (checkedRef.current.size > 0) return bulkMarkRead();
      if (!row) return false;
      if (focus) {
        void listModifyMessage.mutateAsync({
          accountId: owner,
          messageId: focus.id,
          removeLabelIds: ["UNREAD"],
        });
        return;
      }
      void listModifyThread.mutateAsync({ accountId: owner, threadId, removeLabelIds: ["UNREAD"] });
    }),
    "message.label": rowCommand(({ row }) => {
      if (!row) return false;
      setLabelOverlay("label");
    }),
    "message.move": rowCommand(({ row }) => {
      if (!row || !shortcutState.current.moveContextLabelId) return false;
      setLabelOverlay("move");
    }),
    // A label's own shortcut (label.move:<name>): moves the selection there,
    // folder-style: the label is added, and the mailbox's label plus every
    // other label on the conversation come off. Resolved by name so one
    // binding works in every account.
    "label.move": (_e, labelName) => {
      const {
        visibleMessages: rows,
        selectedMessageId: selId,
        accountId: fallbackAccount,
        moveContextLabelId: viewLabelId,
        allLabels: labelsByAccount,
      } = shortcutState.current;
      if (!labelName) return false;
      const multi = checkedRef.current.size > 0;
      const targets = multi
        ? rows.filter((m) => checkedRef.current.has(m.id))
        : rows.filter((m) => m.id === selId);
      if (targets.length === 0) return false;
      const moves = targets.flatMap((m) => {
        const owner = m.accountId ?? fallbackAccount;
        const userLabels = labelsByAccount
          .find((a) => a.accountId === owner)
          ?.labels.filter((l) => l.type === "user");
        const target = userLabels?.find((l) => l.name === labelName);
        if (!userLabels || !target) return [];
        const userIds = new Set(userLabels.map((l) => l.id));
        const remove = rowLabels(m).filter((id) => userIds.has(id) && id !== target.id);
        const leavesView = viewLabelId != null && isMoveSourceLabel(viewLabelId, target.id);
        if (leavesView && !remove.includes(viewLabelId)) remove.push(viewLabelId);
        return [{ m, owner, targetId: target.id, remove, leavesView }];
      });
      if (moves.length === 0) {
        toast.error(`No label named “${labelName}” in this account`);
        return;
      }
      console.log("[MessageList:labelShortcut]", { labelName, count: moves.length });
      // The open conversation leaves the mailbox: move on, like archive does.
      if (!multi && moves[0].leavesView) {
        const idx = rows.findIndex((m) => m.id === moves[0].m.id);
        const next = pickAdvanceTarget(rows, idx);
        if (next) selectForNavigation(next);
        else onDeselect();
      }
      if (multi) beginUndoGroup(moves.length);
      for (const { m, owner, targetId, remove } of moves) {
        void listModifyThread.mutateAsync({
          accountId: owner,
          threadId: m.threadId || m.id,
          addLabelIds: [targetId],
          removeLabelIds: remove.length > 0 ? remove : undefined,
        });
      }
      // The action toast ("Moved to “X”", with Undo) comes from the undo registry.
      if (multi) clearChecked();
    },
  });

  // Infinite scroll: pull the next page whenever the bottom comes within
  // reach — on scroll, and after each render so short pages keep filling
  // until the viewport has headroom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const maybeLoadMore = () => {
    const el = scrollRef.current;
    if (!el || el.closest("[inert]") || el.clientHeight === 0 || !hasNextPage || isFetchingNextPage)
      return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
      console.log("[MessageList:autoLoadMore]");
      // The scroll handler and the effect can both fire before a re-render:
      // never cancel an in-flight page to start the same one again.
      void messagesQuery.fetchNextPage({ cancelRefetch: false });
    }
  };
  useEffect(maybeLoadMore);

  const isLoading = messagesQuery.isLoading;

  // Outside the Inbox (labels, views, global search), rows still in the inbox
  // say so. The view filter stays inside the current view, so its rows carry
  // the view's labels by construction — no chip needed there.
  const inInboxContext =
    !globalSearching && (isCombined ? combined.viewId === INBOX_VIEW_ID : labelId === "INBOX");

  // Labels that define what's on screen (the browsed label, or a view's
  // required labels for that account) are on every row — no chip for them.
  const EMPTY_LABELS: ReadonlySet<string> = new Set();
  const viewLabelIdsFor = (ownerId: string): ReadonlySet<string> => {
    if (globalSearching) return EMPTY_LABELS;
    if (combined) {
      return new Set(combined.rules.filter((r) => r.accountId === ownerId).flatMap((r) => r.allOf));
    }
    return new Set([labelId]);
  };

  const firstSearchPage = globalSearching ? gmailSearch.data?.pages[0] : undefined;
  const selectedIndex = visibleMessages.findIndex((message) => message.id === selectedMessageId);
  const selectNeighbor = (step: -1 | 1) => {
    const message = visibleMessages[selectedIndex + step];
    if (message) selectForNavigation(message);
  };
  const floatingReader =
    openMessageId && renderFloatingReader
      ? renderFloatingReader(
          <>
            <HintTooltip label="Previous conversation" shortcut="list.previous">
              <IconBtn
                label="Previous conversation"
                disabled={selectedIndex <= 0}
                onClick={() => selectNeighbor(-1)}
              >
                <ChevronUpIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
            <HintTooltip label="Next conversation" shortcut="list.next">
              <IconBtn
                label="Next conversation"
                disabled={selectedIndex >= visibleMessages.length - 1}
                onClick={() => selectNeighbor(1)}
              >
                <ChevronDownIcon className="size-4" />
              </IconBtn>
            </HintTooltip>
          </>,
          selectedRow?.subject || "Conversation",
        )
      : null;

  // Dragging a row onto a sidebar label: the whole multi-selection when the
  // row is part of it, else just that row.
  const handleRowDragStart = (e: React.DragEvent, message: GmailMessageSummary) => {
    const rows = checked.has(message.id) ? checkedRows : [message];
    console.log("[MessageList:dragStart]", { count: rows.length });
    writeThreadDrag(e.dataTransfer, {
      threads: rows.map((m) => ({
        accountId: m.accountId ?? accountId,
        threadId: m.threadId || m.id,
      })),
      fromLabelId: moveContextLabelId,
    });
    setThreadDragImage(
      e.dataTransfer,
      rows.length > 1
        ? { title: `${rows.length} conversations` }
        : {
            title: senderLabel(message.fromName, message.fromEmail, message.accountId ?? accountId),
            subtitle: message.subject || "(no subject)",
          },
    );
  };

  const renderMessage = (message: GmailMessageSummary) => (
    <div className="message-list-group" key={`${message.accountId ?? accountId}:${message.id}`}>
      <MessageRow
        viewLabelIds={viewLabelIdsFor(message.accountId ?? accountId)}
        message={message}
        selected={selectedMessageId === message.id && !focusedMessageId}
        checked={checked.has(message.id)}
        expanded={expanded.has(threadKey(message))}
        onToggleExpanded={() => setThreadExpanded(message, !expanded.has(threadKey(message)))}
        onDragStart={(e) => handleRowDragStart(e, message)}
        onRowClick={(e) => handleRowClick(e, message)}
        accountId={accountId}
        resolveLabel={resolveLabel}
        combinedMeta={resolveCombinedMeta(message, combined, accounts, resolveLabel)}
        showInboxChip={!inInboxContext}
        onDeleteForever={() => setConfirmDeleteRows([message])}
        onDeselect={onDeselect}
        onChatAgent={() => {
          // Open this conversation in the reader so it becomes the
          // chat panel's attached context, then reveal the panel.
          openMessage(message);
          onOpenChat?.();
        }}
      />
      {threadMessagesOf(message).length > 0 ? (
        <div className="message-list-thread-messages flex flex-col px-2 pb-1">
          {threadMessagesOf(message).map((m) => (
            <ThreadMessageRow
              key={m.id}
              message={m}
              selected={selectedMessageId === message.id && focusedMessageId === m.id}
              onClick={() => {
                clearChecked();
                console.log("[MessageList:selectThreadMessage]", { messageId: m.id });
                openMessage(message, m);
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );

  return (
    <div data-mail-list-pane="" className="relative flex h-full min-w-0 flex-col">
      {search ? (
        <SearchHeader
          key={search.id}
          query={search.query}
          base={search.base}
          onClear={search.onClear}
          onSearch={search.onSearch}
          onExit={search.onExit}
          onOpenMessage={openMessage}
          accounts={accounts}
          scope={search.accountIds}
          onScope={search.onScope}
          estimate={firstSearchPage ? firstSearchPage.estimate : null}
          offline={Boolean(firstSearchPage?.offline)}
          loading={gmailSearch.isFetching && !gmailSearch.isFetchingNextPage}
          focusRef={search.focusRef}
          draft={search.draft}
          onDraftChange={search.onDraftChange}
          messageOpen={search.messageOpen}
          headerLeading={headerLeading}
          headerTrailing={headerTrailing}
        />
      ) : null}
      {/* Header */}
      <div
        className={cn(
          "drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-4",
          search && "hidden",
        )}
      >
        {headerLeading}
        <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {/* A view's space has the title band's controls beside it: its name alone. */}
          {space ? (
            <span className="font-medium text-foreground">{space.name}</span>
          ) : project ? (
            formatConversationSummary(mailboxTotal, mailboxUnread)
          ) : (
            formatMailboxSummary(mailboxTotal, mailboxUnread)
          )}
        </div>
        {space ? (
          <HintTooltip label="Edit view">
            <IconBtn label="Edit view" onClick={space.onEdit}>
              <SlidersHorizontalIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : null}
        {space ? (
          <HintTooltip label="New message" shortcut="compose.new">
            <IconBtn label="New message" onClick={space.onCompose}>
              <SquarePenIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : null}
        <HintTooltip label="Search this mailbox" shortcut="search.focus">
          <IconBtn label="Search this mailbox" onClick={onSearchView}>
            <SearchIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        <HintTooltip label={unreadOnly ? "Show all messages" : "Show unread only"}>
          <IconBtn
            label={unreadOnly ? "Show all messages" : "Show unread only"}
            aria-pressed={unreadOnly}
            onClick={() => setMailboxMode(unreadOnly ? "all" : "unread")}
          >
            <UnreadFilterIcon
              on={unreadOnly}
              className={cn("size-4", unreadOnly && "text-primary")}
            />
          </IconBtn>
        </HintTooltip>
        {headerTrailing}
      </div>

      <ScrollArea
        ref={scrollRef}
        data-message-list-style={messageListStyle}
        data-group-messages-by-day={groupByDay || undefined}
        data-dim-read-messages={dimReadMessages || undefined}
        onScroll={maybeLoadMore}
        className={cn(
          "flex-1",
          roundedLeft && "rounded-bl-xl",
          roundedRight && "rounded-br-xl",
          !search && roundedLeft && "rounded-tl-xl",
          !search && roundedRight && "rounded-tr-xl",
        )}
        contentClassName={filteredMessages.length === 0 ? "h-full" : undefined}
        viewportClassName={[
          "message-list-scroll pb-1 pt-[9px]",
          checked.size > 0 ? "pb-16" : "",
        ].join(" ")}
      >
        {project && !search && !isLoading && filteredMessages.length === 0 ? (
          <EmptyState
            className="px-6 pt-10"
            media={<FolderIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
            title={unreadOnly ? "No unread conversations" : "No conversations yet"}
            description={
              unreadOnly
                ? "Everything here has been read."
                : "Drag conversations onto a project in the sidebar, or add them from a conversation's menu."
            }
          />
        ) : signedOutAccount && !isCombined && !search && filteredMessages.length === 0 ? (
          <SignedOutMailbox account={signedOutAccount} />
        ) : isLoading ? (
          <div className="flex flex-col gap-0">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="message-list-group">
                <div className="message-list-row px-3">
                  <div className="message-list-skeleton flex min-w-0 flex-1 flex-col gap-2">
                    <div className="h-3.5 w-32 animate-skeleton rounded-full bg-secondary" />
                    <div className="h-3 w-48 animate-skeleton rounded-full bg-accent-surface" />
                    <div className="h-3 w-40 animate-skeleton rounded-full bg-accent-surface" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : filteredMessages.length === 0 && (hasNextPage || isFetchingNextPage) ? (
          // Nothing to show yet, but more is coming (big mailboxes still syncing).
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <RotateCwIcon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading more mail…</span>
          </div>
        ) : search && !search.query ? (
          <EmptyState
            className="h-full px-8"
            media={<SearchIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
            title="Search your mail"
            description={SEARCH_HINT}
          />
        ) : search && filteredMessages.length === 0 ? (
          <EmptyState
            className="h-full px-8"
            media={<SearchXIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
            title={gmailSearch.isError ? "Search failed" : "No messages matched your search"}
            description={
              gmailSearch.isError
                ? String(gmailSearch.error?.message ?? "Gmail didn't answer.")
                : "Try different words, or use Advanced search."
            }
          />
        ) : filteredMessages.length === 0 ? (
          <EmptyState
            className="h-full px-6"
            media={<InboxIcon className="size-10 stroke-[1.25] text-muted-foreground" />}
            title={unreadOnly ? "No unread messages" : "No messages"}
            description={
              unreadOnly
                ? "Everything here has been read."
                : searchQuery
                  ? "No messages match your search."
                  : multipleLabels
                    ? "This label is empty."
                    : "This folder is empty."
            }
          />
        ) : (
          <>
            {groupByDay
              ? dayGroups.map((group) => (
                  <MessageDayGroup
                    key={group.day}
                    group={group}
                    collapsed={collapsedDays.has(group.day)}
                    onToggle={() => toggleDay(group)}
                  >
                    {collapsedDays.has(group.day) ? null : group.messages.map(renderMessage)}
                  </MessageDayGroup>
                ))
              : visibleMessages.map(renderMessage)}
            {isFetchingNextPage ? (
              <div className="flex items-center justify-center gap-1.5 py-3">
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary animate-status-pulse"
                  aria-hidden
                />
                <span className="text-xs text-muted-foreground">Loading more</span>
              </div>
            ) : null}
          </>
        )}
      </ScrollArea>

      {checked.size > 0 ? (
        <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center px-3">
          <div className="dropdown-glass flex items-center gap-0.5 rounded-xl px-2 py-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
            <span className="pl-1 text-sm font-medium tabular-nums text-foreground">
              {checked.size}
            </span>
            <span className="pr-1 text-sm text-muted-foreground">selected</span>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            {allTrashed ? (
              <>
                <HintTooltip label="Restore from Trash">
                  <IconBtn label="Restore from Trash" className="size-7" onClick={bulkUntrash}>
                    <RotateCcwIcon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
                <HintTooltip label="Delete Forever">
                  <IconBtn
                    label="Delete Forever"
                    className="size-7"
                    onClick={() => setConfirmDeleteRows(checkedRows)}
                  >
                    <Trash2Icon className="size-4 text-(--red)" />
                  </IconBtn>
                </HintTooltip>
              </>
            ) : allJunk ? (
              <>
                <HintTooltip label="Not Junk — move to Inbox">
                  <IconBtn label="Not Junk" className="size-7" onClick={bulkNotJunk}>
                    <ShieldCheckIcon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
                <HintTooltip label="Move to Trash">
                  <IconBtn label="Move to Trash" className="size-7" onClick={bulkTrash}>
                    <Trash2Icon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
                <HintTooltip label="Delete Forever">
                  <IconBtn
                    label="Delete Forever"
                    className="size-7"
                    onClick={() => setConfirmDeleteRows(checkedRows)}
                  >
                    <Trash2Icon className="size-4 text-(--red)" />
                  </IconBtn>
                </HintTooltip>
              </>
            ) : (
              <>
                <HintTooltip label="Archive">
                  <IconBtn label="Archive" className="size-7" onClick={bulkArchive}>
                    <ArchiveIcon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
                <HintTooltip label="Move to Trash">
                  <IconBtn label="Move to Trash" className="size-7" onClick={bulkTrash}>
                    <Trash2Icon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
                <HintTooltip label="Move to Junk">
                  <IconBtn label="Move to Junk" className="size-7" onClick={bulkJunk}>
                    <ArchiveXIcon className="size-3.5" />
                  </IconBtn>
                </HintTooltip>
              </>
            )}
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <HintTooltip label="Mark as read">
              <IconBtn label="Mark as read" className="size-7" onClick={bulkMarkRead}>
                <MailOpenIcon className="size-3.5" />
              </IconBtn>
            </HintTooltip>
            <HintTooltip label="Mark as unread">
              <IconBtn label="Mark as unread" className="size-7" onClick={bulkMarkUnread}>
                <MailIcon className="size-3.5" />
              </IconBtn>
            </HintTooltip>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <HintTooltip label="Chat about the selection with the agent">
              <IconBtn label="Open in agent chat" className="size-7" onClick={() => onOpenChat?.()}>
                <MousePointer2Icon className="size-3.5" />
              </IconBtn>
            </HintTooltip>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
            <HintTooltip label="Clear selection" hint="Esc">
              <IconBtn label="Clear selection" className="size-7" onClick={clearChecked}>
                <XIcon className="size-3.5" />
              </IconBtn>
            </HintTooltip>
          </div>
        </div>
      ) : null}

      {floatingReader}
      <Dialog
        open={confirmDeleteRows != null}
        onOpenChange={(o) => {
          if (!o) setConfirmDeleteRows(null);
        }}
        title="Delete Forever"
        confirmLabel="Delete Forever"
        confirmVariant="accent"
        onConfirm={handleDeleteForeverConfirm}
      >
        <Text variant="small">
          Permanently delete{" "}
          {confirmDeleteRows && confirmDeleteRows.length === 1
            ? "this conversation"
            : `${confirmDeleteRows?.length ?? 0} conversations`}
          ? This cannot be undone.
        </Text>
      </Dialog>

      <LabelOverlay
        open={labelOverlay != null}
        onOpenChange={(o) => {
          if (!o) setLabelOverlay(null);
        }}
        mode={labelOverlay ?? "label"}
        accountId={selectedOwner}
        appliedLabelIds={selectedRow ? rowLabels(selectedRow) : []}
        currentLabelId={moveContextLabelId}
        onPick={handleOverlayPick}
      />
    </div>
  );
}
