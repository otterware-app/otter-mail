/**
 * Mailboxes and where their mail comes from, shared by core, the renderer,
 * the relay and (mirrored in Swift) the iPhone app.
 *
 * A mailbox is reached through a provider. Gmail signs in with Google and
 * talks to the Gmail API, with changes pushed through the relay. IMAP works
 * with any IMAP server, sends over SMTP and watches for new mail with IDLE.
 * Outlook (Microsoft 365, outlook.com) signs in with Microsoft and talks to
 * Microsoft Graph, with changes pushed through the relay like Gmail's.
 * Everything above the provider (the cache, lists, the UI) sees mail the same
 * way: messages carrying labels. For IMAP, a label is a folder; for Outlook,
 * a category or a folder (docs/outlook.md).
 */

export type MailProviderKind = "gmail" | "imap" | "outlook";

/** A mail server: TLS from the start ("tls", ports 993/465), or upgraded with STARTTLS (143/587). */
export interface MailServer {
  host: string;
  port: number;
  security: "tls" | "starttls";
}

/**
 * Where an IMAP mailbox lives. It follows the Otter account to every device;
 * the password never does. Each device asks for it once and keeps it in its
 * own secret store.
 */
export interface ImapSettings {
  /** The login, usually the address itself. */
  username: string;
  imap: MailServer;
  smtp: MailServer;
}

/**
 * What a mailbox can do beyond reading, organizing and sending mail. The UI
 * hides what a mailbox's provider can't do (never checks the provider itself).
 */
export interface MailCapabilities {
  /** Gmail's sorting of the inbox: categories (Promotions, Social, …) and Important. */
  categories: boolean;
  /** A message can carry several labels at once (Gmail); IMAP mail sits in one folder. */
  multipleLabels: boolean;
  /** Exclusive folders alongside colored category tags (Outlook). */
  foldersAndCategories?: boolean;
  /**
   * Archive is a folder of its own (Outlook, IMAP): archived mail carries
   * ARCHIVE. Without it (Gmail), archived mail just lacks INBOX: it's in All Mail.
   */
  archiveFolder?: boolean;
  /** Gmail's stars: STARRED is the Starred folder. Without it (Outlook, IMAP), it's their Flagged. */
  stars?: boolean;
  /** Label colors, kept by the server. */
  labelColors: boolean;
  /** Signatures kept by the server (Gmail's settings) rather than on this device. */
  serverSignatures: boolean;
  /** Invitations answered in the calendar (Google Calendar, Outlook's) rather than by email reply. */
  calendar: boolean;
  /** New mail arrives by push through the relay (Gmail, Outlook); otherwise the device watches itself. */
  relayPush: boolean;
}

export const GMAIL_CAPABILITIES: MailCapabilities = {
  stars: true,
  categories: true,
  multipleLabels: true,
  labelColors: true,
  serverSignatures: true,
  calendar: true,
  relayPush: true,
};

/**
 * Outlook: categories are its labels (several per message, colored), folders
 * move mail; signatures stay on the device (Graph doesn't expose Outlook's).
 */
export const OUTLOOK_CAPABILITIES: MailCapabilities = {
  foldersAndCategories: true,
  archiveFolder: true,
  categories: false,
  multipleLabels: true,
  labelColors: true,
  serverSignatures: false,
  calendar: true,
  relayPush: true,
};

export const IMAP_CAPABILITIES: MailCapabilities = {
  archiveFolder: true,
  categories: false,
  multipleLabels: false,
  labelColors: false,
  serverSignatures: false,
  calendar: false,
  relayPush: false,
};

/** The label of the Archive folder (`capabilities.archiveFolder`); Gmail has none. */
export const ARCHIVE_LABEL_ID = "ARCHIVE";

/** Outlook's Scheduled folder, where its Snooze keeps mail until it's due. */
export const SNOOZED_LABEL_ID = "SNOOZED";

/** Labels that say how a message is rather than where it is: flags, and Outlook's categories. */
const isFolderLabel = (id: string) =>
  !["UNREAD", "STARRED", "IMPORTANT"].includes(id) && !id.startsWith("category:");

/** Folders mail leaves for the Archive: the inbox and the user's own (not Sent, Junk, …). */
const archivesFrom = (id: string) =>
  isFolderLabel(id) &&
  !["SENT", "DRAFT", "SPAM", "TRASH", ARCHIVE_LABEL_ID, SNOOZED_LABEL_ID].includes(id);

/** How a change lands: where Archive is a folder, and whether a conversation's change. */
export type Landing = { archiveFolder?: boolean; thread?: boolean };

/**
 * A label change as it lands on a message carrying `labelIds`. Where Archive
 * is a folder (`archiveFolder`), a message sits in one folder, as the servers
 * have it (outlook/writes.ts, imap/writes.ts): taken out of the inbox or one
 * of the user's folders into none, it lands in the Archive; put in another
 * folder, it leaves it; and a conversation's own mail (Sent, Drafts) stays put
 * when the conversation moves anywhere but Trash. The cache and the lists
 * show that before the server answers. Elsewhere (Gmail) a change lands as it is.
 */
export function landLabelChange(
  labelIds: readonly string[],
  add: readonly string[],
  remove: readonly string[],
  { archiveFolder, thread }: Landing = {},
): { add: string[]; remove: string[] } {
  const change = { add: [...add], remove: [...remove] };
  if (!archiveFolder) return change;
  if (add.some((id) => id !== ARCHIVE_LABEL_ID && isFolderLabel(id))) {
    if (
      thread &&
      !add.includes("TRASH") &&
      labelIds.some((id) => id === "SENT" || id === "DRAFT")
    ) {
      change.add = change.add.filter((id) => !isFolderLabel(id));
    } else if (!change.remove.includes(ARCHIVE_LABEL_ID)) {
      change.remove.push(ARCHIVE_LABEL_ID);
    }
    return change;
  }
  const left = labelIds.filter((id) => !remove.includes(id));
  if (
    remove.some((id) => labelIds.includes(id) && archivesFrom(id)) &&
    ![...left, ...add].some(isFolderLabel)
  ) {
    change.add.push(ARCHIVE_LABEL_ID);
  }
  return change;
}

/** Actions saved on this device; executed by its mail backend while running. */
export type MailSchedule = {
  id: string;
  accountId: string;
  kind: "send" | "snooze";
  dueAt: number;
  state: "pending" | "running" | "failed";
  subject: string;
  threadId: string | null;
  error: string | null;
};
