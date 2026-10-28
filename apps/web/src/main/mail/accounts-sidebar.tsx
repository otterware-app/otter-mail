import { Fragment, createContext, useContext, useState, type ReactNode } from "react";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Text } from "~/components/ui/text";
import { toast } from "./toast";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "./menu";
import {
  ArchiveIcon,
  InboxIcon,
  MailsIcon,
  StarIcon,
  FlagIcon,
  SendIcon,
  FileIcon,
  BookmarkIcon,
  ArchiveXIcon,
  XIcon,
  Trash2Icon,
  ClockIcon,
  PlusIcon,
  ChevronDownIcon,
  TagIcon,
  FolderIcon,
  SearchIcon,
} from "lucide-react";
import {
  useLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
  useModifyThread,
  useEmptyFolder,
} from "./hooks";
import type { MailLabel } from "./types";
import { ALL_MAIL_LABEL_ID, ARCHIVE_LABEL_ID, SNOOZED_LABEL_ID } from "./label-names";
import { buildLabelTree, type LabelTreeNode } from "./label-tree";
import {
  isMoveSourceLabel,
  isThreadDrag,
  readThreadDrag,
  type ThreadDragPayload,
} from "./thread-drag";
import { beginUndoGroup } from "./undo";
import { labelMoveName } from "../keybindings/commands";
import { renameLabelKeybindings, useKeybindingsState } from "../keybindings/store";
import { formatShortcut, parseShortcut } from "../keybindings/keys";
import { LabelShortcutDialog } from "../settings/keybindings-pane";
import { Section, SectionAddButton, SkRow, type RowDragProps } from "./sidebar-ui";
import { useCapabilities } from "./capabilities";

const LABEL_DRAG_MIME = "application/x-gmail-label";

type LabelDragPayload = { id: string; name: string };

/** Gmail's labels API only accepts colors from its fixed palette. */
const GMAIL_LABEL_COLORS: { backgroundColor: string; textColor: string }[] = [
  { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  { backgroundColor: "#cc3a21", textColor: "#ffffff" },
  { backgroundColor: "#efa093", textColor: "#000000" },
  { backgroundColor: "#ff7537", textColor: "#ffffff" },
  { backgroundColor: "#ffad47", textColor: "#000000" },
  { backgroundColor: "#ffd6a2", textColor: "#000000" },
  { backgroundColor: "#fad165", textColor: "#000000" },
  { backgroundColor: "#fcda83", textColor: "#000000" },
  { backgroundColor: "#16a766", textColor: "#ffffff" },
  { backgroundColor: "#149e60", textColor: "#ffffff" },
  { backgroundColor: "#43d692", textColor: "#000000" },
  { backgroundColor: "#89d3b2", textColor: "#000000" },
  { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  { backgroundColor: "#3c78d8", textColor: "#ffffff" },
  { backgroundColor: "#285bac", textColor: "#ffffff" },
  { backgroundColor: "#a4c2f4", textColor: "#000000" },
  { backgroundColor: "#a479e2", textColor: "#ffffff" },
  { backgroundColor: "#8e63ce", textColor: "#ffffff" },
  { backgroundColor: "#b99aff", textColor: "#000000" },
  { backgroundColor: "#f691b3", textColor: "#000000" },
  { backgroundColor: "#e07798", textColor: "#ffffff" },
  { backgroundColor: "#666666", textColor: "#ffffff" },
  { backgroundColor: "#999999", textColor: "#ffffff" },
  { backgroundColor: "#cccccc", textColor: "#000000" },
];

const SIDEBAR_SYSTEM_ORDER = [
  "INBOX",
  "STARRED",
  SNOOZED_LABEL_ID,
  "SENT",
  "DRAFT",
  "IMPORTANT",
  ALL_MAIL_LABEL_ID,
  ARCHIVE_LABEL_ID,
  "SPAM",
  "TRASH",
];

const SYSTEM_LABEL_MAP: Record<string, { name: string; icon: ReactNode }> = {
  INBOX: { name: "Inbox", icon: <InboxIcon className="size-4" /> },
  STARRED: { name: "Starred", icon: <StarIcon className="size-4" /> },
  SENT: { name: "Sent", icon: <SendIcon className="size-4" /> },
  DRAFT: { name: "Drafts", icon: <FileIcon className="size-4" /> },
  IMPORTANT: { name: "Important", icon: <BookmarkIcon className="size-4" /> },
  [ALL_MAIL_LABEL_ID]: { name: "All Mail", icon: <MailsIcon className="size-4" /> },
  [ARCHIVE_LABEL_ID]: { name: "Archive", icon: <ArchiveIcon className="size-4" /> },
  [SNOOZED_LABEL_ID]: { name: "Snoozed", icon: <ClockIcon className="size-4" /> },
  SPAM: { name: "Junk", icon: <ArchiveXIcon className="size-4" /> },
  TRASH: { name: "Trash", icon: <Trash2Icon className="size-4" /> },
};

const FLAGGED = { name: "Flagged", icon: <FlagIcon className="size-4" /> };

/** An open search, listed under the view it was started from. */
export type SidebarSearch = { id: string; parent: string; title: string; selected: boolean };

/** Renders a view's / label's open search row (if any) right below it. */
const noSearchRows = () => null;
const SearchRowsContext = createContext<(parent: string, depth: number) => ReactNode>(noSearchRows);

function SearchRows({ parent, depth = 0 }: { parent: string; depth?: number }) {
  return useContext(SearchRowsContext)(parent, depth);
}

export function SearchRow({
  search,
  depth,
  onSelect,
  onClose,
}: {
  search: SidebarSearch;
  depth: number;
  onSelect: () => void;
  onClose: () => void;
}) {
  return (
    <SkRow
      icon={<SearchIcon className="size-4" />}
      title={search.title}
      depth={depth + 1}
      selected={search.selected}
      onClick={onSelect}
      trailing={
        <span
          role="button"
          tabIndex={-1}
          aria-label="Close search"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-sidebar-foreground"
        >
          <XIcon className="size-3.5" />
        </span>
      }
    />
  );
}

function labelIcon(label?: MailLabel): ReactNode {
  if (label?.id.startsWith("folder:")) return <FolderIcon className="size-4" />;
  const color = label?.color?.backgroundColor;
  if (color) {
    return <TagIcon className="size-4 fill-current" style={{ color }} />;
  }
  return <TagIcon className="size-4" />;
}

type LabelActions = {
  /** "label", or "folder" in a mailbox whose mail sits in one folder (IMAP). */
  noun: string;
  onRename: (label: MailLabel) => void;
  /** Absent when the mailbox's labels have no colors. */
  onRecolor?: (label: MailLabel) => void;
  onDelete: (label: MailLabel) => void;
  onMove: (source: LabelDragPayload, targetParentName: string | null) => void;
  /** Conversations dropped from the message list; `keep` = ⌥ held (label only). */
  onDropThreads: (payload: ThreadDragPayload, label: MailLabel, keep: boolean) => void;
  onEditShortcut: (label: MailLabel) => void;
  /** The label's own move shortcut, formatted (⌘⇧1), if it has one. */
  shortcutFor: (label: MailLabel) => string | undefined;
};

function LabelNode({
  node,
  depth,
  selectedLabelId,
  onSelectLabel,
  actions,
}: {
  node: LabelTreeNode;
  depth: number;
  selectedLabelId: string;
  onSelectLabel: (labelId: string) => void;
  actions: LabelActions;
}): ReactNode {
  const [open, setOpen] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const { label, children } = node;
  const unread = label?.unread && label.unread > 0 ? label.unread : 0;
  const hasChildren = children.length > 0;

  // Drag to nest: rows are both sources and targets. Drop payloads aren't
  // readable during dragover, so self/descendant checks happen on drop.
  // Conversations dragged from the list drop here too: moved to the label,
  // or only labelled with ⌥ held (Finder's copy modifier).
  const dragProps: RowDragProps | undefined = label
    ? {
        draggable: !label.id.startsWith("category:"),
        onDragStart: (e) => {
          e.dataTransfer.setData(
            LABEL_DRAG_MIME,
            JSON.stringify({ id: label.id, name: label.name } satisfies LabelDragPayload),
          );
          e.dataTransfer.effectAllowed = "move";
        },
        onDragOver: (e) => {
          if (isThreadDrag(e.dataTransfer)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
            setDropActive(true);
            return;
          }
          if (!e.dataTransfer.types.includes(LABEL_DRAG_MIME)) return;
          if (label.id.startsWith("category:")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropActive(true);
        },
        onDragLeave: () => setDropActive(false),
        onDrop: (e) => {
          setDropActive(false);
          const threads = readThreadDrag(e.dataTransfer);
          if (threads) {
            e.preventDefault();
            actions.onDropThreads(threads, label, e.altKey);
            return;
          }
          const raw = e.dataTransfer.getData(LABEL_DRAG_MIME);
          if (!raw || label.id.startsWith("category:")) return;
          e.preventDefault();
          actions.onMove(JSON.parse(raw) as LabelDragPayload, label.name);
        },
      }
    : undefined;

  const row = (
    <SkRow
      icon={
        hasChildren ? (
          <span
            role="button"
            tabIndex={-1}
            aria-label={open ? `Collapse ${node.segment}` : `Expand ${node.segment}`}
            className="flex items-center"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
          >
            <ChevronDownIcon
              className={["size-4 transition-transform", open ? "" : "-rotate-90"].join(" ")}
            />
          </span>
        ) : (
          labelIcon(label)
        )
      }
      title={node.segment}
      depth={depth}
      selected={label ? selectedLabelId === label.id : false}
      badge={unread}
      dragProps={dragProps}
      dropActive={dropActive}
      onClick={
        label
          ? () => {
              console.log("[AccountsSidebar:selectLabel]", { labelId: label.id });
              onSelectLabel(label.id);
            }
          : () => setOpen((o) => !o)
      }
    />
  );

  return (
    <>
      {label ? (
        <ContextMenu>
          <ContextMenuTrigger>{row}</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon="pencil" onSelect={() => actions.onRename(label)}>
              Rename…
            </ContextMenuItem>
            {actions.onRecolor && !label.id.startsWith("folder:") ? (
              <ContextMenuItem icon="paintpalette" onSelect={() => actions.onRecolor?.(label)}>
                Change color…
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem
              icon="keyboard"
              accelerator={actions.shortcutFor(label)}
              onSelect={() => actions.onEditShortcut(label)}
            >
              Keyboard shortcut…
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem icon="trash" color="red" onSelect={() => actions.onDelete(label)}>
              Delete {label.id.startsWith("folder:") ? "folder" : actions.noun}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        row
      )}
      {label ? <SearchRows parent={label.id} depth={depth} /> : null}
      {open
        ? children.map((child) => (
            <LabelNode
              key={child.key}
              node={child}
              depth={depth + 1}
              selectedLabelId={selectedLabelId}
              onSelectLabel={onSelectLabel}
              actions={actions}
            />
          ))
        : null}
    </>
  );
}

/**
 * One mailbox's folders and labels, in the sidebar under its tab
 * (app-sidebar.tsx), with what they offer: a label's menu, dropping
 * conversations or labels on one, emptying Junk and Trash.
 */
export function MailboxFolders({
  mailboxId,
  selectedLabelId,
  onSelectLabel,
  searchRows,
  depth = 0,
}: {
  /** The account's id. */
  mailboxId: string;
  /** The folder or label showing, while this mailbox is the one showing; "" otherwise. */
  selectedLabelId: string;
  onSelectLabel: (labelId: string) => void;
  /** Its open searches, under where each started (the mailbox showing has them). */
  searchRows?: (parent: string, depth: number) => ReactNode;
  /** How far its rows are indented. */
  depth?: number;
}) {
  const labelsQuery = useLabels(mailboxId);
  const capabilities = useCapabilities(mailboxId);
  // Mail in one folder at a time (IMAP): its labels are folders.
  const labelNoun = capabilities.foldersAndCategories
    ? "Category"
    : capabilities.multipleLabels
      ? "Label"
      : "Folder";
  const createLabel = useCreateLabel();

  const [createLabelOpen, setCreateLabelOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const updateLabel = useUpdateLabel();
  const deleteLabelMutation = useDeleteLabel();
  const [renameTarget, setRenameTarget] = useState<MailLabel | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [colorTarget, setColorTarget] = useState<MailLabel | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MailLabel | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [shortcutTarget, setShortcutTarget] = useState<string | null>(null);
  // Empty Junk / Empty Trash, waiting for its confirmation.
  const [emptyTarget, setEmptyTarget] = useState<"SPAM" | "TRASH" | null>(null);
  const emptyFolder = useEmptyFolder();
  const modifyThread = useModifyThread();
  const { rules: keybindingRules } = useKeybindingsState();

  const labels: MailLabel[] = labelsQuery.data ?? [];

  // All Mail isn't a Gmail label (archived mail just lacks INBOX), so it's
  // listed without one — and, like Gmail, without an unread badge. Where the
  // Archive is a folder of its own (Outlook, IMAP), archived mail is there and
  // All Mail isn't a place; an IMAP server's Archive may be made on first use.
  // Important is Gmail's sorting, where the mailbox has it.
  const shown = (id: string) =>
    (id !== "IMPORTANT" || capabilities.categories) &&
    id !== (capabilities.archiveFolder ? ALL_MAIL_LABEL_ID : ARCHIVE_LABEL_ID);
  const systemLabels = SIDEBAR_SYSTEM_ORDER.filter(shown).flatMap((id): MailLabel[] => {
    const label = labels.find((l) => l.id === id);
    if (label) return [label];
    return id === ALL_MAIL_LABEL_ID || id === ARCHIVE_LABEL_ID
      ? [{ id, name: id, type: "system" }]
      : [];
  });
  const userLabels = labels.filter((l) => l.type === "user");
  const labelSections = capabilities.foldersAndCategories
    ? [
        {
          title: "Folders",
          labels: userLabels.filter((l) => l.id.startsWith("folder:")),
          create: false,
        },
        {
          title: "Categories",
          labels: userLabels.filter((l) => !l.id.startsWith("folder:")),
          create: true,
        },
      ]
    : [{ title: `${labelNoun}s`, labels: userLabels, create: true }];

  const handleCreateLabel = async () => {
    const name = newLabelName.trim();
    if (!name || !mailboxId) return;
    console.log("[AccountsSidebar:createLabel]", { name });
    try {
      await createLabel.mutateAsync({ accountId: mailboxId, name });
      toast.success(`${labelNoun} "${name}" created`);
      setCreateLabelOpen(false);
      setNewLabelName("");
    } catch {
      toast.error("Failed to create label");
    }
  };

  const handleMoveLabel = (source: LabelDragPayload, targetParentName: string | null) => {
    if (!mailboxId || source.id.startsWith("category:")) return;
    if (
      targetParentName &&
      (targetParentName === source.name || targetParentName.startsWith(`${source.name}/`))
    ) {
      toast.error("Can't nest a label inside itself");
      return;
    }
    const segment = source.name.split("/").pop() ?? source.name;
    const newName = targetParentName ? `${targetParentName}/${segment}` : segment;
    if (newName === source.name) return;
    console.log("[AccountsSidebar:moveLabel]", { from: source.name, to: newName });
    updateLabel
      .mutateAsync({ accountId: mailboxId, labelId: source.id, name: newName })
      .then(() => renameLabelKeybindings(source.name, newName))
      .catch(() => toast.error("Could not move the label"));
  };

  const handleRenameConfirm = () => {
    const name = renameValue.trim();
    const target = renameTarget;
    setRenameTarget(null);
    if (!target || !name || !mailboxId || name === target.name) return;
    console.log("[AccountsSidebar:renameLabel]", { from: target.name, to: name });
    updateLabel
      .mutateAsync({ accountId: mailboxId, labelId: target.id, name })
      .then(() => renameLabelKeybindings(target.name, name))
      .catch(() => toast.error("Could not rename the label"));
  };

  const handlePickColor = (color: { backgroundColor: string; textColor: string }) => {
    const target = colorTarget;
    setColorTarget(null);
    if (!target || !mailboxId) return;
    console.log("[AccountsSidebar:recolorLabel]", {
      label: target.name,
      color: color.backgroundColor,
    });
    updateLabel
      .mutateAsync({ accountId: mailboxId, labelId: target.id, color })
      .catch(() => toast.error("Could not change the color"));
  };

  const handleDeleteConfirm = () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target || !mailboxId) return;
    if (selectedLabelId === target.id) onSelectLabel("INBOX");
    console.log("[AccountsSidebar:deleteLabel]", { label: target.name });
    deleteLabelMutation
      .mutateAsync({ accountId: mailboxId, labelId: target.id })
      .catch(() => toast.error("Could not delete the label"));
  };

  // Labels here belong to the open account, so only its conversations can
  // take them (a search may list other accounts' mail too).
  const handleDropThreads = (payload: ThreadDragPayload, label: MailLabel, keep: boolean) => {
    const threads = payload.threads.filter((t) => t.accountId === mailboxId);
    if (threads.length === 0) {
      toast.error("Those conversations belong to another account");
      return;
    }
    const removeId =
      !label.id.startsWith("category:") &&
      (!keep || !capabilities.multipleLabels || label.id.startsWith("folder:")) &&
      payload.fromLabelId &&
      isMoveSourceLabel(payload.fromLabelId, label.id, capabilities.foldersAndCategories)
        ? payload.fromLabelId
        : null;
    console.log("[AccountsSidebar:dropThreads]", {
      label: label.name,
      count: threads.length,
      from: removeId,
    });
    beginUndoGroup(threads.length);
    for (const t of threads) {
      void modifyThread.mutateAsync({
        accountId: t.accountId,
        threadId: t.threadId,
        addLabelIds: [label.id],
        removeLabelIds: removeId ? [removeId] : undefined,
      });
    }
    // The action toast ("Moved 3 conversations to “X”", with Undo) comes from
    // the undo registry.
  };

  const labelActions: LabelActions = {
    noun: labelNoun.toLowerCase(),
    onRename: (label) => {
      setRenameValue(label.name);
      setRenameTarget(label);
    },
    onRecolor: capabilities.labelColors ? (label) => setColorTarget(label) : undefined,
    onDelete: (label) => setDeleteTarget(label),
    onMove: handleMoveLabel,
    onDropThreads: handleDropThreads,
    onEditShortcut: (label) => setShortcutTarget(label.name),
    shortcutFor: (label) => {
      const rule = keybindingRules.find((r) => labelMoveName(r.command) === label.name);
      const shortcut = rule ? parseShortcut(rule.key) : null;
      return shortcut ? formatShortcut(shortcut) : undefined;
    },
  };

  /** Right-click on Junk/Trash → Empty…. */
  const withEmptyMenu = (row: ReactNode, labelId: string) => {
    if (labelId !== "SPAM" && labelId !== "TRASH") return row;
    return (
      <ContextMenu>
        <ContextMenuTrigger>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem icon="trash" color="red" onSelect={() => setEmptyTarget(labelId)}>
            {labelId === "SPAM" ? "Empty Junk…" : "Empty Trash…"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  return (
    <SearchRowsContext.Provider value={searchRows ?? noSearchRows}>
      <>
        {(labels.length > 0
          ? systemLabels.map((l) => ({
              id: l.id,
              unread: l.unread ?? 0,
              total: l.total ?? 0,
            }))
          : SIDEBAR_SYSTEM_ORDER.filter(shown).map((id) => ({ id, unread: 0, total: 0 }))
        ).map(({ id, unread, total }) => {
          // Outlook's and IMAP's flag is Flagged, Gmail's star Starred.
          const meta = id === "STARRED" && !capabilities.stars ? FLAGGED : SYSTEM_LABEL_MAP[id];
          if (!meta) return null;
          // Drafts is a raw count of drafts, not an unread signal.
          const isDrafts = id === "DRAFT";
          return (
            <Fragment key={id}>
              {withEmptyMenu(
                <SkRow
                  icon={meta.icon}
                  title={meta.name}
                  depth={depth}
                  selected={selectedLabelId === id}
                  badge={isDrafts ? total : unread}
                  onClick={() => {
                    console.log("[AccountsSidebar:selectLabel]", { labelId: id });
                    onSelectLabel(id);
                  }}
                />,
                id,
              )}
              <SearchRows parent={id} depth={depth} />
            </Fragment>
          );
        })}

        {labelSections.map((section) =>
          section.labels.length === 0 ? (
            // None yet: a row to make the first, rather than an empty heading.
            section.create ? (
              <SkRow
                key={section.title}
                icon={<PlusIcon className="size-4" />}
                title={`New ${labelNoun.toLowerCase()}`}
                depth={depth}
                onClick={() => setCreateLabelOpen(true)}
              />
            ) : null
          ) : (
            <Section
              key={section.title}
              title={section.title}
              depth={depth}
              action={
                section.create ? (
                  <SectionAddButton
                    label={`Add ${labelNoun.toLowerCase()}`}
                    onClick={() => setCreateLabelOpen(true)}
                  />
                ) : undefined
              }
              dropZone={
                section.title === "Categories"
                  ? undefined
                  : {
                      active: rootDropActive,
                      onDragOver: (e) => {
                        if (!e.dataTransfer.types.includes(LABEL_DRAG_MIME)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setRootDropActive(true);
                      },
                      onDragLeave: () => setRootDropActive(false),
                      onDrop: (e) => {
                        setRootDropActive(false);
                        const raw = e.dataTransfer.getData(LABEL_DRAG_MIME);
                        if (!raw) return;
                        e.preventDefault();
                        handleMoveLabel(JSON.parse(raw) as LabelDragPayload, null);
                      },
                    }
              }
            >
              {(section.title === "Categories"
                ? section.labels
                    .toSorted((a, b) => a.name.localeCompare(b.name))
                    .map((label) => ({
                      key: label.id,
                      segment: label.name,
                      label,
                      children: [],
                    }))
                : buildLabelTree(section.labels)
              ).map((node) => (
                <LabelNode
                  key={node.key}
                  node={node}
                  depth={depth}
                  selectedLabelId={selectedLabelId}
                  onSelectLabel={onSelectLabel}
                  actions={labelActions}
                />
              ))}
            </Section>
          ),
        )}
      </>

      <Dialog
        open={createLabelOpen}
        onOpenChange={setCreateLabelOpen}
        title={`New ${labelNoun}`}
        confirmLabel="Create"
        confirmVariant="accent"
        confirmDisabled={!newLabelName.trim() || createLabel.isPending}
        onConfirm={handleCreateLabel}
      >
        <Field label="Name" orientation="vertical">
          <Input
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
            placeholder="e.g. 04 Follow-up"
            autoFocus
          />
        </Field>
      </Dialog>

      <Dialog
        open={renameTarget != null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null);
        }}
        title={`Rename ${renameTarget?.id.startsWith("folder:") ? "Folder" : labelNoun}`}
        confirmLabel="Rename"
        confirmVariant="accent"
        confirmDisabled={!renameValue.trim()}
        onConfirm={handleRenameConfirm}
      >
        <Field label="Name" orientation="vertical">
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="e.g. 90 Ops/alerts"
            autoFocus
          />
        </Field>
        <Text variant="mini" color="tertiary">
          Use / to nest, e.g. "90 Ops/alerts". Nested labels move along.
        </Text>
      </Dialog>

      <Dialog
        open={colorTarget != null}
        onOpenChange={(o) => {
          if (!o) setColorTarget(null);
        }}
        title={colorTarget ? `Color for "${colorTarget.name.split("/").pop()}"` : "Label Color"}
      >
        <div className="grid grid-cols-8 gap-2 py-1">
          {GMAIL_LABEL_COLORS.map((color) => (
            <button
              key={color.backgroundColor}
              type="button"
              aria-label={`Use ${color.backgroundColor}`}
              onClick={() => handlePickColor(color)}
              className={[
                "size-6 rounded-full",
                colorTarget?.color?.backgroundColor === color.backgroundColor
                  ? "ring-2 ring-accent ring-offset-1"
                  : "hover:ring-2 hover:ring-input",
              ].join(" ")}
              style={{ backgroundColor: color.backgroundColor }}
            />
          ))}
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget != null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={`Delete ${deleteTarget?.id.startsWith("folder:") ? "Folder" : labelNoun}`}
        confirmLabel="Delete"
        confirmVariant="accent"
        onConfirm={handleDeleteConfirm}
      >
        <Text variant="small">
          {deleteTarget?.id.startsWith("folder:")
            ? `Delete "${deleteTarget.name}"? The folder and the mail inside it move to Deleted Items.`
            : capabilities.multipleLabels
              ? `Delete "${deleteTarget?.name}"? It is removed from every message; the messages themselves and any nested labels are kept.`
              : `Delete "${deleteTarget?.name}"? Its mail moves to Archive.`}
        </Text>
      </Dialog>

      <LabelShortcutDialog labelName={shortcutTarget} onClose={() => setShortcutTarget(null)} />

      <Dialog
        open={emptyTarget != null}
        onOpenChange={(o) => {
          if (!o) setEmptyTarget(null);
        }}
        title={emptyTarget === "TRASH" ? "Empty Trash" : "Empty Junk"}
        confirmLabel={emptyTarget === "TRASH" ? "Empty Trash" : "Empty Junk"}
        confirmVariant="destructive"
        onConfirm={() => {
          const labelId = emptyTarget;
          setEmptyTarget(null);
          if (labelId) emptyFolder.mutate({ accountId: mailboxId, labelId });
        }}
      >
        <Text variant="small">
          Permanently delete every message in {emptyTarget === "TRASH" ? "Trash" : "Junk"}? This
          can't be undone.
        </Text>
      </Dialog>
    </SearchRowsContext.Provider>
  );
}
