import type { ActionSummary } from "./undo";

/**
 * Names a label change the way the action toast reads it: "Archived",
 * "Moved to “Clients”", "Marked as junk". `labelName` resolves user labels.
 */
export function summarizeLabelChange(
  add: string[],
  remove: string[],
  noun: ActionSummary["noun"],
  labelName: (labelId: string) => string | undefined,
): ActionSummary {
  const s = (verb: string, suffix?: string): ActionSummary => ({ verb, suffix, noun });
  const quoted = (id: string) => `“${labelName(id) ?? id}”`;
  const isUser = (id: string) => labelName(id) !== undefined;

  if (add.includes("TRASH")) return s("Moved", " to Trash");
  if (remove.includes("TRASH")) return s("Restored", " from Trash");
  if (add.includes("SPAM")) return s("Marked", " as junk");
  if (remove.includes("SPAM")) return s("Marked", " as not junk");

  const addedLabel = add.find(isUser);
  if (addedLabel) {
    // Leaving something behind (the Inbox, another label) makes it a move.
    return remove.length > 0
      ? s("Moved", ` to ${quoted(addedLabel)}`)
      : s("Labeled", ` ${quoted(addedLabel)}`);
  }
  if (add.includes("INBOX")) return s("Moved", " to Inbox");
  if (remove.includes("INBOX")) return s("Archived");
  const removedLabel = remove.find(isUser);
  if (removedLabel) return s("Removed", ` from ${quoted(removedLabel)}`);
  if (add.includes("STARRED")) return s("Flagged");
  if (remove.includes("STARRED")) return s("Unflagged");
  if (add.includes("UNREAD")) return s("Marked", " as unread");
  if (remove.includes("UNREAD")) return s("Marked", " as read");
  if (add.includes("IMPORTANT")) return s("Marked", " as important");
  if (remove.includes("IMPORTANT")) return s("Marked", " as not important");
  return s("Updated");
}
