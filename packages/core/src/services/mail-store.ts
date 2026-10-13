/**
 * mail-store.ts
 *
 * Local-first mail cache backed by the built-in `node:sqlite` module
 * (Node 24+, ships with Electron — no native bindings to bundle).
 *
 * Stores message metadata, lazily-fetched full bodies, labels, and a
 * per-account sync cursor so the UI renders instantly from disk and Gmail
 * is only hit to refresh in the background.
 *
 * DB file: userData/mail-cache.db
 */

import { platform, type SqlDatabase } from "../platform.js";
import { ALL_MAIL_LABEL_ID } from "../types.js";
import { withPendingLabels } from "./pending-label-writes.js";
import type {
  GmailLabel,
  GmailMessageSummary,
  GmailMessageDetail,
  ViewRule,
  ContactSuggestion,
} from "../types.js";

// ── DB bootstrap ────────────────────────────────────────────────────────────

let db: SqlDatabase | null = null;

function getDb(): SqlDatabase {
  if (db) return db;

  const handle = platform().database();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      accountId      TEXT NOT NULL,
      id             TEXT NOT NULL,
      threadId       TEXT NOT NULL DEFAULT '',
      fromName       TEXT NOT NULL DEFAULT '',
      fromEmail      TEXT NOT NULL DEFAULT '',
      toField        TEXT NOT NULL DEFAULT '',
      subject        TEXT NOT NULL DEFAULT '',
      snippet        TEXT NOT NULL DEFAULT '',
      date           INTEGER NOT NULL DEFAULT 0,
      unread         INTEGER NOT NULL DEFAULT 0,
      starred        INTEGER NOT NULL DEFAULT 0,
      hasAttachments INTEGER NOT NULL DEFAULT 0,
      labelIds       TEXT NOT NULL DEFAULT '[]',
      cc             TEXT,
      bodyHtml       TEXT,
      bodyText       TEXT,
      attachments    TEXT,
      detailFetched  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (accountId, id)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_account_date ON messages (accountId, date DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_account_thread ON messages (accountId, threadId, date);

    CREATE TABLE IF NOT EXISTS message_labels (
      accountId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      labelId   TEXT NOT NULL,
      PRIMARY KEY (accountId, messageId, labelId)
    );
    CREATE INDEX IF NOT EXISTS idx_mlabels_lookup ON message_labels (accountId, labelId, messageId);

    CREATE TABLE IF NOT EXISTS labels (
      accountId TEXT NOT NULL,
      id        TEXT NOT NULL,
      name      TEXT NOT NULL,
      type      TEXT NOT NULL,
      unread    INTEGER,
      total     INTEGER,
      bgColor   TEXT,
      textColor TEXT,
      PRIMARY KEY (accountId, id)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      accountId    TEXT PRIMARY KEY,
      historyId    TEXT,
      fullSyncDone INTEGER NOT NULL DEFAULT 0,
      lastSyncAt   INTEGER
    );

    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Legacy rows synced before threading behave as single-message threads.
  handle.exec("UPDATE messages SET threadId = id WHERE threadId = '';");

  // Reply-threading headers, added after the initial schema shipped.
  const messageCols = new Set(
    (
      handle.prepare("SELECT name FROM pragma_table_info('messages')").all() as unknown as {
        name: string;
      }[]
    ).map((c) => c.name),
  );
  if (!messageCols.has("messageIdHeader")) {
    handle.exec("ALTER TABLE messages ADD COLUMN messageIdHeader TEXT;");
  }
  if (!messageCols.has("referencesHeader")) {
    handle.exec("ALTER TABLE messages ADD COLUMN referencesHeader TEXT;");
  }
  // Gmail draft id of a DRAFT message (drafts are edited/deleted by draft id).
  if (!messageCols.has("draftId")) {
    handle.exec("ALTER TABLE messages ADD COLUMN draftId TEXT;");
  }
  // Offline body downloads that failed: retried with backoff instead of on
  // every sync (a message Gmail can't serve would otherwise block the queue).
  if (!messageCols.has("bodyAttempts")) {
    handle.exec("ALTER TABLE messages ADD COLUMN bodyAttempts INTEGER NOT NULL DEFAULT 0;");
  }
  if (!messageCols.has("bodyRetryAt")) {
    handle.exec("ALTER TABLE messages ADD COLUMN bodyRetryAt INTEGER NOT NULL DEFAULT 0;");
  }
  if (!messageCols.has("bcc")) {
    handle.exec("ALTER TABLE messages ADD COLUMN bcc TEXT;");
    // Re-read legacy drafts before editing: their cached bodies omitted Bcc.
    handle.exec(`UPDATE messages SET detailFetched = 0 WHERE EXISTS
      (SELECT 1 FROM message_labels l WHERE l.accountId = messages.accountId AND l.messageId = messages.id AND l.labelId = 'DRAFT')`);
  }
  if (!messageCols.has("draftRevision")) {
    handle.exec("ALTER TABLE messages ADD COLUMN draftRevision TEXT;");
    // Older Outlook draft bodies have no revision; reload them once rather
    // than editing a cached body with an unknown remote version.
    handle.exec(`UPDATE messages SET detailFetched = 0
      WHERE EXISTS (SELECT 1 FROM message_labels l WHERE l.accountId = messages.accountId AND l.messageId = messages.id AND l.labelId = 'DRAFT')
        AND EXISTS (SELECT 1 FROM kv WHERE key = 'outlookPeeked:' || messages.accountId)`);
  }
  handle.exec(
    "CREATE INDEX IF NOT EXISTS idx_messages_undownloaded ON messages (accountId, detailFetched, date DESC);",
  );

  // Full-text search: external-content FTS5 over messages, kept in sync via
  // triggers. On first creation, rebuild indexes every already-cached row.
  const ftsExists =
    handle
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
      .get() !== undefined;
  if (!ftsExists) {
    handle.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        subject, fromName, fromEmail, snippet, bodyText,
        content='messages', content_rowid='rowid'
      );
    `);
  }
  handle.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, subject, fromName, fromEmail, snippet, bodyText)
      VALUES (new.rowid, new.subject, new.fromName, new.fromEmail, new.snippet, new.bodyText);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, fromName, fromEmail, snippet, bodyText)
      VALUES ('delete', old.rowid, old.subject, old.fromName, old.fromEmail, old.snippet, old.bodyText);
    END;
    -- Only when the indexed text changed: sync rewrites the same headers all
    -- the time, and re-indexing means re-tokenizing the whole body.
    DROP TRIGGER IF EXISTS messages_fts_au;
    CREATE TRIGGER messages_fts_au
      AFTER UPDATE OF subject, fromName, fromEmail, snippet, bodyText ON messages
      WHEN old.subject IS NOT new.subject OR old.fromName IS NOT new.fromName
        OR old.fromEmail IS NOT new.fromEmail OR old.snippet IS NOT new.snippet
        OR old.bodyText IS NOT new.bodyText
    BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, subject, fromName, fromEmail, snippet, bodyText)
      VALUES ('delete', old.rowid, old.subject, old.fromName, old.fromEmail, old.snippet, old.bodyText);
      INSERT INTO messages_fts(rowid, subject, fromName, fromEmail, snippet, bodyText)
      VALUES (new.rowid, new.subject, new.fromName, new.fromEmail, new.snippet, new.bodyText);
    END;
  `);
  if (!ftsExists) {
    handle.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild');");
  }

  db = handle;
  return handle;
}

// ── Row mapping ───────────────────────────────────────────────────────────────

interface MessageRow {
  accountId: string;
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  toField: string;
  subject: string;
  snippet: string;
  date: number;
  unread: number;
  starred: number;
  hasAttachments: number;
  labelIds: string;
  cc: string | null;
  bcc: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: string | null;
  detailFetched: number;
  draftRevision: string | null;
  messageIdHeader: string | null;
  referencesHeader: string | null;
}

function parseLabelIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function rowToSummary(row: MessageRow): GmailMessageSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    threadId: row.threadId,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    to: row.toField,
    subject: row.subject,
    snippet: row.snippet,
    date: row.date,
    unread: row.unread === 1,
    starred: row.starred === 1,
    labelIds: parseLabelIds(row.labelIds),
    hasAttachments: row.hasAttachments === 1,
  };
}

interface ThreadRow extends MessageRow {
  threadCount: number;
  threadUnread: number;
  threadStarred: number;
  /** Comma-joined union of every message's labels in the thread. */
  threadLabels: string | null;
}

function rowToThreadSummary(row: ThreadRow): GmailMessageSummary {
  return {
    ...rowToSummary(row),
    threadCount: row.threadCount,
    threadUnread: row.threadUnread === 1,
    threadStarred: row.threadStarred === 1,
    threadLabelIds: row.threadLabels ? row.threadLabels.split(",") : [],
  };
}

function rowToDetail(row: MessageRow): GmailMessageDetail {
  let attachments: GmailMessageDetail["attachments"] = [];
  if (row.attachments) {
    try {
      attachments = JSON.parse(row.attachments) as GmailMessageDetail["attachments"];
    } catch {
      attachments = [];
    }
  }
  return {
    ...rowToSummary(row),
    cc: row.cc ?? undefined,
    bcc: row.bcc ?? undefined,
    draftRevision: row.draftRevision ?? undefined,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    attachments,
  };
}

// ── Messages: writes ────────────────────────────────────────────────────────

export function upsertMessages(accountId: string, fetched: GmailMessageSummary[]): void {
  if (fetched.length === 0) return;
  inTransaction(() => writeSummaries(accountId, fetched));
}

/** Runs `fn` in one transaction: one commit (and one WAL sync) for many rows. */
function inTransaction(fn: () => void): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    fn();
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

function writeSummaries(accountId: string, fetched: GmailMessageSummary[]): void {
  // Gmail may not have caught up with changes made here moments ago; keep them.
  const messages = withPendingLabels(accountId, fetched);
  const d = getDb();

  // hasAttachments from a list response is always false; never clobber a `true`
  // already established by a full-message fetch.
  const upsert = d.prepare(`
    INSERT INTO messages
      (accountId, id, threadId, fromName, fromEmail, toField, subject, snippet, date, unread, starred, hasAttachments, labelIds, messageIdHeader, referencesHeader)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(accountId, id) DO UPDATE SET
      threadId       = excluded.threadId,
      fromName       = excluded.fromName,
      fromEmail      = excluded.fromEmail,
      toField        = excluded.toField,
      subject        = excluded.subject,
      snippet        = excluded.snippet,
      date           = excluded.date,
      unread         = excluded.unread,
      starred        = excluded.starred,
      labelIds       = excluded.labelIds,
      hasAttachments = CASE WHEN excluded.hasAttachments = 1 THEN 1 ELSE messages.hasAttachments END,
      messageIdHeader  = COALESCE(excluded.messageIdHeader, messages.messageIdHeader),
      referencesHeader = COALESCE(excluded.referencesHeader, messages.referencesHeader)
  `);
  const delLabels = d.prepare("DELETE FROM message_labels WHERE accountId = ? AND messageId = ?");
  const insLabel = d.prepare(
    "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
  );

  for (const m of messages) {
    upsert.run(
      accountId,
      m.id,
      m.threadId || m.id,
      m.fromName,
      m.fromEmail,
      m.to,
      m.subject,
      m.snippet,
      m.date,
      m.unread ? 1 : 0,
      m.starred ? 1 : 0,
      m.hasAttachments ? 1 : 0,
      JSON.stringify(m.labelIds),
      m.messageIdHeader ?? null,
      m.referencesHeader ?? null,
    );
    delLabels.run(accountId, m.id);
    for (const lid of m.labelIds) insLabel.run(accountId, m.id, lid);
  }
}

export function upsertMessageDetail(accountId: string, detail: GmailMessageDetail): void {
  upsertMessageDetails(accountId, [detail]);
}

/** Whole messages (metadata, labels, bodies, attachments), in one transaction. */
export function upsertMessageDetails(accountId: string, details: GmailMessageDetail[]): void {
  if (details.length === 0) return;
  const setBody = getDb().prepare(`
    UPDATE messages
       SET cc = ?, bcc = ?, bodyHtml = ?, bodyText = ?, attachments = ?, hasAttachments = ?, draftRevision = ?, detailFetched = 1
     WHERE accountId = ? AND id = ?
  `);
  inTransaction(() => {
    // Metadata + labels first, then the body/attachments on the same row.
    writeSummaries(accountId, details);
    for (const detail of details) {
      setBody.run(
        detail.cc ?? null,
        detail.bcc ?? null,
        detail.bodyHtml,
        detail.bodyText,
        JSON.stringify(detail.attachments),
        detail.hasAttachments ? 1 : 0,
        detail.draftRevision ?? null,
        accountId,
        detail.id,
      );
    }
  });
}

/** Recounts the given labels' total/unread from the local cache. */
export function recountLabels(accountId: string, labelIds: string[]): void {
  recomputeLabelCounts(accountId, [...new Set(labelIds)]);
}

/**
 * Recomputes and persists `labels.unread`/`total` for the given label ids from
 * the local message cache. This is the only place besides a Gmail label sync
 * (`upsertLabels`) that writes those counters — without it, a local mutation
 * (mark read/unread, star, archive, trash) updates the message rows but leaves
 * the cached label counters stale until the next full/incremental sync, which
 * is why sidebar/header unread badges could disagree with what the message
 * list actually showed until the app was relaunched.
 */

function recomputeLabelCounts(accountId: string, labelIds: string[]): void {
  if (labelIds.length === 0) return;
  const d = getDb();
  const placeholders = labelIds.map(() => "?").join(", ");
  const rows = d
    .prepare(`
      SELECT ml.labelId AS labelId, COUNT(*) AS total, SUM(m.unread) AS unread
        FROM message_labels ml
        JOIN messages m ON m.accountId = ml.accountId AND m.id = ml.messageId
       WHERE ml.accountId = ? AND ml.labelId IN (${placeholders})
       GROUP BY ml.labelId
    `)
    .all(accountId, ...labelIds) as unknown as {
    labelId: string;
    total: number;
    unread: number | null;
  }[];
  const counts = new Map(rows.map((r) => [r.labelId, { total: r.total, unread: r.unread ?? 0 }]));
  const update = d.prepare(
    "UPDATE labels SET unread = ?, total = ? WHERE accountId = ? AND id = ?",
  );
  for (const labelId of labelIds) {
    const c = counts.get(labelId) ?? { total: 0, unread: 0 };
    update.run(c.unread, c.total, accountId, labelId);
  }
}

/** Draft updates mint a new message id — drop stale local draft rows of the
    same thread so the Drafts view doesn't show duplicates until sync. */
export function deleteOtherDraftsInThread(
  accountId: string,
  threadId: string,
  keepMessageId: string,
): void {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT m.id FROM messages m
        WHERE m.accountId = ? AND m.threadId = ? AND m.id != ?
          AND EXISTS (SELECT 1 FROM message_labels ml
                       WHERE ml.accountId = m.accountId AND ml.messageId = m.id
                         AND ml.labelId = 'DRAFT')`,
    )
    .all(accountId, threadId, keepMessageId) as unknown as { id: string }[];
  for (const row of rows) deleteMessage(accountId, row.id);
}

/** Removes a cached message; returns whether it was cached. */
export function deleteMessage(accountId: string, messageId: string): boolean {
  const d = getDb();
  const existing = d
    .prepare("SELECT labelIds FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as { labelIds: string } | undefined;
  if (!existing) return false;
  const priorLabelIds = parseLabelIds(existing.labelIds);

  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM messages WHERE accountId = ? AND id = ?").run(accountId, messageId);
    d.prepare("DELETE FROM message_labels WHERE accountId = ? AND messageId = ?").run(
      accountId,
      messageId,
    );
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  recomputeLabelCounts(accountId, priorLabelIds);
  return true;
}

/**
 * Re-keys a cached message, body and all, and sets its labels: an IMAP
 * message moved to another folder has a new id. When the new id is cached
 * already (a sync got there first), the old row just goes.
 */
export function renameMessage(
  accountId: string,
  fromId: string,
  toId: string,
  labelIds: string[],
): void {
  const d = getDb();
  const prior = getMessageLabelIds(accountId, fromId);
  if (!prior) return;
  if (getMessageLabelIds(accountId, toId)) {
    deleteMessage(accountId, fromId);
  } else {
    d.exec("BEGIN");
    try {
      d.prepare("UPDATE messages SET id = ? WHERE accountId = ? AND id = ?").run(
        toId,
        accountId,
        fromId,
      );
      d.prepare(
        "UPDATE message_labels SET messageId = ? WHERE accountId = ? AND messageId = ?",
      ).run(toId, accountId, fromId);
      d.exec("COMMIT");
    } catch (err) {
      d.exec("ROLLBACK");
      throw err;
    }
  }
  const current = getMessageLabelIds(accountId, toId) ?? [];
  applyLabelChange(
    accountId,
    toId,
    labelIds.filter((l) => !current.includes(l)),
    current.filter((l) => !labelIds.includes(l)),
  );
  recomputeLabelCounts(accountId, prior);
}

/** Ids of cached messages starting with `prefix` (IMAP: a folder's, by UIDVALIDITY). */
export function getMessageIdsWithPrefix(accountId: string, prefix: string): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM messages WHERE accountId = ? AND id >= ? AND id < ?")
    .all(accountId, prefix, `${prefix}\uffff`) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Apply an optimistic label add/remove to a locally-cached message. */
/** A cached message's current label ids, or null when it isn't cached. */
export function getMessageLabelIds(accountId: string, messageId: string): string[] | null {
  const row = getDb()
    .prepare("SELECT labelIds FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as { labelIds: string } | undefined;
  return row ? parseLabelIds(row.labelIds) : null;
}

export function applyLabelChange(
  accountId: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): void {
  const d = getDb();
  const existing = d
    .prepare("SELECT labelIds FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as { labelIds: string } | undefined;
  if (!existing) return;
  const priorLabelIds = parseLabelIds(existing.labelIds);

  let newLabelIds: string[] = priorLabelIds;
  d.exec("BEGIN");
  try {
    for (const lid of removeLabelIds) {
      d.prepare(
        "DELETE FROM message_labels WHERE accountId = ? AND messageId = ? AND labelId = ?",
      ).run(accountId, messageId, lid);
    }
    for (const lid of addLabelIds) {
      d.prepare(
        "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
      ).run(accountId, messageId, lid);
    }
    const labelRows = d
      .prepare("SELECT labelId FROM message_labels WHERE accountId = ? AND messageId = ?")
      .all(accountId, messageId) as unknown as { labelId: string }[];
    newLabelIds = labelRows.map((r) => r.labelId);
    d.prepare(
      "UPDATE messages SET labelIds = ?, unread = ?, starred = ? WHERE accountId = ? AND id = ?",
    ).run(
      JSON.stringify(newLabelIds),
      newLabelIds.includes("UNREAD") ? 1 : 0,
      newLabelIds.includes("STARRED") ? 1 : 0,
      accountId,
      messageId,
    );
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  recomputeLabelCounts(accountId, [...new Set([...priorLabelIds, ...newLabelIds])]);
}

// ── Messages: reads ───────────────────────────────────────────────────────────

/**
 * One row per thread: `matchedSql` selects the (accountId, threadId) pairs the
 * view includes; rollups (count/unread/starred) and the representative row (the
 * thread's latest message) are computed over EVERY locally-cached message of
 * the thread, so e.g. an Inbox thread counts your sent replies like Gmail does.
 */
function threadPageQuery(matchedSql: string): string {
  return `
    WITH matched AS (${matchedSql}),
    agg AS (
      SELECT t.accountId AS accountId, t.threadId AS threadId,
             COUNT(*) AS threadCount,
             MAX(t.unread) AS threadUnread,
             MAX(t.starred) AS threadStarred,
             MAX(t.date) AS repDate
        FROM messages t
        JOIN matched mt ON mt.accountId = t.accountId AND mt.threadId = t.threadId
       GROUP BY t.accountId, t.threadId
       ORDER BY repDate DESC
       LIMIT ? OFFSET ?
    )
    SELECT m.*, agg.threadCount AS threadCount,
           agg.threadUnread AS threadUnread,
           agg.threadStarred AS threadStarred,
           -- CROSS JOIN pins the order: the thread's messages first (indexed by
           -- thread), then each one's labels by primary key.
           (SELECT GROUP_CONCAT(DISTINCT tl.labelId)
              FROM messages tm
              CROSS JOIN message_labels tl ON tl.accountId = tm.accountId AND tl.messageId = tm.id
             WHERE tm.accountId = agg.accountId AND tm.threadId = agg.threadId) AS threadLabels
      FROM agg
      JOIN messages m
        ON m.accountId = agg.accountId AND m.threadId = agg.threadId AND m.date = agg.repDate
     GROUP BY agg.accountId, agg.threadId
     ORDER BY agg.repDate DESC
  `;
}

const NOT_SPAM_TRASH =
  "NOT EXISTS (SELECT 1 FROM message_labels mlx WHERE mlx.accountId = m.accountId AND mlx.messageId = m.id AND mlx.labelId IN ('SPAM', 'TRASH'))";

export function getThreadsPage(
  accountId: string,
  labelId: string,
  offset: number,
  limit: number,
): { messages: GmailMessageSummary[]; hasMore: boolean } {
  const d = getDb();
  if (labelId === ALL_MAIL_LABEL_ID) {
    const rows = d
      .prepare(
        threadPageQuery(`
          SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId
            FROM messages m
           WHERE m.accountId = ? AND ${NOT_SPAM_TRASH}
        `),
      )
      .all(accountId, limit + 1, offset) as unknown as ThreadRow[];
    return { messages: rows.slice(0, limit).map(rowToThreadSummary), hasMore: rows.length > limit };
  }
  // Gmail semantics: spam/trash stay out of every view except their own.
  const exclusion = labelId === "SPAM" || labelId === "TRASH" ? "" : `AND ${NOT_SPAM_TRASH}`;
  const rows = d
    .prepare(
      threadPageQuery(`
        SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId
          FROM messages m
          JOIN message_labels ml
            ON ml.accountId = m.accountId AND ml.messageId = m.id
         WHERE m.accountId = ? AND ml.labelId = ? ${exclusion}
      `),
    )
    .all(accountId, labelId, limit + 1, offset) as unknown as ThreadRow[];

  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).map(rowToThreadSummary), hasMore };
}

/**
 * Conversation rows for the given threads (Gmail search results), in the
 * order given. Threads with nothing cached are skipped.
 */
export function getThreadSummaries(accountId: string, threadIds: string[]): GmailMessageSummary[] {
  if (threadIds.length === 0) return [];
  const rows = getDb()
    .prepare(
      threadPageQuery(`
        SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId
          FROM messages m
         WHERE m.accountId = ? AND m.threadId IN (SELECT value FROM json_each(?))
      `),
    )
    .all(accountId, JSON.stringify(threadIds), threadIds.length, 0) as unknown as ThreadRow[];
  const byThread = new Map(rows.map((r) => [r.threadId, rowToThreadSummary(r)]));
  return threadIds.flatMap((id) => {
    const row = byThread.get(id);
    return row ? [row] : [];
  });
}

/** All locally-cached messages of a thread, oldest first. */
export function getThreadMessages(accountId: string, threadId: string): GmailMessageSummary[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT * FROM messages WHERE accountId = ? AND threadId = ? ORDER BY date ASC, id ASC",
    )
    .all(accountId, threadId) as unknown as MessageRow[];
  return rows.map(rowToSummary);
}

function getThreadMessageIds(accountId: string, threadId: string): string[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT id FROM messages WHERE accountId = ? AND threadId = ?")
    .all(accountId, threadId) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export function applyLabelChangeToThread(
  accountId: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): void {
  for (const id of getThreadMessageIds(accountId, threadId)) {
    applyLabelChange(accountId, id, addLabelIds, removeLabelIds);
  }
}

export function deleteThread(accountId: string, threadId: string): void {
  for (const id of getThreadMessageIds(accountId, threadId)) {
    deleteMessage(accountId, id);
  }
}

export function getMessageDetail(accountId: string, messageId: string): GmailMessageDetail | null {
  const d = getDb();
  const row = d
    .prepare("SELECT * FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as MessageRow | undefined;
  if (!row || row.detailFetched !== 1) return null;
  return rowToDetail(row);
}

/** The revision paired with a cached draft body and its attachment indexes. */
export function getStoredDraftRevision(accountId: string, id: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT draftRevision FROM messages WHERE accountId = ? AND id = ? AND detailFetched = 1",
    )
    .get(accountId, id) as unknown as { draftRevision: string | null } | undefined;
  return row?.draftRevision ?? null;
}

/** A saved draft's attachment IDs need a fresh detail before it is reopened. */
export function invalidateMessageDetail(accountId: string, id: string): void {
  getDb()
    .prepare("UPDATE messages SET detailFetched = 0 WHERE accountId = ? AND id = ?")
    .run(accountId, id);
}

/** A bounded batch of rows whose headers were erased by an incomplete provider update. */
export function getMessageIdsMissingMetadata(accountId: string): string[] {
  const rows = getDb()
    .prepare(
      "SELECT id FROM messages WHERE accountId = ? AND date = 0 AND subject = '' AND fromEmail = '' AND threadId = id LIMIT 100",
    )
    .all(accountId) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

export function getStoredReplyHeaders(
  accountId: string,
  messageId: string,
): { messageIdHeader: string | null; referencesHeader: string | null } {
  const d = getDb();
  const row = d
    .prepare(
      "SELECT messageIdHeader, referencesHeader FROM messages WHERE accountId = ? AND id = ?",
    )
    .get(accountId, messageId) as unknown as
    | { messageIdHeader: string | null; referencesHeader: string | null }
    | undefined;
  return {
    messageIdHeader: row?.messageIdHeader ?? null,
    referencesHeader: row?.referencesHeader ?? null,
  };
}

export function setReplyHeaders(
  accountId: string,
  messageId: string,
  messageIdHeader: string | null,
  referencesHeader: string | null,
): void {
  getDb()
    .prepare(
      "UPDATE messages SET messageIdHeader = ?, referencesHeader = ? WHERE accountId = ? AND id = ?",
    )
    .run(messageIdHeader, referencesHeader, accountId, messageId);
}

/** Messages whose full body hasn't been downloaded yet, the inbox's first and
    then newest first, skipping ones waiting out a retry backoff. */
export function getUndownloadedMessages(
  accountId: string,
  limit: number,
): { id: string; threadId: string }[] {
  return getDb()
    .prepare(
      `SELECT m.id, m.threadId FROM messages m
        WHERE m.accountId = ? AND m.detailFetched = 0 AND m.bodyRetryAt <= ?
        ORDER BY EXISTS (
          SELECT 1 FROM message_labels ml
           WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'INBOX'
        ) DESC, m.date DESC
        LIMIT ?`,
    )
    .all(accountId, Date.now(), limit) as unknown as { id: string; threadId: string }[];
}

/** Messages still missing a body that are due for download. */
export function countUndownloaded(accountId: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE accountId = ? AND detailFetched = 0 AND bodyRetryAt <= ?",
    )
    .get(accountId, Date.now()) as unknown as { n: number };
  return row?.n ?? 0;
}

const BODY_RETRY_BASE_MS = 10 * 60_000;
const BODY_RETRY_MAX_MS = 24 * 60 * 60_000;

/** Backs off a body download that failed: 10 min, 20 min, … up to a day. */
export function markBodyFetchFailed(accountId: string, messageId: string): void {
  const row = getDb()
    .prepare("SELECT bodyAttempts FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as { bodyAttempts: number } | undefined;
  if (!row) return;
  const delay = Math.min(BODY_RETRY_BASE_MS * 2 ** row.bodyAttempts, BODY_RETRY_MAX_MS);
  getDb()
    .prepare(
      "UPDATE messages SET bodyAttempts = bodyAttempts + 1, bodyRetryAt = ? WHERE accountId = ? AND id = ?",
    )
    .run(Date.now() + delay, accountId, messageId);
}

/** One history-feed change, applied in feed order (a message can be marked
    read and unread again within one delta). */
export type HistoryOp =
  | { kind: "labelsAdded" | "labelsRemoved"; id: string; labelIds: string[] }
  | { kind: "deleted"; id: string };

/**
 * Applies one history-feed delta in a single transaction and recounts every
 * touched label once at the end (instead of once per change). Returns the ids
 * that had label changes but aren't cached, so sync can fetch mail it missed.
 */
export function applyHistoryChanges(accountId: string, ops: HistoryOp[]): { unknownIds: string[] } {
  const d = getDb();
  const selectLabels = d.prepare("SELECT labelIds FROM messages WHERE accountId = ? AND id = ?");
  const delMsg = d.prepare("DELETE FROM messages WHERE accountId = ? AND id = ?");
  const delAllLabels = d.prepare(
    "DELETE FROM message_labels WHERE accountId = ? AND messageId = ?",
  );
  const delLabel = d.prepare(
    "DELETE FROM message_labels WHERE accountId = ? AND messageId = ? AND labelId = ?",
  );
  const insLabel = d.prepare(
    "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
  );
  const setLabels = d.prepare(
    "UPDATE messages SET labelIds = ?, unread = ?, starred = ? WHERE accountId = ? AND id = ?",
  );

  const touched = new Set<string>();
  const unknown = new Set<string>();
  const current = new Map<string, Set<string> | null>();
  const labelsOf = (id: string): Set<string> | null => {
    if (!current.has(id)) {
      const row = selectLabels.get(accountId, id) as unknown as { labelIds: string } | undefined;
      current.set(id, row ? new Set(parseLabelIds(row.labelIds)) : null);
    }
    return current.get(id) ?? null;
  };
  const change = (id: string, labelIds: string[], add: boolean) => {
    const labels = labelsOf(id);
    if (!labels) {
      unknown.add(id);
      return;
    }
    for (const lid of labelIds) {
      touched.add(lid);
      if (add) {
        labels.add(lid);
        insLabel.run(accountId, id, lid);
      } else {
        labels.delete(lid);
        delLabel.run(accountId, id, lid);
      }
    }
    const next = [...labels];
    setLabels.run(
      JSON.stringify(next),
      labels.has("UNREAD") ? 1 : 0,
      labels.has("STARRED") ? 1 : 0,
      accountId,
      id,
    );
  };

  d.exec("BEGIN");
  try {
    for (const op of ops) {
      if (op.kind !== "deleted") {
        change(op.id, op.labelIds, op.kind === "labelsAdded");
        continue;
      }
      unknown.delete(op.id);
      const labels = labelsOf(op.id);
      if (!labels) continue;
      for (const lid of labels) touched.add(lid);
      delMsg.run(accountId, op.id);
      delAllLabels.run(accountId, op.id);
      current.set(op.id, null);
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }

  recomputeLabelCounts(accountId, [...touched]);
  return { unknownIds: [...unknown] };
}

// ── Draft ids ───────────────────────────────────────────────────────────────

/** Records which Gmail draft owns a cached message (no-op if not cached). */
export function setDraftId(accountId: string, messageId: string, draftId: string): void {
  getDb()
    .prepare("UPDATE messages SET draftId = ? WHERE accountId = ? AND id = ?")
    .run(draftId, accountId, messageId);
}

/** The draft id owning a message: by message id, else a draft in its thread. */
export function getDraftId(accountId: string, messageId: string, threadId?: string): string | null {
  const d = getDb();
  const own = d
    .prepare("SELECT draftId FROM messages WHERE accountId = ? AND id = ?")
    .get(accountId, messageId) as unknown as { draftId: string | null } | undefined;
  if (own?.draftId) return own.draftId;
  if (!threadId) return null;
  const inThread = d
    .prepare(
      "SELECT draftId FROM messages WHERE accountId = ? AND threadId = ? AND draftId IS NOT NULL ORDER BY date DESC LIMIT 1",
    )
    .get(accountId, threadId) as unknown as { draftId: string } | undefined;
  return inThread?.draftId ?? null;
}

/** The subset of `ids` not cached yet for the account (sync skips the rest). */
export function filterUnknownIds(accountId: string, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const d = getDb();
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = d
      .prepare(
        `SELECT id FROM messages WHERE accountId = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
      )
      .all(accountId, ...chunk) as unknown as { id: string }[];
    for (const r of rows) known.add(r.id);
  }
  return ids.filter((id) => !known.has(id));
}

/** Every cached message's labels, by id (the refresh after the history feed
    expired compares them with Gmail's). */
export function getAllMessageLabels(accountId: string): Map<string, string[]> {
  const rows = getDb()
    .prepare("SELECT id, labelIds FROM messages WHERE accountId = ?")
    .all(accountId) as unknown as { id: string; labelIds: string }[];
  return new Map(rows.map((r) => [r.id, parseLabelIds(r.labelIds)]));
}

/** Dates of the given cached messages (e.g. to age-gate draft pruning). */
export function getMessageDates(accountId: string, ids: string[]): { id: string; date: number }[] {
  if (ids.length === 0) return [];
  const d = getDb();
  const out: { id: string; date: number }[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(
      ...(d
        .prepare(
          `SELECT id, date FROM messages WHERE accountId = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(accountId, ...chunk) as unknown as { id: string; date: number }[]),
    );
  }
  return out;
}

/** Messages cached for an account (full-sync progress after a resume). */
export function countAllMessages(accountId: string): number {
  const d = getDb();
  const row = d
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE accountId = ?")
    .get(accountId) as unknown as { n: number };
  return row?.n ?? 0;
}

export function getMessageIdsForLabel(accountId: string, labelId: string): string[] {
  const d = getDb();
  const rows = d
    .prepare(`
      SELECT m.id FROM messages m
      JOIN message_labels ml
        ON ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = ?
     WHERE m.accountId = ?
     ORDER BY m.date DESC
    `)
    .all(labelId, accountId) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Total unread INBOX messages across accounts, leaving out `except` — drives the dock badge. */
export function countInboxUnreadAll(except: ReadonlySet<string> = new Set()): number {
  const d = getDb();
  const rows = d
    .prepare(`
      SELECT m.accountId, COUNT(*) AS n
        FROM messages m
        JOIN message_labels ml
          ON ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'INBOX'
       WHERE m.unread = 1
       GROUP BY m.accountId
    `)
    .all() as unknown as { accountId: string; n: number }[];
  return rows.reduce((sum, r) => (except.has(r.accountId) ? sum : sum + r.n), 0);
}

export function countMessagesForLabel(accountId: string, labelId: string): number {
  const d = getDb();
  const row = d
    .prepare("SELECT COUNT(*) AS n FROM message_labels WHERE accountId = ? AND labelId = ?")
    .get(accountId, labelId) as unknown as { n: number };
  return row?.n ?? 0;
}

/** Unread messages cached locally under a label. */
export function countUnreadForLabel(accountId: string, labelId: string): number {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT COUNT(*) AS n FROM message_labels ml
         JOIN messages m ON m.accountId = ml.accountId AND m.id = ml.messageId
        WHERE ml.accountId = ? AND ml.labelId = ? AND m.unread = 1`,
    )
    .get(accountId, labelId) as unknown as { n: number };
  return row?.n ?? 0;
}

/** The label's unread counter as last reported by Gmail (or recomputed locally). */
export function getLabelUnread(accountId: string, labelId: string): number {
  const d = getDb();
  const row = d
    .prepare("SELECT unread FROM labels WHERE accountId = ? AND id = ?")
    .get(accountId, labelId) as unknown as { unread: number | null } | undefined;
  return row?.unread ?? 0;
}

// ── Combined (cross-account) reads ──────────────────────────────────────────

const HAS_LABEL =
  "EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = ?)";

/** WHERE fragment for a rule set: rules OR'd; within a rule, allOf AND'd and noneOf excluded. */
function rulesWhere(rules: ViewRule[]): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  for (const rule of rules) {
    const sub: string[] = ["m.accountId = ?"];
    params.push(rule.accountId);
    for (const labelId of rule.allOf) {
      sub.push(HAS_LABEL);
      params.push(labelId);
    }
    // Gmail semantics: spam/trash only surface when a rule asks for them.
    if (!rule.allOf.includes("SPAM") && !rule.allOf.includes("TRASH")) {
      sub.push(NOT_SPAM_TRASH);
    }
    if (rule.noneOf.length > 0) {
      sub.push(
        `NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId IN (${rule.noneOf.map(() => "?").join(", ")}))`,
      );
      params.push(...rule.noneOf);
    }
    parts.push(`(${sub.join(" AND ")})`);
  }
  return { clause: parts.join(" OR "), params };
}

/**
 * Combined-view query: one row per thread having any message matching any of
 * the given per-account rules. Label ids are exact and account-scoped, so the
 * same label *name* in two accounts stays two distinct choices.
 */
export function getCombinedThreadsByRules(
  rules: ViewRule[],
  offset: number,
  limit: number,
): { messages: GmailMessageSummary[]; hasMore: boolean } {
  if (rules.length === 0) return { messages: [], hasMore: false };
  const d = getDb();
  const { clause, params } = rulesWhere(rules);

  const rows = d
    .prepare(
      threadPageQuery(`
        SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId
          FROM messages m
         WHERE ${clause}
      `),
    )
    .all(...params, limit + 1, offset) as unknown as ThreadRow[];

  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).map(rowToThreadSummary), hasMore };
}

export function countCombinedByRules(rules: ViewRule[]): { total: number; unread: number } {
  if (rules.length === 0) return { total: 0, unread: 0 };
  const d = getDb();
  const { clause, params } = rulesWhere(rules);

  const row = d
    .prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN EXISTS (
               SELECT 1 FROM message_labels ml
                WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'UNREAD'
             ) THEN 1 ELSE 0 END), 0) AS unread
        FROM messages m
       WHERE ${clause}
    `)
    .get(...params) as { total: number; unread: number } | undefined;

  return { total: row?.total ?? 0, unread: row?.unread ?? 0 };
}

// ── Full-text search ──────────────────────────────────────────────────────────

/**
 * User input → FTS5 MATCH syntax: each whitespace token becomes a quoted phrase
 * (neutralizing operators like AND/NEAR/parens), the last one prefix-matched
 * for search-as-you-type.
 */
function toFtsMatch(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t, i) => `"${t}"${i === tokens.length - 1 ? "*" : ""}`).join(" ");
}

export type SearchScope = {
  /** Restrict to one label (view filter, account mode). */
  labelId?: string;
  /** Restrict to a Combined view's rules (carry their own spam/trash semantics). */
  rules?: ViewRule[];
  starred?: boolean;
  important?: boolean;
  hasAttachments?: boolean;
  /** Only messages newer than N days. */
  withinDays?: number;
};

/**
 * Local message-level search; accountId null searches every account. The scope
 * restricts results to the current view and/or structured filters — filters
 * work with an empty query too (browse-the-view-filtered), so the FTS match is
 * an optional condition rather than the query's spine.
 */
export function searchMessages(
  queryText: string,
  accountId: string | null,
  offset: number,
  limit: number,
  scope?: SearchScope,
): { messages: GmailMessageSummary[]; hasMore: boolean } {
  const match = toFtsMatch(queryText);
  const hasFilters = Boolean(
    scope?.labelId ||
    scope?.starred ||
    scope?.important ||
    scope?.hasAttachments ||
    scope?.withinDays,
  );
  if (!match && !hasFilters) return { messages: [], hasMore: false };
  if (scope?.rules && scope.rules.length === 0) return { messages: [], hasMore: false };
  const d = getDb();
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (match) {
    conds.push("m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
    params.push(match);
  }
  if (accountId) {
    conds.push("m.accountId = ?");
    params.push(accountId);
  }
  if (scope?.rules) {
    const { clause, params: ruleParams } = rulesWhere(scope.rules);
    conds.push(`(${clause})`);
    params.push(...ruleParams);
  } else if (scope?.labelId) {
    conds.push(HAS_LABEL);
    params.push(scope.labelId);
    if (scope.labelId !== "SPAM" && scope.labelId !== "TRASH") conds.push(NOT_SPAM_TRASH);
  } else {
    conds.push(NOT_SPAM_TRASH);
  }
  if (scope?.starred) conds.push("m.starred = 1");
  if (scope?.important) {
    conds.push(HAS_LABEL);
    params.push("IMPORTANT");
  }
  if (scope?.hasAttachments) conds.push("m.hasAttachments = 1");
  if (scope?.withinDays) {
    conds.push("m.date >= ?");
    params.push(Date.now() - scope.withinDays * 86_400_000);
  }
  const rows = d
    .prepare(`
      SELECT m.* FROM messages m
      WHERE ${conds.join(" AND ")}
      ORDER BY m.date DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit + 1, offset) as unknown as MessageRow[];
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).map(rowToSummary), hasMore };
}

// ── Contact suggestions ───────────────────────────────────────────────────────

function parseAddressEntry(entry: string): { name: string; email: string } {
  const trimmed = entry.trim();
  const match = trimmed.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim() };
  }
  return { name: "", email: trimmed };
}

/** Split an address-list header on commas outside double quotes. */
function splitAddressEntries(list: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of list) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      if (current.trim()) out.push(parseAddressEntry(current));
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(parseAddressEntry(current));
  return out.filter((e) => e.email.includes("@"));
}

/**
 * Recipient autocomplete from the local cache: senders aggregated across the
 * whole store plus To/Cc addressees from the most recent matching messages,
 * ranked by frequency then recency.
 */
export function suggestContacts(queryText: string, limit: number): ContactSuggestion[] {
  const q = queryText.trim().toLowerCase();
  if (!q) return [];
  const d = getDb();
  const like = `%${q.replace(/([\\%_])/g, "\\$1")}%`;

  type Entry = { name: string; email: string; freq: number; lastDate: number };
  const byEmail = new Map<string, Entry>();
  const bump = (name: string, email: string, freq: number, date: number) => {
    const key = email.toLowerCase();
    if (!key.includes("@")) return;
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, { name, email, freq, lastDate: date });
      return;
    }
    existing.freq += freq;
    if (date > existing.lastDate) existing.lastDate = date;
    if (!existing.name && name) existing.name = name;
  };

  const fromRows = d
    .prepare(`
      SELECT fromEmail AS email, MAX(fromName) AS name, COUNT(*) AS freq, MAX(date) AS lastDate
        FROM messages
       WHERE fromEmail LIKE ? ESCAPE '\\' OR fromName LIKE ? ESCAPE '\\'
       GROUP BY lower(fromEmail)
    `)
    .all(like, like) as unknown as {
    email: string;
    name: string | null;
    freq: number;
    lastDate: number;
  }[];
  for (const r of fromRows) bump(r.name ?? "", r.email, r.freq, r.lastDate);

  const recipientRows = d
    .prepare(`
      SELECT toField, cc, date FROM messages
       WHERE toField LIKE ? ESCAPE '\\' OR cc LIKE ? ESCAPE '\\'
       ORDER BY date DESC LIMIT 400
    `)
    .all(like, like) as unknown as { toField: string; cc: string | null; date: number }[];
  for (const r of recipientRows) {
    const list = r.cc ? `${r.toField},${r.cc}` : r.toField;
    for (const entry of splitAddressEntries(list)) {
      if (entry.email.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)) {
        bump(entry.name, entry.email, 1, r.date);
      }
    }
  }

  return [...byEmail.values()]
    .sort((a, b) => b.freq - a.freq || b.lastDate - a.lastDate)
    .slice(0, limit)
    .map((e) => ({ name: e.name === e.email ? "" : e.name, email: e.email }));
}

// ── Labels ──────────────────────────────────────────────────────────────────

export function upsertLabels(accountId: string, labels: GmailLabel[]): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM labels WHERE accountId = ?").run(accountId);
    const ins = d.prepare(`
      INSERT INTO labels (accountId, id, name, type, unread, total, bgColor, textColor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of labels) {
      ins.run(
        accountId,
        l.id,
        l.name,
        l.type,
        l.unread ?? null,
        l.total ?? null,
        l.color?.backgroundColor ?? null,
        l.color?.textColor ?? null,
      );
    }
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}

interface LabelRow {
  id: string;
  name: string;
  type: string;
  unread: number | null;
  total: number | null;
  bgColor: string | null;
  textColor: string | null;
}

export function getLabels(accountId: string): GmailLabel[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM labels WHERE accountId = ?")
    .all(accountId) as unknown as LabelRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type === "system" ? "system" : "user",
    unread: r.unread ?? undefined,
    total: r.total ?? undefined,
    color:
      r.bgColor && r.textColor ? { backgroundColor: r.bgColor, textColor: r.textColor } : undefined,
  }));
}

// ── Sync state ────────────────────────────────────────────────────────────────

export interface SyncStateRow {
  historyId: string | null;
  fullSyncDone: boolean;
  lastSyncAt: number | null;
}

export function getSyncState(accountId: string): SyncStateRow {
  const d = getDb();
  const row = d
    .prepare("SELECT historyId, fullSyncDone, lastSyncAt FROM sync_state WHERE accountId = ?")
    .get(accountId) as unknown as
    | { historyId: string | null; fullSyncDone: number; lastSyncAt: number | null }
    | undefined;
  if (!row) return { historyId: null, fullSyncDone: false, lastSyncAt: null };
  return {
    historyId: row.historyId,
    fullSyncDone: row.fullSyncDone === 1,
    lastSyncAt: row.lastSyncAt,
  };
}

/** Drops a deleted label's message mappings (sync reconciles the rest). */
// ── Label edits (mirrored locally before Gmail confirms) ────────────────────

/** Inserts a label or updates its name/color, keeping cached counts. */
export function putLabel(accountId: string, label: GmailLabel): void {
  getDb()
    .prepare(`
      INSERT INTO labels (accountId, id, name, type, unread, total, bgColor, textColor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(accountId, id) DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        bgColor = excluded.bgColor,
        textColor = excluded.textColor
    `)
    .run(
      accountId,
      label.id,
      label.name,
      label.type,
      label.unread ?? null,
      label.total ?? null,
      label.color?.backgroundColor ?? null,
      label.color?.textColor ?? null,
    );
}

/**
 * Renames/recolors a label, renaming nested labels ("Old/child" → "New/child")
 * like Gmail does. Returns a revert that restores the previous rows.
 */
export function editLabelLocally(
  accountId: string,
  labelId: string,
  edit: { name?: string; color?: { backgroundColor: string; textColor: string } },
): () => void {
  const before = getLabels(accountId);
  const target = before.find((l) => l.id === labelId);
  if (!target) return () => {};
  const changed: GmailLabel[] = [];
  if (edit.name && edit.name !== target.name) {
    const prefix = `${target.name}/`;
    for (const l of before) {
      if (l.id === labelId) changed.push({ ...l, name: edit.name });
      else if (l.name.startsWith(prefix))
        changed.push({ ...l, name: `${edit.name}/${l.name.slice(prefix.length)}` });
    }
  }
  if (edit.color) {
    const own = changed.find((l) => l.id === labelId);
    if (own) own.color = edit.color;
    else changed.push({ ...target, color: edit.color });
  }
  for (const l of changed) putLabel(accountId, l);
  const previous = before.filter((l) => changed.some((c) => c.id === l.id));
  return () => {
    for (const l of previous) putLabel(accountId, l);
  };
}

/**
 * Removes a label from the cache: the label row and every message's link to
 * it (both the message_labels rows and the labelIds JSON). Returns a revert.
 */
export function removeLabelLocally(accountId: string, labelId: string): () => void {
  const label = getLabels(accountId).find((l) => l.id === labelId);
  const messageIds = getMessageIdsForLabel(accountId, labelId);
  for (const id of messageIds) applyLabelChange(accountId, id, [], [labelId]);
  getDb().prepare("DELETE FROM labels WHERE accountId = ? AND id = ?").run(accountId, labelId);
  return () => {
    if (label) putLabel(accountId, label);
    for (const id of messageIds) applyLabelChange(accountId, id, [labelId], []);
  };
}

export function getKv(key: string): string | null {
  const d = getDb();
  const row = d.prepare("SELECT value FROM kv WHERE key = ?").get(key) as unknown as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setKv(key: string, value: string): void {
  const d = getDb();
  d.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function setSyncState(accountId: string, patch: Partial<SyncStateRow>): void {
  const d = getDb();
  const current = getSyncState(accountId);
  const next = {
    historyId: patch.historyId !== undefined ? patch.historyId : current.historyId,
    fullSyncDone: patch.fullSyncDone !== undefined ? patch.fullSyncDone : current.fullSyncDone,
    lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : current.lastSyncAt,
  };
  d.prepare(`
    INSERT INTO sync_state (accountId, historyId, fullSyncDone, lastSyncAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(accountId) DO UPDATE SET
      historyId    = excluded.historyId,
      fullSyncDone = excluded.fullSyncDone,
      lastSyncAt   = excluded.lastSyncAt
  `).run(accountId, next.historyId, next.fullSyncDone ? 1 : 0, next.lastSyncAt);
}

// ── Account teardown ──────────────────────────────────────────────────────────

export function removeAccountData(accountId: string): void {
  const d = getDb();
  d.exec("BEGIN");
  try {
    d.prepare("DELETE FROM messages WHERE accountId = ?").run(accountId);
    d.prepare("DELETE FROM message_labels WHERE accountId = ?").run(accountId);
    d.prepare("DELETE FROM labels WHERE accountId = ?").run(accountId);
    d.prepare("DELETE FROM sync_state WHERE accountId = ?").run(accountId);
    // Per-account sync bookkeeping (resume cursor, history seed, backfill flag,
    // push watch):
    // a re-added account must start its first sync from scratch.
    const kvKeys = [
      "fullSyncCursor",
      "fullSyncSeed",
      "fullSyncRefresh",
      "spamTrashBackfilled",
      "gmailWatch",
      "imapSync",
      "imapTrashedFrom",
    ].map((prefix) => `${prefix}:${accountId}`);
    d.prepare(`DELETE FROM kv WHERE key IN (${kvKeys.map(() => "?").join(", ")})`).run(...kvKeys);
    d.exec("COMMIT");
  } catch (err) {
    d.exec("ROLLBACK");
    throw err;
  }
}
