/**
 * Shared mail types — used by backend services/handlers. They are shaped like
 * Gmail's (labels, threads) for every provider: see contracts' mail.ts.
 * The frontend duplicates these; keep names exact.
 */

import type { ImapSettings, MailCapabilities, MailProviderKind } from "@otter-mail/contracts";

export interface GmailAccount {
  id: string;
  email: string;
  name: string;
  /** Absent in accounts stored before IMAP: Gmail. */
  provider?: MailProviderKind;
  /** Where an IMAP mailbox lives; its password is in the platform's secrets. */
  imap?: ImapSettings;
  /** What the mailbox can do; set by gmail:listAccounts, never stored. */
  capabilities?: MailCapabilities;
  picture?: string;
  /** User-set override for the Google profile name, edited in Settings. */
  displayName?: string;
  /** User-set accent color (hex) for this account, edited in Settings. */
  color?: string;
  /** Rich-text HTML signature appended to new/reply/forward compose bodies: Gmail's, cached. */
  signature?: string;
  /** The signature has been read from (or moved to) Gmail, which now has the last word. */
  signatureInGmail?: boolean;
  /** No usable Google sign-in; set by gmail:listAccounts, never stored. */
  signedOut?: boolean;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  unread?: number;
  total?: number;
  color?: { backgroundColor: string; textColor: string };
}

export interface GmailMessageSummary {
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
}

export interface GmailMessageDetail extends GmailMessageSummary {
  /** Provider revision of this cached draft body (Outlook keeps its message ID). */
  draftRevision?: string;
  bodyHtml: string | null;
  bodyText: string | null;
  cc?: string;
  /** Only present on your own drafts/sent mail (Gmail echoes the header back). */
  bcc?: string;
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }[];
}

/** An outgoing attachment for compose/forward — base64 is standard (not url-safe). */
export interface ComposeAttachment {
  name: string;
  mimeType: string;
  size: number;
  base64: string;
}

/** A recipient-autocomplete suggestion derived from the local mail cache. */
export interface ContactSuggestion {
  name: string;
  email: string;
}

/** Per-account local-sync progress, exposed to the renderer for status UI. */
/** Pseudo label id for "All Mail": every message except Spam and Trash
    (Gmail has no such label — archived mail simply lacks INBOX). Outlook's
    and IMAP's archived mail is in a folder of its own: ARCHIVE. */
export const ALL_MAIL_LABEL_ID = "ALL_MAIL";

export interface SyncStatus {
  accountId: string;
  /** The sync lane (history delta / full sync / labels) is running. */
  syncing: boolean;
  phase: "idle" | "labels" | "full" | "incremental";
  /** Messages written to the local store during the current/last run. */
  synced: number;
  /** Best-effort mailbox size estimate (from Gmail), or null if unknown. */
  total: number | null;
  lastSyncAt: number | null;
  fullSyncDone: boolean;
  /** Why the last sync run failed (readable), or null. */
  error: string | null;
  /** Sync can't go on until the user signs in to the mailbox again (or enters its password). */
  signInNeeded: boolean;
  /** Offline body download pass in progress (runs apart from `syncing`). */
  download: { done: number; total: number } | null;
  /** Bumped whenever sync changed what lists show; refetch when it moves. */
  revision: number;
}

/**
 * One account's filter within a Combined-mailbox view. A message matches when
 * it belongs to the account, carries every label in `allOf` (empty = any mail
 * from the account), and carries none of the labels in `noneOf`.
 */
export interface ViewRule {
  accountId: string;
  allOf: string[];
  noneOf: string[];
}

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

/** A Combined-mailbox view. null rules = the dynamic built-in default. */
export interface MailView {
  id: string;
  name: string;
  kind: ViewKind;
  rules: ViewRule[] | null;
  /** Where it was made: an account id, or "__combined__" (views were once each mailbox's). */
  mailbox?: string;
  /** Its mark in the rail: an icon's key or an emoji (custom views; absent = its initial). */
  icon?: string | null;
  /** The icon's color (or the initial's). */
  color?: string | null;
}
