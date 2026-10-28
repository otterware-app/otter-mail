import type React from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
} from "./menu";
import { useCapabilities } from "./capabilities";
import { useLabels, useModifyThread } from "./hooks";
import { buildLabelTree, type LabelTreeNode, isAssignableLabel } from "./label-tree";
import type { MailLabel } from "./types";

type LabelChoicesParams = {
  /** Owning account of the message (per-row account in Combined mode). */
  accountId: string;
  /** The conversation to label (labels apply to the whole thread, like Gmail). */
  threadId: string;
  /** Labels currently on the conversation (union over its messages). */
  labelIds: string[];
};

type LabelPickerMenuProps = LabelChoicesParams & {
  /** Trigger element (rendered via asChild — must accept a ref). */
  children: React.ReactNode;
};

/** Menu-component set: DropdownMenu* and ContextMenu* both satisfy this shape. */
export type LabelMenuKit = {
  Item: React.ComponentType<{ disabled?: boolean; children: React.ReactNode }>;
  CheckboxItem: React.ComponentType<{
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    children: React.ReactNode;
  }>;
  Sub: React.ComponentType<{ label: string; inset?: boolean; children: React.ReactNode }>;
  Separator: React.ComponentType;
};

/**
 * Renders a label tree as menu items: nested labels become submenus whose
 * first item is the parent itself (so it stays selectable), siblings
 * alphabetical at every depth via buildLabelTree.
 */
export function renderLabelMenuNodes(
  nodes: LabelTreeNode[],
  applied: Set<string>,
  onToggle: (labelId: string, checked: boolean) => void,
  kit: LabelMenuKit,
): React.ReactNode {
  const renderNode = (node: LabelTreeNode): React.ReactNode => {
    if (node.children.length === 0) {
      if (!node.label) return null;
      const id = node.label.id;
      return (
        <kit.CheckboxItem
          key={node.key}
          checked={applied.has(id)}
          onCheckedChange={(checked) => onToggle(id, checked)}
        >
          {node.segment}
        </kit.CheckboxItem>
      );
    }
    const selfId = node.label?.id;
    return (
      <kit.Sub key={node.key} label={node.segment} inset>
        {selfId ? (
          <>
            <kit.CheckboxItem
              checked={applied.has(selfId)}
              onCheckedChange={(checked) => onToggle(selfId, checked)}
            >
              {node.segment}
            </kit.CheckboxItem>
            <kit.Separator />
          </>
        ) : null}
        {node.children.map(renderNode)}
      </kit.Sub>
    );
  };
  return nodes.map(renderNode);
}

/**
 * Moving a conversation to one folder, for mailboxes whose mail sits in one
 * folder at a time (IMAP: no `multipleLabels`): the folder is added and the
 * folders it was in (Inbox, or another of `labels`) come off.
 */
export function moveToFolder(labelIds: string[], folderId: string, labels: MailLabel[]) {
  const folders = new Set(["INBOX", ...labels.filter(isAssignableLabel).map((l) => l.id)]);
  return {
    addLabelIds: [folderId],
    removeLabelIds: labelIds.filter((id) => id !== folderId && folders.has(id)),
  };
}

/**
 * A conversation's label checklist: the labels it can take, and toggling one.
 * In a mailbox with one folder per message it becomes "Move to folder": Inbox
 * first, and picking a folder moves the conversation there.
 */
export function useLabelChoices({ accountId, threadId, labelIds }: LabelChoicesParams) {
  const labelsQuery = useLabels(accountId);
  const modifyThread = useModifyThread();
  const { multipleLabels, foldersAndCategories } = useCapabilities(accountId);
  const labels = labelsQuery.data ?? [];
  const tree = buildLabelTree(
    labels
      .filter(isAssignableLabel)
      .filter((label) => !foldersAndCategories || label.id.startsWith("category:")),
  );
  const applied = new Set(labelIds);

  const toggle = (labelId: string, checked: boolean) => {
    console.log("[LabelPickerMenu:toggle]", { accountId, threadId, labelId, checked });
    if (!multipleLabels) {
      // Unchecking the folder it's in has nowhere to move it.
      if (checked) {
        void modifyThread.mutateAsync({
          accountId,
          threadId,
          ...moveToFolder(labelIds, labelId, labels),
        });
      }
      return;
    }
    void modifyThread.mutateAsync({
      accountId,
      threadId,
      addLabelIds: checked ? [labelId] : undefined,
      removeLabelIds: checked ? undefined : [labelId],
    });
  };

  return {
    tree,
    applied,
    toggle,
    folders: !multipleLabels,
    title: foldersAndCategories ? "Categorize" : multipleLabels ? "Label" : "Move to folder",
    empty: foldersAndCategories ? "No categories" : "No labels",
  };
}

/** The checklist's items: "No labels", or the tree (after Inbox, for folders). */
export function renderLabelChoices(
  { tree, applied, toggle, folders, empty }: ReturnType<typeof useLabelChoices>,
  kit: LabelMenuKit,
): React.ReactNode {
  if (!folders) {
    return tree.length === 0 ? (
      <kit.Item disabled>{empty}</kit.Item>
    ) : (
      renderLabelMenuNodes(tree, applied, toggle, kit)
    );
  }
  return (
    <>
      <kit.CheckboxItem
        checked={applied.has("INBOX")}
        onCheckedChange={(checked) => toggle("INBOX", checked)}
      >
        Inbox
      </kit.CheckboxItem>
      {tree.length > 0 ? <kit.Separator /> : null}
      {renderLabelMenuNodes(tree, applied, toggle, kit)}
    </>
  );
}

const DROPDOWN_KIT: LabelMenuKit = {
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  Sub: DropdownMenuSub,
  Separator: DropdownMenuSeparator,
};

export function LabelPickerMenu({ children, ...params }: LabelPickerMenuProps) {
  const choices = useLabelChoices(params);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {choices.folders ? <DropdownMenuLabel>Move to folder</DropdownMenuLabel> : null}
        {renderLabelChoices(choices, DROPDOWN_KIT)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same label checklist as a submenu ("Label ▸"), for overflow menus. */
export function LabelSubmenu(params: LabelChoicesParams) {
  const choices = useLabelChoices(params);
  return (
    <DropdownMenuSub label={choices.title}>
      {renderLabelChoices(choices, DROPDOWN_KIT)}
    </DropdownMenuSub>
  );
}
