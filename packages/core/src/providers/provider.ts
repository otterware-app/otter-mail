/**
 * Where a mailbox's mail comes from. Handlers and the sync engine talk to a
 * MailProvider, never to Gmail, IMAP or Outlook themselves; everything above it (the
 * cache, lists, the UI) sees mail the same way: messages carrying labels
 * (contracts' mail.ts, docs/imap.md).
 *
 * Members only some providers have are optional; the UI gates on
 * `capabilities`, never on the provider.
 */

import type { MailCapabilities, MailProviderKind } from "@otter-mail/contracts";

import type {
  ComposeAttachment,
  GmailLabel,
  GmailMessageDetail,
  GmailMessageSummary,
  SyncStatus,
} from "../types.js";

/** What a provider's sync run may do to the sync engine (mail-sync.ts). */
export interface SyncContext {
  /** Updates the account's sync status (phase, progress). */
  update(patch: Partial<SyncStatus>): void;
  /** The cache changed in a way lists show: the renderer refetches. */
  bumpRevision(): void;
  /** Throws a SyncCancelled once the account was removed; call before every cache write. */
  assertActive(): void;
  /** Mail that arrived since the last run, to notify about. */
  newMail(messages: GmailMessageSummary[]): Promise<void>;
}

/**
 * Background work, most urgent first; all of it waits behind the user's own
 * requests. `sync` keeps the mailbox current (new mail), `backfill` fills or
 * re-reads the whole mailbox beside it, `prefetch` downloads bodies for
 * offline reading.
 */
export type Lane = "sync" | "backfill" | "prefetch";

/** The account was removed while its sync ran: the run ends without writing. */
export class SyncCancelled extends Error {
  constructor(accountId: string) {
    super(`sync cancelled: ${accountId} was removed`);
  }
}

/** The sign-in may not use the calendar: invitations are answered by email instead. */
export class NoCalendarAccess extends Error {}

export type LabelChange = { addLabelIds?: string[]; removeLabelIds?: string[] };

export type OutgoingMail = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** When present, sent as multipart/alternative (text + html). */
  bodyHtml?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: ComposeAttachment[];
};

export type DraftSave = Omit<OutgoingMail, "inReplyTo" | "references"> & { draftId?: string };

export type RsvpResponse = "accepted" | "declined" | "tentative";

/** An event in a mailbox's calendar, the same whatever calendar it is. */
export type CalendarEvent = {
  id: string;
  title: string;
  /** ISO: a date-time with its offset, or a date for all-day events. */
  start: string;
  /** For all-day events, the day after the last one. */
  end: string;
  allDay: boolean;
  location: string | null;
  description: string | null;
  status: "confirmed" | "tentative" | "cancelled";
  organizer: string | null;
  attendees: { email: string; name?: string; response: RsvpResponse | "needsAction" }[];
  /** Your answer, when you're invited. */
  response: RsvpResponse | "needsAction" | null;
  /** The video call's link. */
  meetingLink: string | null;
  htmlLink: string | null;
  recurring: boolean;
};

/** What a new event is, or what changes in one (then every field is optional). */
export type EventInput = {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  /** IANA time zone for the times; default: this device's. */
  timeZone?: string;
  location?: string;
  description?: string;
  /** Every attendee's address (replaces the list). */
  attendees?: string[];
  /** Adds a video call (Google Meet). */
  videoCall?: boolean;
};

export type ErrorKind = "rateLimit" | "network" | "notFound";

export interface MailProvider {
  readonly kind: MailProviderKind;
  readonly capabilities: MailCapabilities;

  // ── Sign-in ──────────────────────────────────────────────────────────────
  /** Whether this device can reach the mailbox (Gmail: a Google sign-in; IMAP: a password; Outlook: Microsoft's). */
  isSignedIn(accountId: string): boolean;
  /** What the status line says while it can't. */
  readonly signedOutMessage: string;
  /** Drops this device's sign-in and in-memory state for a removed account. */
  removeAccount(accountId: string): Promise<void>;

  // ── Sync ─────────────────────────────────────────────────────────────────
  /**
   * The provider's part of one sync run: bring the cached labels and mail up
   * to date (Gmail: labels, full sync or the history delta, draft ids). The
   * engine around it (mail-sync.ts) handles status, backoff, removal, timers,
   * push and offline downloads.
   */
  sync(accountId: string, ctx: SyncContext): Promise<void>;
  /**
   * Whether there's long work to do on the whole mailbox (Gmail: the first
   * sync, or re-reading it after the history feed expired). The engine runs
   * `backfill` for it in its own lane, so syncs keep bringing new mail.
   */
  needsBackfill?(accountId: string): boolean;
  /** Does that work; resolves once there's none left. Safe to stop and run again. */
  backfill?(accountId: string, ctx: SyncContext): Promise<void>;
  /** Runs background work behind the user's own requests (and behind more urgent lanes). */
  background<T>(lane: Lane, fn: () => Promise<T>): Promise<T>;
  /** The server asked to slow down: offline downloads wait. */
  isCoolingDown?(accountId: string): boolean;
  /** What kind of failure an error is, for the engine to decide what to retry. */
  errorKind(err: unknown): ErrorKind | null;
  /** A short, readable reason for the status line. */
  describeError(err: unknown): string;

  // ── Live mail ────────────────────────────────────────────────────────────
  /**
   * With `capabilities.relayPush`: asks the server to publish the mailbox's
   * changes to the relay's Pub/Sub `topic` (renewed as needed); the relay's
   * event stream then triggers syncs. Resolves whether it's publishing.
   */
  watchViaRelay?(accountId: string, topic: string): Promise<boolean>;
  /** Otherwise the device watches itself (IMAP IDLE): `onChange` on news; returns a stop. */
  watch?(accountId: string, onChange: () => void): () => void;

  // ── Reads ────────────────────────────────────────────────────────────────
  listLabels(accountId: string): Promise<GmailLabel[]>;
  /** Summaries (labels, headers, snippet) for messages; ids gone from the server are left out. */
  getSummaries(accountId: string, messageIds: string[]): Promise<GmailMessageSummary[]>;
  /** The whole message: bodies and the attachment list. */
  getMessage(accountId: string, messageId: string): Promise<GmailMessageDetail>;
  /** Every message of a thread, whole, where one request is cheaper than one per message. */
  getThread?(accountId: string, threadId: string): Promise<GmailMessageDetail[]>;
  fetchAttachment(accountId: string, messageId: string, attachmentId: string): Promise<Uint8Array>;
  /** Message-ID and References, for replying to a message cached without them. */
  getReplyHeaders(
    accountId: string,
    messageId: string,
  ): Promise<{ messageIdHeader: string | null; referencesHeader: string | null }>;
  getUnsubscribeHeaders(
    accountId: string,
    messageId: string,
  ): Promise<{ listUnsubscribe: string; oneClick: boolean }>;
  /**
   * One page of message ids from the server, newest first, with every label
   * in `labelIds` (none: all mail). Lets lists page past the cache while the
   * first sync is still filling it. Spam and Trash count unless `spamTrash` is false.
   */
  listIds?(
    accountId: string,
    params: { labelIds?: string[]; pageToken?: string; maxResults?: number; spamTrash?: boolean },
  ): Promise<{ ids: string[]; nextPageToken?: string }>;
  /** The server's own search (Gmail's operators). Without it, search reads the local index. */
  search?(
    accountId: string,
    q: string,
    pageToken: string | undefined,
    maxResults: number,
  ): Promise<{
    refs: { id: string; threadId: string }[];
    nextPageToken?: string;
    resultSizeEstimate: number;
  }>;

  // ── Writes ───────────────────────────────────────────────────────────────
  /** Adds and removes labels (IMAP: a folder label moves the message). */
  modifyMessage(accountId: string, messageId: string, change: LabelChange): Promise<void>;
  modifyThread(accountId: string, threadId: string, change: LabelChange): Promise<void>;
  trashMessage(accountId: string, messageId: string): Promise<void>;
  trashThread(accountId: string, threadId: string): Promise<void>;
  /** Restores trashed mail; answers fresh summaries of what came back. */
  untrashMessage(accountId: string, messageId: string): Promise<GmailMessageSummary[]>;
  untrashThread(accountId: string, threadId: string): Promise<GmailMessageSummary[]>;
  /** PERMANENT. */
  deleteForever(accountId: string, messageIds: string[]): Promise<void>;
  /** PERMANENTLY empties Junk or Trash, `cachedIds` included; answers every id deleted. */
  emptyFolder(accountId: string, labelId: "SPAM" | "TRASH", cachedIds: string[]): Promise<string[]>;

  createLabel(accountId: string, name: string): Promise<GmailLabel>;
  /** Renames (nested labels follow) and/or recolors a label. */
  updateLabel(
    accountId: string,
    params: {
      labelId: string;
      name?: string;
      color?: { backgroundColor: string; textColor: string };
    },
  ): Promise<void>;
  deleteLabel(accountId: string, labelId: string): Promise<void>;

  send(accountId: string, mail: OutgoingMail): Promise<{ messageId?: string }>;
  /** Sends a ready-made RFC 822 message (unsubscribe mail, invitation replies). */
  sendRaw(accountId: string, raw: string, threadId?: string): Promise<void>;

  /** Creates or updates a draft; every save may mint a new message id. */
  saveDraft(
    accountId: string,
    draft: DraftSave,
  ): Promise<{ draftId: string; messageId?: string; threadId?: string }>;
  /** Deletes a draft; answers the message that backed it, for the cache. */
  deleteDraft(accountId: string, draftId: string): Promise<{ messageId?: string }>;
  /** The message backing a draft right now; null once it's gone (sent or deleted elsewhere). */
  getDraftVersion(accountId: string, draftId: string): Promise<string | null>;
  /** The draft owning a message (else one in the same thread), or null. */
  findDraftId(accountId: string, messageId: string, threadId?: string): Promise<string | null>;

  /** The mailbox's name and picture as its provider has them now (Gmail's come from Google's userinfo). */
  readProfile?(accountId: string): Promise<{ name?: string; picture?: string }>;

  /** Signatures the server keeps (`capabilities.serverSignatures`), one per address. */
  signatures?: {
    get(accountId: string, email: string): Promise<string>;
    /** Saves it; answers it as the server stored it. */
    set(accountId: string, email: string, html: string): Promise<string>;
  };

  /**
   * The account's calendar (`capabilities.calendar`): invitations answered in
   * place, and its events for the agents' tools. Every call throws
   * NoCalendarAccess when the sign-in may not use it. `notify` tells attendees.
   */
  calendar?: {
    /** The invitation's event: your answer and a link to it; null when it isn't there. */
    findEvent(
      accountId: string,
      uid: string,
    ): Promise<{ response: RsvpResponse | "needsAction"; htmlLink: string | null } | null>;
    /** Answers it (the organizer is notified); false when the event isn't there. */
    respond(accountId: string, uid: string, response: RsvpResponse): Promise<boolean>;
    /** Events overlapping `from`–`to` (ISO), soonest first; recurring ones as occurrences. */
    listEvents(
      accountId: string,
      range: { from: string; to: string; query?: string; limit: number },
    ): Promise<CalendarEvent[]>;
    getEvent(accountId: string, eventId: string): Promise<CalendarEvent>;
    createEvent(accountId: string, input: EventInput, notify: boolean): Promise<CalendarEvent>;
    updateEvent(
      accountId: string,
      eventId: string,
      patch: EventInput,
      notify: boolean,
    ): Promise<CalendarEvent>;
    deleteEvent(accountId: string, eventId: string, notify: boolean): Promise<void>;
    respondToEvent(
      accountId: string,
      eventId: string,
      response: RsvpResponse,
    ): Promise<CalendarEvent>;
  };
}
