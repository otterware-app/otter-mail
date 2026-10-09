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
  categories: false,
  multipleLabels: true,
  labelColors: true,
  serverSignatures: false,
  calendar: true,
  relayPush: true,
};

export const IMAP_CAPABILITIES: MailCapabilities = {
  categories: false,
  multipleLabels: false,
  labelColors: false,
  serverSignatures: false,
  calendar: false,
  relayPush: false,
};

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
