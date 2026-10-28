import type { GmailLabel } from "./types";

export type LabelTreeNode = {
  key: string;
  segment: string;
  label?: GmailLabel;
  children: LabelTreeNode[];
};

// Gmail nests user labels by "/" in the name (e.g. "99/personal" is a child of "99").
// Build a tree from the flat list so callers can render it with proper disclosure/indent nesting.
/** Id prefix of a label created optimistically, before Gmail assigned its id. */
export const PENDING_LABEL_PREFIX = "pending:";

/** User labels that can be applied to mail right now (not still being created). */
export function isAssignableLabel(label: GmailLabel): boolean {
  return label.type === "user" && !label.id.startsWith(PENDING_LABEL_PREFIX);
}

export function buildLabelTree(labels: GmailLabel[]): LabelTreeNode[] {
  const root: LabelTreeNode[] = [];
  const nodesByPath = new Map<string, LabelTreeNode>();

  for (const label of labels) {
    const parts = label.name.split("/").filter(Boolean);
    let siblings = root;
    let path = "";
    parts.forEach((part, i) => {
      path = path ? `${path}/${part}` : part;
      let node = nodesByPath.get(path);
      if (!node) {
        node = { key: path, segment: part, children: [] };
        nodesByPath.set(path, node);
        siblings.push(node);
      }
      if (i === parts.length - 1) node.label = label;
      siblings = node.children;
    });
  }

  sortLabelTree(root);
  return root;
}

export function sortLabelTree(nodes: LabelTreeNode[]): void {
  nodes.sort((a, b) => a.segment.localeCompare(b.segment));
  for (const node of nodes) sortLabelTree(node.children);
}

// Flatten a label tree into a depth-annotated list (pre-order) for non-collapsible,
// indentation-only rendering (e.g. a flat checkbox list).
export function flattenLabelTree(
  nodes: LabelTreeNode[],
  depth = 0,
): { node: LabelTreeNode; depth: number }[] {
  const result: { node: LabelTreeNode; depth: number }[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    result.push(...flattenLabelTree(node.children, depth + 1));
  }
  return result;
}
