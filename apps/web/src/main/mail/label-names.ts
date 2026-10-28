import type { MailCapabilities } from "@otter-mail/contracts";
import type { GmailLabel } from "./types";

/** Pseudo label id for "All Mail" (every message but Spam/Trash) — mirrors the backend. */
export const ALL_MAIL_LABEL_ID = "ALL_MAIL";

/** The Archive folder's label, where it's a folder of its own (Outlook, IMAP). */
export { ARCHIVE_LABEL_ID } from "@otter-mail/contracts";

/** Friendly display names for Gmail's system labels. */
export const SYSTEM_LABEL_NAMES: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  SPAM: "Spam",
  TRASH: "Trash",
  ARCHIVE: "Archive",
  UNREAD: "Unread",
  STARRED: "Starred",
  IMPORTANT: "Important",
  CATEGORY_PERSONAL: "Personal",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
  CHAT: "Chat",
};

export const SYSTEM_LABEL_ORDER = Object.keys(SYSTEM_LABEL_NAMES);

/**
 * A system folder's name as the sidebar shows it, in the mailbox's own words:
 * Gmail's Starred is Outlook's and IMAP's Flagged; Spam is Junk.
 */
export function folderName(labelId: string, capabilities: MailCapabilities): string | undefined {
  if (labelId === "STARRED") return capabilities.stars ? "Starred" : "Flagged";
  if (labelId === "SPAM") return "Junk";
  if (labelId === ALL_MAIL_LABEL_ID) return "All Mail";
  return SYSTEM_LABEL_NAMES[labelId];
}

export function labelDisplayName(label: GmailLabel): string {
  if (label.type === "system") {
    return SYSTEM_LABEL_NAMES[label.id] ?? label.name;
  }
  return label.name;
}
