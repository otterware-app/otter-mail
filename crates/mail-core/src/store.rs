//! The mail cache: one SQLite file (`mail-cache.db`), the same schema the
//! Electron app's core kept, so either app can open the other's cache. The UI
//! renders from it; sync writes into it.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};

use crate::model::*;
use crate::text;

const SCHEMA: &str = r#"
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

CREATE TABLE IF NOT EXISTS mail_schedule (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, kind TEXT NOT NULL,
  dueAt INTEGER NOT NULL, state TEXT NOT NULL, subject TEXT NOT NULL,
  threadId TEXT, payload TEXT, error TEXT
);
"#;

const FTS: &str = r#"
CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject, fromName, fromEmail, snippet, bodyText,
  content='messages', content_rowid='rowid'
);
"#;

const FTS_TRIGGERS: &str = r#"
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, fromName, fromEmail, snippet, bodyText)
  VALUES (new.rowid, new.subject, new.fromName, new.fromEmail, new.snippet, new.bodyText);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, fromName, fromEmail, snippet, bodyText)
  VALUES ('delete', old.rowid, old.subject, old.fromName, old.fromEmail, old.snippet, old.bodyText);
END;
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
"#;

/// Messages carrying a label (SPAM and TRASH stay out of other lists).
const NOT_SPAM_TRASH: &str = "NOT EXISTS (SELECT 1 FROM message_labels mlx WHERE mlx.accountId = m.accountId AND mlx.messageId = m.id AND mlx.labelId IN ('SPAM', 'TRASH'))";

/// One mailbox's share of a list: its messages carrying every `all_of`
/// label and none of `none_of`. Rules are OR'd (combined mailboxes, views).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRule {
    pub account_id: String,
    #[serde(default)]
    pub all_of: Vec<String>,
    #[serde(default)]
    pub none_of: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum HistoryOp {
    LabelsAdded { id: String, labels: Vec<String> },
    LabelsRemoved { id: String, labels: Vec<String> },
    Deleted { id: String },
}

#[derive(Clone, Debug, Default)]
pub struct SyncState {
    pub history_id: Option<String>,
    pub full_sync_done: bool,
    pub last_sync_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAttachment {
    id: String,
    filename: String,
    mime_type: String,
    size: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_id: Option<String>,
}

/// A label change made here and not yet confirmed by the server: reapplied
/// over whatever a sync reads meanwhile, so a stale read can't undo it.
struct PendingWrite {
    add: Vec<String>,
    remove: Vec<String>,
    until: Option<Instant>,
}

pub struct Store {
    conn: Mutex<Connection>,
    pending: Mutex<HashMap<(String, String), PendingWrite>>,
}

pub struct Contact {
    pub name: Option<String>,
    pub email: String,
}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Store> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Store> {
        conn.execute_batch(SCHEMA)?;
        conn.execute("UPDATE messages SET threadId = id WHERE threadId = ''", [])?;
        let columns: HashSet<String> = conn
            .prepare("SELECT name FROM pragma_table_info('messages')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<_>>()?;
        for (name, ddl) in [
            (
                "messageIdHeader",
                "ALTER TABLE messages ADD COLUMN messageIdHeader TEXT",
            ),
            (
                "referencesHeader",
                "ALTER TABLE messages ADD COLUMN referencesHeader TEXT",
            ),
            ("draftId", "ALTER TABLE messages ADD COLUMN draftId TEXT"),
            (
                "bodyAttempts",
                "ALTER TABLE messages ADD COLUMN bodyAttempts INTEGER NOT NULL DEFAULT 0",
            ),
            (
                "bodyRetryAt",
                "ALTER TABLE messages ADD COLUMN bodyRetryAt INTEGER NOT NULL DEFAULT 0",
            ),
        ] {
            if !columns.contains(name) {
                conn.execute(ddl, [])?;
            }
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_undownloaded ON messages (accountId, detailFetched, date DESC)",
            [],
        )?;
        let has_fts: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_fts {
            conn.execute_batch(FTS)?;
            conn.execute(
                "INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
                [],
            )?;
        }
        conn.execute_batch(FTS_TRIGGERS)?;
        Ok(Store {
            conn: Mutex::new(conn),
            pending: Mutex::new(HashMap::new()),
        })
    }

    // ---- kv and sync state ----------------------------------------------

    pub fn kv_get(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get(0))
            .optional()?
            .flatten())
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn kv_delete(&self, key: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM kv WHERE key = ?", [key])?;
        Ok(())
    }

    pub fn sync_state(&self, account: &str) -> Result<SyncState> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT historyId, fullSyncDone, lastSyncAt FROM sync_state WHERE accountId = ?",
                [account],
                |r| {
                    Ok(SyncState {
                        history_id: r.get(0)?,
                        full_sync_done: r.get::<_, i64>(1)? != 0,
                        last_sync_at: r.get(2)?,
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }

    pub fn set_sync_state(&self, account: &str, state: &SyncState) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO sync_state (accountId, historyId, fullSyncDone, lastSyncAt) VALUES (?, ?, ?, ?)
             ON CONFLICT(accountId) DO UPDATE SET historyId = excluded.historyId,
               fullSyncDone = excluded.fullSyncDone, lastSyncAt = excluded.lastSyncAt",
            params![
                account,
                state.history_id,
                state.full_sync_done as i64,
                state.last_sync_at
            ],
        )?;
        Ok(())
    }

    pub fn remove_account_data(&self, account: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for table in [
            "messages",
            "message_labels",
            "labels",
            "sync_state",
            "mail_schedule",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE accountId = ?"),
                [account],
            )?;
        }
        for prefix in [
            "fullSyncCursor:",
            "fullSyncSeed:",
            "fullSyncRefresh:",
            "spamTrashBackfilled:",
            "gmailWatch:",
            "imapSync:",
            "imapTrashedFrom:",
            "replayFrom:",
        ] {
            tx.execute(
                "DELETE FROM kv WHERE key = ?",
                [format!("{prefix}{account}")],
            )?;
        }
        tx.execute(
            "DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'",
            [format!("unsubscribed:{}:%", like_escape(account))],
        )?;
        tx.commit()?;
        Ok(())
    }

    // ---- labels -----------------------------------------------------------

    pub fn labels(&self, account: &str) -> Result<Vec<Label>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT accountId, id, name, type, unread, total, bgColor, textColor FROM labels WHERE accountId = ?",
        )?;
        let labels = stmt
            .query_map([account], |r| {
                Ok(Label {
                    account_id: r.get(0)?,
                    id: r.get(1)?,
                    name: r.get(2)?,
                    system: r.get::<_, String>(3)? == "system",
                    unread: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    total: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    background_color: r.get(6)?,
                    text_color: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(labels)
    }

    pub fn replace_labels(&self, account: &str, labels: &[Label]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM labels WHERE accountId = ?", [account])?;
        for l in labels {
            tx.execute(
                "INSERT INTO labels (accountId, id, name, type, unread, total, bgColor, textColor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    account,
                    l.id,
                    l.name,
                    if l.system { "system" } else { "user" },
                    l.unread,
                    l.total,
                    l.background_color,
                    l.text_color
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Adds or renames a label, keeping its counts.
    pub fn put_label(&self, l: &Label) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO labels (accountId, id, name, type, unread, total, bgColor, textColor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(accountId, id) DO UPDATE SET name = excluded.name, type = excluded.type,
               bgColor = excluded.bgColor, textColor = excluded.textColor",
            params![
                l.account_id,
                l.id,
                l.name,
                if l.system { "system" } else { "user" },
                l.unread,
                l.total,
                l.background_color,
                l.text_color
            ],
        )?;
        Ok(())
    }

    pub fn delete_label(&self, account: &str, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM labels WHERE accountId = ? AND id = ?",
            params![account, id],
        )?;
        conn.execute(
            "DELETE FROM message_labels WHERE accountId = ? AND labelId = ?",
            params![account, id],
        )?;
        Ok(())
    }

    // ---- writes -------------------------------------------------------------

    /// Records a label change made locally so syncs keep it until `settle`.
    pub fn begin_pending(&self, account: &str, ids: &[String], add: &[String], remove: &[String]) {
        let mut pending = self.pending.lock();
        for id in ids {
            let entry = pending
                .entry((account.to_string(), id.clone()))
                .or_insert(PendingWrite {
                    add: vec![],
                    remove: vec![],
                    until: None,
                });
            entry.add.retain(|l| !remove.contains(l));
            entry.remove.retain(|l| !add.contains(l));
            entry.add.extend(add.iter().cloned());
            entry.remove.extend(remove.iter().cloned());
            entry.until = None;
        }
    }

    /// The server write finished: keep shielding for a grace period.
    pub fn settle_pending(&self, account: &str, ids: &[String]) {
        let mut pending = self.pending.lock();
        for id in ids {
            if let Some(entry) = pending.get_mut(&(account.to_string(), id.clone())) {
                entry.until = Some(Instant::now() + Duration::from_secs(30));
            }
        }
    }

    pub fn drop_pending(&self, account: &str, ids: &[String]) {
        let mut pending = self.pending.lock();
        for id in ids {
            pending.remove(&(account.to_string(), id.clone()));
        }
    }

    fn with_pending_labels(&self, account: &str, id: &str, labels: &mut Vec<String>) {
        let mut pending = self.pending.lock();
        let now = Instant::now();
        pending.retain(|_, w| w.until.is_none_or(|t| t > now));
        if let Some(w) = pending.get(&(account.to_string(), id.to_string())) {
            labels.retain(|l| !w.remove.contains(l));
            for l in &w.add {
                if !labels.contains(l) {
                    labels.push(l.clone());
                }
            }
        }
    }

    fn write_summary(&self, tx: &rusqlite::Transaction, m: &Message) -> Result<()> {
        let mut labels = m.label_ids.clone();
        self.with_pending_labels(&m.account_id, &m.id, &mut labels);
        let unread = labels.iter().any(|l| l == "UNREAD");
        let starred = labels.iter().any(|l| l == "STARRED");
        let thread_id = if m.thread_id.is_empty() {
            &m.id
        } else {
            &m.thread_id
        };
        tx.execute(
            "INSERT INTO messages
               (accountId, id, threadId, fromName, fromEmail, toField, subject, snippet, date, unread, starred, hasAttachments, labelIds, messageIdHeader, referencesHeader)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(accountId, id) DO UPDATE SET
               threadId = excluded.threadId, fromName = excluded.fromName, fromEmail = excluded.fromEmail,
               toField = excluded.toField, subject = excluded.subject, snippet = excluded.snippet,
               date = excluded.date, unread = excluded.unread, starred = excluded.starred,
               labelIds = excluded.labelIds,
               hasAttachments = CASE WHEN excluded.hasAttachments = 1 THEN 1 ELSE messages.hasAttachments END,
               messageIdHeader  = COALESCE(excluded.messageIdHeader, messages.messageIdHeader),
               referencesHeader = COALESCE(excluded.referencesHeader, messages.referencesHeader)",
            params![
                m.account_id,
                m.id,
                thread_id,
                m.from.name.clone().unwrap_or_default(),
                m.from.email,
                text::format_address_list(&m.to),
                m.subject,
                m.snippet,
                m.date,
                unread as i64,
                starred as i64,
                (!m.attachments.iter().all(|a| a.inline)) as i64,
                serde_json::to_string(&labels)?,
                m.message_id_header,
                m.references,
            ],
        )?;
        tx.execute(
            "DELETE FROM message_labels WHERE accountId = ? AND messageId = ?",
            params![m.account_id, m.id],
        )?;
        for l in &labels {
            tx.execute(
                "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
                params![m.account_id, m.id, l],
            )?;
        }
        Ok(())
    }

    /// Writes what a list or metadata fetch knows about messages.
    pub fn upsert_summaries(&self, messages: &[Message]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for m in messages {
            self.write_summary(&tx, m)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Writes whole messages, bodies and attachments included.
    pub fn upsert_details(&self, messages: &[Message]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for m in messages {
            self.write_summary(&tx, m)?;
            let attachments: Vec<StoredAttachment> = m
                .attachments
                .iter()
                .map(|a| StoredAttachment {
                    id: a.id.clone(),
                    filename: a.filename.clone(),
                    mime_type: a.mime_type.clone(),
                    size: a.size,
                    content_id: a.content_id.clone(),
                })
                .collect();
            tx.execute(
                "UPDATE messages SET cc = ?, bodyHtml = ?, bodyText = ?, attachments = ?, hasAttachments = ?, detailFetched = 1 WHERE accountId = ? AND id = ?",
                params![
                    text::format_address_list(&m.cc),
                    m.body_html,
                    m.body_text,
                    serde_json::to_string(&attachments)?,
                    (!m.attachments.is_empty()) as i64,
                    m.account_id,
                    m.id
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_draft_id(&self, account: &str, message_id: &str, draft_id: &str) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET draftId = ? WHERE accountId = ? AND id = ?",
            params![draft_id, account, message_id],
        )?;
        Ok(())
    }

    pub fn draft_id_for_message(&self, account: &str, message_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                "SELECT draftId FROM messages WHERE accountId = ? AND id = ?",
                params![account, message_id],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
    }

    pub fn local_draft_rows(&self, account: &str) -> Result<Vec<(String, i64)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.date FROM messages m JOIN message_labels ml ON ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'DRAFT' WHERE m.accountId = ?",
        )?;
        let rows = stmt
            .query_map([account], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn mark_body_failed(&self, account: &str, id: &str, now: i64) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE messages SET bodyAttempts = bodyAttempts + 1,
               bodyRetryAt = ? + MIN(86400000, 600000 * (1 << MIN(bodyAttempts, 8)))
             WHERE accountId = ? AND id = ?",
            params![now, account, id],
        )?;
        Ok(())
    }

    pub fn delete_messages(&self, account: &str, ids: &[String]) -> Result<Vec<String>> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let mut touched = HashSet::new();
        for id in ids {
            let labels: Vec<String> = {
                let mut stmt = tx.prepare(
                    "SELECT labelId FROM message_labels WHERE accountId = ? AND messageId = ?",
                )?;
                stmt.query_map(params![account, id], |r| r.get(0))?
                    .collect::<rusqlite::Result<_>>()?
            };
            touched.extend(labels);
            tx.execute(
                "DELETE FROM messages WHERE accountId = ? AND id = ?",
                params![account, id],
            )?;
            tx.execute(
                "DELETE FROM message_labels WHERE accountId = ? AND messageId = ?",
                params![account, id],
            )?;
        }
        let touched: Vec<String> = touched.into_iter().collect();
        recompute_label_counts(&tx, account, &touched)?;
        tx.commit()?;
        Ok(touched)
    }

    /// Adds and removes labels on cached messages; returns the labels touched.
    pub fn apply_label_change(
        &self,
        account: &str,
        ids: &[String],
        add: &[String],
        remove: &[String],
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for id in ids {
            for l in remove {
                tx.execute(
                    "DELETE FROM message_labels WHERE accountId = ? AND messageId = ? AND labelId = ?",
                    params![account, id, l],
                )?;
            }
            for l in add {
                tx.execute(
                    "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
                    params![account, id, l],
                )?;
            }
            refresh_message_labels(&tx, account, id)?;
        }
        let touched: Vec<String> = add.iter().chain(remove).cloned().collect();
        recompute_label_counts(&tx, account, &touched)?;
        tx.commit()?;
        Ok(())
    }

    /// A history feed's changes, in order. Returns ids it named that aren't cached.
    pub fn apply_history(&self, account: &str, ops: &[HistoryOp]) -> Result<Vec<String>> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let mut sets: HashMap<String, Option<Vec<String>>> = HashMap::new();
        let mut unknown: Vec<String> = Vec::new();
        let mut touched: HashSet<String> = HashSet::new();
        let load = |tx: &rusqlite::Transaction, id: &str| -> Result<Option<Vec<String>>> {
            let json: Option<String> = tx
                .query_row(
                    "SELECT labelIds FROM messages WHERE accountId = ? AND id = ?",
                    params![account, id],
                    |r| r.get(0),
                )
                .optional()?;
            Ok(json.map(|j| serde_json::from_str(&j).unwrap_or_default()))
        };
        for op in ops {
            match op {
                HistoryOp::LabelsAdded { id, labels } | HistoryOp::LabelsRemoved { id, labels } => {
                    if !sets.contains_key(id) {
                        let current = load(&tx, id)?;
                        sets.insert(id.clone(), current);
                    }
                    match sets.get_mut(id).unwrap() {
                        None => {
                            if !unknown.contains(id) {
                                unknown.push(id.clone());
                            }
                        }
                        Some(set) => {
                            touched.extend(labels.iter().cloned());
                            if matches!(op, HistoryOp::LabelsAdded { .. }) {
                                for l in labels {
                                    if !set.contains(l) {
                                        set.push(l.clone());
                                    }
                                }
                            } else {
                                set.retain(|l| !labels.contains(l));
                            }
                        }
                    }
                }
                HistoryOp::Deleted { id } => {
                    unknown.retain(|u| u != id);
                    sets.insert(id.clone(), None);
                    let labels: Vec<String> = {
                        let mut stmt = tx.prepare(
                            "SELECT labelId FROM message_labels WHERE accountId = ? AND messageId = ?",
                        )?;
                        stmt.query_map(params![account, id], |r| r.get(0))?
                            .collect::<rusqlite::Result<_>>()?
                    };
                    touched.extend(labels);
                    tx.execute(
                        "DELETE FROM messages WHERE accountId = ? AND id = ?",
                        params![account, id],
                    )?;
                    tx.execute(
                        "DELETE FROM message_labels WHERE accountId = ? AND messageId = ?",
                        params![account, id],
                    )?;
                }
            }
        }
        for (id, set) in &sets {
            let Some(set) = set else { continue };
            let mut labels = set.clone();
            self.with_pending_labels(account, id, &mut labels);
            tx.execute(
                "DELETE FROM message_labels WHERE accountId = ? AND messageId = ?",
                params![account, id],
            )?;
            for l in &labels {
                tx.execute(
                    "INSERT OR IGNORE INTO message_labels (accountId, messageId, labelId) VALUES (?, ?, ?)",
                    params![account, id, l],
                )?;
            }
            refresh_message_labels(&tx, account, id)?;
        }
        let touched: Vec<String> = touched.into_iter().collect();
        recompute_label_counts(&tx, account, &touched)?;
        tx.commit()?;
        Ok(unknown)
    }

    pub fn recount_labels(&self, account: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM labels WHERE accountId = ?")?;
            stmt.query_map([account], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        recompute_label_counts(&tx, account, &ids)?;
        tx.commit()?;
        Ok(())
    }

    // ---- reads ----------------------------------------------------------------

    pub fn filter_unknown_ids(&self, account: &str, ids: &[String]) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut known = HashSet::new();
        for chunk in ids.chunks(500) {
            let marks = vec!["?"; chunk.len()].join(",");
            let sql = format!("SELECT id FROM messages WHERE accountId = ? AND id IN ({marks})");
            let mut stmt = conn.prepare(&sql)?;
            let args = std::iter::once(account.to_string()).chain(chunk.iter().cloned());
            for id in stmt.query_map(params_from_iter(args), |r| r.get::<_, String>(0))? {
                known.insert(id?);
            }
        }
        Ok(ids
            .iter()
            .filter(|id| !known.contains(*id))
            .cloned()
            .collect())
    }

    /// One page of conversations matching any of `rules`, newest first.
    /// Returns the rows and whether more follow.
    pub fn threads_page(
        &self,
        rules: &[ViewRule],
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<ThreadSummary>, bool)> {
        if rules.is_empty() {
            return Ok((vec![], false));
        }
        let (clause, args) = rules_clause(rules);
        let matched = format!(
            "SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId FROM messages m WHERE {clause}"
        );
        let mut rows = self.thread_page_query(&matched, args, limit + 1, offset)?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        Ok((rows, more))
    }

    /// Conversation rows for the given threads, in that order.
    pub fn thread_summaries(&self, refs: &[(String, String)]) -> Result<Vec<ThreadSummary>> {
        if refs.is_empty() {
            return Ok(vec![]);
        }
        let json = serde_json::to_string(
            &refs
                .iter()
                .map(|(a, t)| serde_json::json!([a, t]))
                .collect::<Vec<_>>(),
        )?;
        let matched = "SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId FROM messages m
             JOIN json_each(?) j ON m.accountId = json_extract(j.value, '$[0]') AND m.threadId = json_extract(j.value, '$[1]')";
        let rows = self.thread_page_query(matched, vec![json], refs.len(), 0)?;
        let mut by_key: HashMap<(String, String), ThreadSummary> = rows
            .into_iter()
            .map(|r| ((r.account_id.clone(), r.id.clone()), r))
            .collect();
        Ok(refs.iter().filter_map(|k| by_key.remove(k)).collect())
    }

    fn thread_page_query(
        &self,
        matched: &str,
        mut args: Vec<String>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<ThreadSummary>> {
        let sql = format!(
            "WITH matched AS ({matched}),
             agg AS (
               SELECT t.accountId AS accountId, t.threadId AS threadId,
                      COUNT(*) AS threadCount, MAX(t.unread) AS threadUnread,
                      MAX(t.starred) AS threadStarred, MAX(t.date) AS repDate,
                      MAX(t.hasAttachments) AS threadAttachments
                 FROM messages t
                 JOIN matched mt ON mt.accountId = t.accountId AND mt.threadId = t.threadId
                GROUP BY t.accountId, t.threadId
                ORDER BY repDate DESC
                LIMIT ? OFFSET ?
             )
             SELECT m.accountId, m.threadId, m.subject, m.snippet, m.fromName, m.fromEmail, m.toField,
                    agg.repDate, agg.threadCount, agg.threadUnread, agg.threadStarred, agg.threadAttachments,
                    (SELECT GROUP_CONCAT(DISTINCT tl.labelId)
                       FROM messages tm
                       CROSS JOIN message_labels tl ON tl.accountId = tm.accountId AND tl.messageId = tm.id
                      WHERE tm.accountId = agg.accountId AND tm.threadId = agg.threadId) AS threadLabels,
                    (SELECT GROUP_CONCAT(tm.fromName || char(31) || tm.fromEmail, char(30))
                       FROM (SELECT fromName, fromEmail FROM messages
                              WHERE accountId = agg.accountId AND threadId = agg.threadId ORDER BY date ASC) tm) AS senders,
                    (SELECT COUNT(*) FROM messages dm
                       JOIN message_labels dl ON dl.accountId = dm.accountId AND dl.messageId = dm.id AND dl.labelId = 'DRAFT'
                      WHERE dm.accountId = agg.accountId AND dm.threadId = agg.threadId) AS draftCount
               FROM agg
               JOIN messages m ON m.accountId = agg.accountId AND m.threadId = agg.threadId AND m.date = agg.repDate
              GROUP BY agg.accountId, agg.threadId
              ORDER BY agg.repDate DESC"
        );
        args.push(limit.to_string());
        args.push(offset.to_string());
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), |r| {
                let labels: Option<String> = r.get(12)?;
                let senders_raw: Option<String> = r.get(13)?;
                let count: i64 = r.get(8)?;
                let drafts: i64 = r.get(14)?;
                let to_field: String = r.get(6)?;
                let mut senders: Vec<Person> = Vec::new();
                for entry in senders_raw.unwrap_or_default().split('\u{1e}') {
                    let mut parts = entry.splitn(2, '\u{1f}');
                    let name = parts.next().unwrap_or_default().to_string();
                    let email = parts.next().unwrap_or_default().to_string();
                    if email.is_empty() {
                        continue;
                    }
                    if !senders.iter().any(|p| p.email.eq_ignore_ascii_case(&email)) {
                        senders.push(Person {
                            name: (!name.is_empty() && name != email).then_some(name),
                            email,
                        });
                    }
                }
                if senders.is_empty() {
                    let name: String = r.get(4)?;
                    senders.push(Person {
                        name: (!name.is_empty()).then_some(name),
                        email: r.get(5)?,
                    });
                }
                let label_ids: Vec<String> = labels
                    .unwrap_or_default()
                    .split(',')
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .collect();
                Ok(ThreadSummary {
                    account_id: r.get(0)?,
                    id: r.get(1)?,
                    subject: r.get(2)?,
                    snippet: r.get(3)?,
                    senders,
                    date: r.get(7)?,
                    message_count: count,
                    unread: r.get::<_, i64>(9)? != 0,
                    starred: r.get::<_, i64>(10)? != 0,
                    has_attachments: r.get::<_, i64>(11)? != 0,
                    draft: drafts > 0,
                    draft_only: drafts > 0 && drafts == count,
                    draft_to: text::parse_address_list(&to_field),
                    label_ids,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Every cached message of a conversation, oldest first.
    pub fn thread_messages(&self, account: &str, thread_id: &str) -> Result<Vec<Message>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT {MESSAGE_COLUMNS} FROM messages WHERE accountId = ? AND threadId = ? ORDER BY date ASC, id ASC"
        ))?;
        let rows = stmt
            .query_map(params![account, thread_id], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn message(&self, account: &str, id: &str) -> Result<Option<Message>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(
                &format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE accountId = ? AND id = ?"),
                params![account, id],
                message_from_row,
            )
            .optional()?)
    }

    /// Message ids of a conversation (for thread-wide writes).
    pub fn thread_message_ids(&self, account: &str, thread_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE accountId = ? AND threadId = ? ORDER BY date ASC",
        )?;
        let ids = stmt
            .query_map(params![account, thread_id], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(ids)
    }

    /// Messages whose bodies aren't downloaded yet: inbox first, then newest.
    pub fn undownloaded(
        &self,
        account: &str,
        limit: usize,
        now: i64,
    ) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.id, m.threadId FROM messages m
              WHERE m.accountId = ? AND m.detailFetched = 0 AND m.bodyRetryAt <= ?
              ORDER BY EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'INBOX') DESC, m.date DESC
              LIMIT ?",
        )?;
        let rows = stmt
            .query_map(params![account, now, limit as i64], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count_undownloaded(&self, account: &str) -> Result<i64> {
        let conn = self.conn.lock();
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE accountId = ? AND detailFetched = 0",
            [account],
            |r| r.get(0),
        )?)
    }

    /// Unread inbox messages per mailbox (the Dock badge).
    pub fn inbox_unread_counts(&self) -> Result<HashMap<String, i64>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.accountId, COUNT(*) AS n FROM messages m
               JOIN message_labels ml ON ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = 'INBOX'
              WHERE m.unread = 1 GROUP BY m.accountId",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        Ok(rows)
    }

    /// Messages (and unread ones) matching rules.
    pub fn count_by_rules(&self, rules: &[ViewRule]) -> Result<(i64, i64)> {
        if rules.is_empty() {
            return Ok((0, 0));
        }
        let (clause, args) = rules_clause(rules);
        let conn = self.conn.lock();
        Ok(conn.query_row(
            &format!("SELECT COUNT(*), COALESCE(SUM(m.unread), 0) FROM messages m WHERE {clause}"),
            params_from_iter(args.iter()),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// Conversations with unread mail matching rules.
    pub fn count_threads_by_rules(&self, rules: &[ViewRule]) -> Result<(i64, i64)> {
        if rules.is_empty() {
            return Ok((0, 0));
        }
        let (clause, args) = rules_clause(rules);
        let conn = self.conn.lock();
        Ok(conn.query_row(
            &format!(
                "SELECT COUNT(DISTINCT m.accountId || char(31) || m.threadId),
                        COUNT(DISTINCT CASE WHEN m.unread = 1 THEN m.accountId || char(31) || m.threadId END)
                   FROM messages m WHERE {clause}"
            ),
            params_from_iter(args.iter()),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    }

    /// Local full-text search, as conversations (newest first).
    pub fn search_threads(
        &self,
        query: &LocalQuery,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<ThreadSummary>, bool)> {
        let (clause, args) = query.clause();
        let matched = format!(
            "SELECT DISTINCT m.accountId AS accountId, m.threadId AS threadId FROM messages m WHERE {clause}"
        );
        let mut rows = self.thread_page_query(&matched, args, limit + 1, offset)?;
        let more = rows.len() > limit;
        rows.truncate(limit);
        Ok((rows, more))
    }

    /// People from cached mail, most written-to first.
    pub fn suggest_contacts(&self, q: &str, limit: usize) -> Result<Vec<Contact>> {
        let like = format!("%{}%", like_escape(q));
        let conn = self.conn.lock();
        let mut merged: HashMap<String, (Option<String>, String, i64, i64)> = HashMap::new();
        let mut stmt = conn.prepare(
            "SELECT fromEmail, MAX(fromName), COUNT(*), MAX(date) FROM messages
              WHERE fromEmail LIKE ?1 ESCAPE '\\' OR fromName LIKE ?1 ESCAPE '\\'
              GROUP BY lower(fromEmail)",
        )?;
        for row in stmt.query_map([&like], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })? {
            let (email, name, freq, last) = row?;
            merged.insert(email.to_lowercase(), (name, email, freq, last));
        }
        let mut stmt = conn.prepare(
            "SELECT toField, cc, date FROM messages
              WHERE toField LIKE ?1 ESCAPE '\\' OR cc LIKE ?1 ESCAPE '\\' ORDER BY date DESC LIMIT 400",
        )?;
        let ql = q.to_lowercase();
        for row in stmt.query_map([&like], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })? {
            let (to, cc, date) = row?;
            let field = format!("{to}, {}", cc.unwrap_or_default());
            for p in text::parse_address_list(&field) {
                let matches = p.email.to_lowercase().contains(&ql)
                    || p.name.as_deref().unwrap_or("").to_lowercase().contains(&ql);
                if !matches {
                    continue;
                }
                let entry = merged.entry(p.email.to_lowercase()).or_insert((
                    p.name.clone(),
                    p.email.clone(),
                    0,
                    date,
                ));
                entry.2 += 1;
                entry.3 = entry.3.max(date);
                if entry.0.is_none() {
                    entry.0 = p.name.clone();
                }
            }
        }
        let mut list: Vec<_> = merged.into_values().collect();
        list.sort_by(|a, b| b.2.cmp(&a.2).then(b.3.cmp(&a.3)));
        Ok(list
            .into_iter()
            .take(limit)
            .map(|(name, email, _, _)| Contact {
                name: name.filter(|n| !n.is_empty() && *n != email),
                email,
            })
            .collect())
    }

    // ---- schedules -----------------------------------------------------------

    pub fn schedules(&self) -> Result<Vec<Schedule>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, accountId, kind, dueAt, state, subject, threadId, payload, error FROM mail_schedule ORDER BY dueAt ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Schedule {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    kind: r.get(2)?,
                    due_at: r.get(3)?,
                    state: r.get(4)?,
                    subject: r.get(5)?,
                    thread_id: r.get(6)?,
                    payload: r.get(7)?,
                    error: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn put_schedule(&self, s: &Schedule) -> Result<()> {
        self.conn.lock().execute(
            "INSERT OR REPLACE INTO mail_schedule (id, accountId, kind, dueAt, state, subject, threadId, payload, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![s.id, s.account_id, s.kind, s.due_at, s.state, s.subject, s.thread_id, s.payload, s.error],
        )?;
        Ok(())
    }

    pub fn delete_schedule(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("DELETE FROM mail_schedule WHERE id = ?", [id])?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Schedule {
    pub id: String,
    pub account_id: String,
    /// "send" or "snooze".
    pub kind: String,
    pub due_at: i64,
    /// "pending", "running" or "failed".
    pub state: String,
    pub subject: String,
    pub thread_id: Option<String>,
    pub payload: Option<String>,
    pub error: Option<String>,
}

/// A search over the cache: free text (FTS) and the filters the operators set.
#[derive(Clone, Debug, Default)]
pub struct LocalQuery {
    pub text: String,
    pub accounts: Vec<String>,
    pub label: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub unread: Option<bool>,
    pub starred: bool,
    pub important: bool,
    pub has_attachments: bool,
    pub after: Option<i64>,
    pub before: Option<i64>,
    /// Search spam and trash too (`in:anywhere`).
    pub anywhere: bool,
}

impl LocalQuery {
    fn clause(&self) -> (String, Vec<String>) {
        let mut parts = Vec::new();
        let mut args = Vec::new();
        let fts = to_fts_match(&self.text);
        if !fts.is_empty() {
            parts.push(
                "m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)"
                    .to_string(),
            );
            args.push(fts);
        }
        if !self.accounts.is_empty() {
            parts.push(format!(
                "m.accountId IN ({})",
                vec!["?"; self.accounts.len()].join(",")
            ));
            args.extend(self.accounts.iter().cloned());
        }
        let has_label = |label: &str, args: &mut Vec<String>| {
            args.push(label.to_string());
            "EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = ?)".to_string()
        };
        let spam_or_trash = matches!(self.label.as_deref(), Some("SPAM" | "TRASH"));
        if let Some(label) = &self.label {
            parts.push(has_label(label, &mut args));
        }
        if !spam_or_trash && !self.anywhere {
            parts.push(NOT_SPAM_TRASH.to_string());
        }
        if let Some(from) = &self.from {
            parts.push("(m.fromEmail LIKE ? ESCAPE '\\' OR m.fromName LIKE ? ESCAPE '\\')".into());
            let like = format!("%{}%", like_escape(from));
            args.push(like.clone());
            args.push(like);
        }
        if let Some(to) = &self.to {
            parts.push("(m.toField LIKE ? ESCAPE '\\' OR m.cc LIKE ? ESCAPE '\\')".into());
            let like = format!("%{}%", like_escape(to));
            args.push(like.clone());
            args.push(like);
        }
        if let Some(subject) = &self.subject {
            parts.push("m.subject LIKE ? ESCAPE '\\'".into());
            args.push(format!("%{}%", like_escape(subject)));
        }
        match self.unread {
            Some(true) => parts.push("m.unread = 1".into()),
            Some(false) => parts.push("m.unread = 0".into()),
            None => {}
        }
        if self.starred {
            parts.push("m.starred = 1".into());
        }
        if self.important {
            parts.push(has_label("IMPORTANT", &mut args));
        }
        if self.has_attachments {
            parts.push("m.hasAttachments = 1".into());
        }
        if let Some(after) = self.after {
            parts.push(format!("m.date >= {after}"));
        }
        if let Some(before) = self.before {
            parts.push(format!("m.date < {before}"));
        }
        if parts.is_empty() {
            parts.push("0".into());
        }
        (parts.join(" AND "), args)
    }
}

/// `foo bar` → `"foo" "bar"*`.
fn to_fts_match(q: &str) -> String {
    let tokens: Vec<String> = q
        .split_whitespace()
        .map(|t| t.replace('"', ""))
        .filter(|t| !t.is_empty())
        .collect();
    let n = tokens.len();
    tokens
        .into_iter()
        .enumerate()
        .map(|(i, t)| {
            if i + 1 == n {
                format!("\"{t}\"*")
            } else {
                format!("\"{t}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn rules_clause(rules: &[ViewRule]) -> (String, Vec<String>) {
    let mut args = Vec::new();
    let clauses: Vec<String> = rules
        .iter()
        .map(|rule| {
            let mut parts = vec!["m.accountId = ?".to_string()];
            args.push(rule.account_id.clone());
            for label in &rule.all_of {
                parts.push("EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId = ?)".into());
                args.push(label.clone());
            }
            if !rule.all_of.iter().any(|l| l == "SPAM" || l == "TRASH") {
                parts.push(NOT_SPAM_TRASH.into());
            }
            if !rule.none_of.is_empty() {
                parts.push(format!(
                    "NOT EXISTS (SELECT 1 FROM message_labels ml WHERE ml.accountId = m.accountId AND ml.messageId = m.id AND ml.labelId IN ({}))",
                    vec!["?"; rule.none_of.len()].join(",")
                ));
                args.extend(rule.none_of.iter().cloned());
            }
            format!("({})", parts.join(" AND "))
        })
        .collect();
    (format!("({})", clauses.join(" OR ")), args)
}

fn refresh_message_labels(tx: &rusqlite::Transaction, account: &str, id: &str) -> Result<()> {
    let labels: Vec<String> = {
        let mut stmt =
            tx.prepare("SELECT labelId FROM message_labels WHERE accountId = ? AND messageId = ?")?;
        stmt.query_map(params![account, id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    tx.execute(
        "UPDATE messages SET labelIds = ?, unread = ?, starred = ? WHERE accountId = ? AND id = ?",
        params![
            serde_json::to_string(&labels)?,
            labels.iter().any(|l| l == "UNREAD") as i64,
            labels.iter().any(|l| l == "STARRED") as i64,
            account,
            id
        ],
    )?;
    Ok(())
}

fn recompute_label_counts(
    tx: &rusqlite::Transaction,
    account: &str,
    label_ids: &[String],
) -> Result<()> {
    if label_ids.is_empty() {
        return Ok(());
    }
    for chunk in label_ids.chunks(200) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT ml.labelId, COUNT(*), COALESCE(SUM(m.unread), 0)
               FROM message_labels ml
               JOIN messages m ON m.accountId = ml.accountId AND m.id = ml.messageId
              WHERE ml.accountId = ? AND ml.labelId IN ({marks})
              GROUP BY ml.labelId"
        );
        let mut counts: HashMap<String, (i64, i64)> = HashMap::new();
        {
            let mut stmt = tx.prepare(&sql)?;
            let args = std::iter::once(account.to_string()).chain(chunk.iter().cloned());
            for row in stmt.query_map(params_from_iter(args), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })? {
                let (id, total, unread) = row?;
                counts.insert(id, (total, unread));
            }
        }
        for id in chunk {
            let (total, unread) = counts.get(id).copied().unwrap_or((0, 0));
            tx.execute(
                "UPDATE labels SET unread = ?, total = ? WHERE accountId = ? AND id = ?",
                params![unread, total, account, id],
            )?;
        }
    }
    Ok(())
}

const MESSAGE_COLUMNS: &str = "accountId, id, threadId, fromName, fromEmail, toField, subject, snippet, date, unread, starred, labelIds, cc, bodyHtml, bodyText, attachments, detailFetched, messageIdHeader, referencesHeader";

fn message_from_row(r: &Row) -> rusqlite::Result<Message> {
    let from_name: String = r.get(3)?;
    let from_email: String = r.get(4)?;
    let to_field: String = r.get(5)?;
    let labels: String = r.get(11)?;
    let label_ids: Vec<String> = serde_json::from_str(&labels).unwrap_or_default();
    let cc: Option<String> = r.get(12)?;
    let fetched = r.get::<_, i64>(16)? != 0;
    let attachments: Vec<StoredAttachment> = r
        .get::<_, Option<String>>(15)?
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default();
    Ok(Message {
        account_id: r.get(0)?,
        id: r.get(1)?,
        thread_id: r.get(2)?,
        from: Person {
            name: (!from_name.is_empty() && from_name != from_email).then_some(from_name),
            email: from_email,
        },
        to: text::parse_address_list(&to_field),
        cc: text::parse_address_list(cc.as_deref().unwrap_or("")),
        bcc: vec![],
        reply_to: vec![],
        subject: r.get(6)?,
        snippet: r.get(7)?,
        date: r.get(8)?,
        unread: r.get::<_, i64>(9)? != 0,
        starred: r.get::<_, i64>(10)? != 0,
        draft: label_ids.iter().any(|l| l == "DRAFT"),
        label_ids,
        body_html: if fetched { r.get(13)? } else { None },
        body_text: if fetched {
            r.get::<_, Option<String>>(14)?
                .or_else(|| Some(String::new()))
        } else {
            None
        },
        attachments: attachments
            .into_iter()
            .map(|a| Attachment {
                inline: a.content_id.is_some() && a.mime_type.starts_with("image/"),
                id: a.id,
                filename: a.filename,
                mime_type: a.mime_type,
                size: a.size,
                content_id: a.content_id,
            })
            .collect(),
        message_id_header: r.get(17)?,
        references: r.get(18)?,
        in_reply_to: None,
        list_unsubscribe: None,
        list_unsubscribe_post: None,
    })
}
