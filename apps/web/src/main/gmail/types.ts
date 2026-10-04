import type { ImapSettings, MailCapabilities, MailProviderKind } from "@otter-mail/contracts";

export type GmailAccount = {
  id: string;
  email: string;
  name: string;
  /** Absent in accounts stored before IMAP: Gmail. */
  provider?: MailProviderKind;
  /** Where an IMAP mailbox lives (it signs in with a password). */
  imap?: ImapSettings;
  /** What the mailbox can do; gate UI on these, never on `provider`. */
  capabilities?: MailCapabilities;
  picture?: string;
  /** User-set override for the Google profile name, edited in Settings. */
  displayName?: string;
  /** User-set accent color (hex) for this account, edited in Settings. */
  color?: string;
  /** Rich-text HTML signature appended to new/reply/forward compose bodies. */
  signature?: string;
  /** False while the signature is kept only here: this sign-in may not save it in Gmail. */
  signatureInGmail?: boolean;
  /** No usable sign-in (Google, or the IMAP password on this device): sign in again. */
  signedOut?: boolean;
};

export type GmailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  unread?: number;
  total?: number;
  color?: { backgroundColor: string; textColor: string };
};

export type GmailMessageSummary = {
  id: string;
  /** Owning account — populated on reads so combined (cross-account) views can route. */
  accountId?: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  starred: boolean;
  labelIds: string[];
  hasAttachments: boolean;
  /** Thread rollups — set on threaded list reads (one representative row per thread). */
  threadCount?: number;
  threadUnread?: boolean;
  threadStarred?: boolean;
  /** Union of every message's labels in the thread (list rows are threads:
   *  a thread is "in the Inbox" or "labelled X" if any of its messages is). */
  threadLabelIds?: string[];
  /** RFC 2822 reply headers — captured on Gmail fetches and persisted, never returned by store reads. */
  messageIdHeader?: string;
  referencesHeader?: string;
};

/** An outgoing attachment for compose/forward — base64 is standard (not url-safe). */
export type ComposeAttachment = {
  /** Identity while editing, independent of its position in the attachment list. */
  key?: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
};

/** A recipient-autocomplete suggestion derived from the local mail cache. */
export type ContactSuggestion = {
  name: string;
  email: string;
};

export type GmailMessageDetail = GmailMessageSummary & {
  bodyHtml: string | null;
  bodyText: string | null;
  cc?: string;
  bcc?: string;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    /** Content-ID (no angle brackets) — inline images reference it as `cid:…`. */
    contentId?: string;
  }[];
};

/** One picked label, scoped to a specific account (per-account, by exact id). */
export type LabelSelection = {
  accountId: string;
  labelId: string;
};

export type ViewKind =
  | "inbox"
  | "starred"
  | "sent"
  | "drafts"
  | "important"
  | "allmail"
  | "junk"
  | "trash"
  | "custom";

/**
 * One account's filter within a Combined-mailbox view. A message matches when
 * it belongs to the account, carries every label in `allOf` (empty = any mail
 * from the account), and carries none of the labels in `noneOf`.
 */
export type ViewRule = {
  accountId: string;
  allOf: string[];
  noneOf: string[];
};

/**
 * A Combined-mailbox view: the union of messages matching any of its per-account
 * `rules`. Built-in "inbox"/"sent" views use dynamic defaults when `rules` is
 * null (every account's INBOX/SENT) and can be reset back to it.
 */
export type MailView = {
  id: string;
  name: string;
  kind: ViewKind;
  /** null = use the dynamic default for this kind (only for inbox/sent). */
  rules: ViewRule[] | null;
  /** Where it was made: an account id, or "__combined__" (views were once each mailbox's). */
  mailbox?: string;
  /** Its mark in the rail: an icon's key or an emoji (custom views; absent = its initial). */
  icon?: string | null;
  /** The icon's color (or the initial's). */
  color?: string | null;
};

/** Per-account local-sync progress, exposed to the renderer for status UI. */
export type SyncStatus = {
  accountId: string;
  /** The sync lane (history delta / full sync / labels) is running. */
  syncing: boolean;
  phase: "idle" | "labels" | "full" | "incremental";
  synced: number;
  total: number | null;
  lastSyncAt: number | null;
  fullSyncDone: boolean;
  error: string | null;
  /** Offline body download pass in progress (runs apart from `syncing`). */
  download: { done: number; total: number } | null;
  /** Bumped whenever sync changed what lists show; refetch when it moves. */
  revision: number;
};
