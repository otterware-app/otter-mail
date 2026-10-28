import type { MailCapabilities } from "@otter-mail/contracts";
import type { GmailLabel } from "./types";

/**
 * What archiving takes off a conversation carrying `labelIds`, from the list
 * it's in (`listLabel`; none for a view or a search): INBOX, as in Gmail; and
 * where the Archive is a folder of its own (Outlook, IMAP), the user's folder
 * it's listed in, as their own apps archive from any folder. Null when there's
 * nothing to archive (it's in the Archive, Sent, …): the action is Move to Inbox.
 */
export function archiveFrom(
  labelIds: readonly string[],
  listLabel: GmailLabel | undefined,
  capabilities: MailCapabilities,
): string | null {
  if (
    capabilities.archiveFolder &&
    listLabel?.type === "user" &&
    !listLabel.id.startsWith("category:") &&
    labelIds.includes(listLabel.id)
  ) {
    return listLabel.id;
  }
  return labelIds.includes("INBOX") ? "INBOX" : null;
}
