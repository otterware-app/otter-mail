//! Gmail: the API client, the sync that keeps the cache current (a first
//! fill, then the history feed), and the writes.
//!
//! A new mailbox starts its feed at the profile's history id, then fills the
//! cache (inbox first, resumable) while the feed keeps it current; when the
//! fill ends, the feed replays from where it started so nothing is missed.

pub mod api;
mod imap_fill;
pub mod parse;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use async_trait::async_trait;
use futures::{StreamExt as _, stream};
use parking_lot::Mutex;
use serde_json::Value;

use self::api::{GmailApi, status_of};
use crate::backend::Emitter;
use crate::config::StoredAccount;
use crate::google::GoogleAuth;
use crate::model::*;
use crate::paths::Paths;
use crate::provider::*;
use crate::store::{HistoryOp, Store, SyncState};

fn value_id(v: &Value) -> Option<String> {
    v["id"].as_str().map(String::from)
}

const LABEL_DETAIL_EVERY: Duration = Duration::from_secs(10 * 60);
const FETCH_CONCURRENCY: usize = 6;

pub struct GmailProvider {
    account: StoredAccount,
    api: GmailApi,
    store: Arc<Store>,
    #[allow(dead_code)]
    emitter: Emitter,
    google: Arc<GoogleAuth>,
    labels_refreshed: Mutex<Option<Instant>>,
    drafts_learned: Mutex<Option<Instant>>,
    attempted: Mutex<HashSet<String>>,
}

impl GmailProvider {
    pub fn new(
        account: StoredAccount,
        store: Arc<Store>,
        google: Arc<GoogleAuth>,
        emitter: Emitter,
        _paths: Paths,
    ) -> Self {
        GmailProvider {
            api: GmailApi::new(account.id.clone(), google.clone()),
            account,
            store,
            emitter,
            google,
            labels_refreshed: Mutex::new(None),
            drafts_learned: Mutex::new(None),
            attempted: Mutex::new(HashSet::new()),
        }
    }

    fn id(&self) -> &str {
        &self.account.id
    }

    fn kv(&self, key: &str) -> Option<String> {
        self.store
            .kv_get(&format!("{key}:{}", self.id()))
            .ok()
            .flatten()
            .filter(|v| !v.is_empty())
    }

    fn set_kv(&self, key: &str, value: Option<&str>) -> Result<()> {
        let key = format!("{key}:{}", self.id());
        match value {
            Some(v) => self.store.kv_set(&key, v),
            None => self.store.kv_delete(&key),
        }
    }

    /// Labels with their counts (one labels.get each), or just the names.
    async fn refresh_labels(&self, force: bool) -> Result<()> {
        let due = self
            .labels_refreshed
            .lock()
            .is_none_or(|t| t.elapsed() > LABEL_DETAIL_EVERY);
        let listed = self.api.labels().await?;
        let cached = self.store.labels(self.id())?;
        let same_names = listed.len() == cached.len()
            && listed.iter().all(|l| {
                cached.iter().any(|c| {
                    Some(c.id.as_str()) == l["id"].as_str()
                        && Some(c.name.as_str()) == l["name"].as_str()
                })
            });
        if !force && !due && same_names {
            return Ok(());
        }
        let ids: Vec<String> = listed.iter().filter_map(value_id).collect();
        let api = self.api.clone();
        let fetched: Vec<Result<Value>> = stream::iter(ids)
            .map(move |id| {
                let api = api.clone();
                async move { api.label(&id).await }
            })
            .buffer_unordered(8)
            .collect()
            .await;
        let details: Vec<Label> = fetched
            .into_iter()
            .filter_map(|r| r.ok())
            .filter_map(|v| parse::label(&self.account.id, &v))
            .collect();
        if !details.is_empty() {
            self.store.replace_labels(self.id(), &details)?;
            *self.labels_refreshed.lock() = Some(Instant::now());
        }
        Ok(())
    }

    /// Fetches messages (whole, so bodies come along) and writes them.
    async fn fetch_and_store(&self, ids: &[String], full: bool) -> Result<Vec<Message>> {
        let account = self.account.id.clone();
        let results: Vec<Result<Option<Message>>> = stream::iter(ids.iter().cloned())
            .map(|id| {
                let api = self.api.clone();
                let account = account.clone();
                async move {
                    let v = if full {
                        api.message_full(&id).await
                    } else {
                        api.message_metadata(&id).await
                    };
                    match v {
                        Ok(v) => Ok(if full {
                            parse::detail(&account, &v)
                        } else {
                            parse::summary(&account, &v)
                        }),
                        Err(err) if status_of(&err) == Some(404) => Ok(None),
                        Err(err) => Err(err),
                    }
                }
            })
            .buffer_unordered(FETCH_CONCURRENCY)
            .collect()
            .await;
        let mut messages = Vec::new();
        for r in results {
            if let Some(m) = r? {
                messages.push(m);
            }
        }
        if full {
            self.store.upsert_details(&messages)?;
        } else {
            self.store.upsert_summaries(&messages)?;
        }
        Ok(messages)
    }

    /// Starts (or restarts) the history feed at the mailbox's current id.
    async fn restart_feed(&self, refresh: bool) -> Result<String> {
        let profile = self.api.profile().await?;
        let history_id = profile["historyId"]
            .as_str()
            .map(String::from)
            .or_else(|| profile["historyId"].as_i64().map(|n| n.to_string()))
            .ok_or_else(|| anyhow!("no history id"))?;
        let mut state = self.store.sync_state(self.id())?;
        state.history_id = Some(history_id.clone());
        self.store.set_sync_state(self.id(), &state)?;
        self.set_kv("fullSyncSeed", Some(&history_id))?;
        self.set_kv("replayFrom", None)?;
        if refresh {
            self.set_kv("fullSyncRefresh", Some("1"))?;
        }
        Ok(history_id)
    }

    /// Applies the history feed since the last run.
    async fn incremental(&self, ctx: &SyncContext, history_id: &str) -> Result<()> {
        let replay = self.kv("replayFrom");
        let start = replay.clone().unwrap_or_else(|| history_id.to_string());
        let (records, latest) = match self.api.history(&start).await {
            Ok(r) => r,
            Err(err) if status_of(&err) == Some(404) => {
                log::info!("{}: history expired, refreshing the mailbox", self.id());
                self.restart_feed(true).await?;
                return Ok(());
            }
            Err(err) => return Err(err),
        };
        let mut added: Vec<String> = Vec::new();
        let mut ops = Vec::new();
        let strings = |v: &Value| -> Vec<String> {
            v.as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default()
        };
        for record in &records {
            for a in record["messagesAdded"].as_array().into_iter().flatten() {
                if let Some(id) = a["message"]["id"].as_str() {
                    if !added.iter().any(|x| x == id) {
                        added.push(id.to_string());
                    }
                }
            }
            for d in record["messagesDeleted"].as_array().into_iter().flatten() {
                if let Some(id) = d["message"]["id"].as_str() {
                    added.retain(|x| x != id);
                    ops.push(HistoryOp::Deleted { id: id.to_string() });
                }
            }
            for a in record["labelsAdded"].as_array().into_iter().flatten() {
                if let Some(id) = a["message"]["id"].as_str() {
                    ops.push(HistoryOp::LabelsAdded {
                        id: id.to_string(),
                        labels: strings(&a["labelIds"]),
                    });
                }
            }
            for r in record["labelsRemoved"].as_array().into_iter().flatten() {
                if let Some(id) = r["message"]["id"].as_str() {
                    ops.push(HistoryOp::LabelsRemoved {
                        id: id.to_string(),
                        labels: strings(&r["labelIds"]),
                    });
                }
            }
        }
        ctx.check()?;
        let unknown = self.store.apply_history(self.id(), &ops)?;
        let mut ids: Vec<String> = added.clone();
        for id in unknown {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        if replay.is_some() || !ids.is_empty() {
            ids = self.store.filter_unknown_ids(self.id(), &ids)?;
        }
        let fetched = self.fetch_and_store(&ids, true).await?;
        if !ops.is_empty() || !fetched.is_empty() {
            self.store.recount_labels(self.id())?;
            ctx.changed();
        }
        let mut state = self.store.sync_state(self.id())?;
        if let Some(latest) = latest {
            state.history_id = Some(latest);
        }
        self.store.set_sync_state(self.id(), &state)?;
        if replay.is_some() {
            self.set_kv("replayFrom", None)?;
        }
        let new: Vec<Message> = fetched
            .into_iter()
            .filter(|m| added.contains(&m.id))
            .filter(|m| m.unread && !m.from.email.eq_ignore_ascii_case(&self.account.email))
            .collect();
        ctx.new_mail(new);
        Ok(())
    }

    /// Learns which cached drafts are which Gmail drafts, and drops drafts
    /// deleted elsewhere.
    async fn learn_drafts(&self) -> Result<()> {
        let due = self
            .drafts_learned
            .lock()
            .is_none_or(|t| t.elapsed() > Duration::from_secs(600));
        let local = self.store.local_draft_rows(self.id())?;
        if !due || local.is_empty() {
            return Ok(());
        }
        let listed_at = chrono::Utc::now().timestamp_millis();
        let drafts = self.api.draft_ids().await?;
        for (draft_id, message_id) in &drafts {
            self.store.set_draft_id(self.id(), message_id, draft_id)?;
        }
        if drafts.len() < 500 {
            let listed: HashSet<&String> = drafts.iter().map(|(_, m)| m).collect();
            let gone: Vec<String> = local
                .into_iter()
                .filter(|(id, date)| !listed.contains(id) && *date < listed_at - 60_000)
                .map(|(id, _)| id)
                .collect();
            if !gone.is_empty() {
                self.store.delete_messages(self.id(), &gone)?;
            }
        }
        *self.drafts_learned.lock() = Some(Instant::now());
        Ok(())
    }

    /// Lists every id of a label (or all mail), page by page.
    async fn list_all(
        &self,
        label: Option<&str>,
        spam_trash: bool,
        mut on_page: impl FnMut(&[(String, String)]),
    ) -> Result<Vec<String>> {
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let (refs, next, _) = self
                .api
                .list_ids(label, None, page.as_deref(), 500, spam_trash)
                .await?;
            on_page(&refs);
            out.extend(refs.into_iter().map(|(id, _)| id));
            match next {
                Some(n) => page = Some(n),
                None => return Ok(out),
            }
        }
    }

    /// Fills a new mailbox through the API: the inbox first, then all mail.
    async fn fill_over_api(&self, ctx: &SyncContext) -> Result<()> {
        let profile = self.api.profile().await?;
        let total = profile["messagesTotal"].as_i64();
        let mut synced = 0i64;
        // Inbox first, so the list fills where the user looks.
        let mut page: Option<String> = None;
        loop {
            ctx.check()?;
            let (refs, next, _) = self
                .api
                .list_ids(Some("INBOX"), None, page.as_deref(), 100, false)
                .await?;
            let ids: Vec<String> = refs.into_iter().map(|(id, _)| id).collect();
            let unknown = self.store.filter_unknown_ids(self.id(), &ids)?;
            self.fetch_and_store(&unknown, false).await?;
            synced += ids.len() as i64;
            ctx.progress("full", synced, total);
            ctx.changed();
            match next {
                Some(n) => page = Some(n),
                None => break,
            }
        }
        let mut cursor = self.kv("fullSyncCursor");
        loop {
            ctx.check()?;
            let result = self
                .api
                .list_ids(None, None, cursor.as_deref(), 500, false)
                .await;
            let (refs, next, _) = match result {
                Ok(r) => r,
                Err(err) if status_of(&err) == Some(400) && cursor.is_some() => {
                    cursor = None;
                    self.set_kv("fullSyncCursor", None)?;
                    continue;
                }
                Err(err) => return Err(err),
            };
            let ids: Vec<String> = refs.into_iter().map(|(id, _)| id).collect();
            let unknown = self.store.filter_unknown_ids(self.id(), &ids)?;
            for chunk in unknown.chunks(100) {
                ctx.check()?;
                self.fetch_and_store(chunk, false).await?;
                ctx.changed();
            }
            synced += ids.len() as i64;
            ctx.progress("full", synced, total);
            match next {
                Some(n) => {
                    self.set_kv("fullSyncCursor", Some(&n))?;
                    cursor = Some(n);
                }
                None => break,
            }
        }
        Ok(())
    }

    fn finish_backfill(&self) -> Result<()> {
        let mut state = self.store.sync_state(self.id())?;
        state.full_sync_done = true;
        self.store.set_sync_state(self.id(), &state)?;
        if let Some(seed) = self.kv("fullSyncSeed") {
            self.set_kv("replayFrom", Some(&seed))?;
        }
        self.set_kv("fullSyncSeed", None)?;
        self.set_kv("fullSyncCursor", None)?;
        self.set_kv("fullSyncRefresh", None)?;
        self.store.recount_labels(self.id())?;
        Ok(())
    }

    /// After the history expired: brings the cache back in line with the mailbox.
    async fn refresh_mailbox(&self, ctx: &SyncContext) -> Result<()> {
        let cached_labels = self.store.labels(self.id())?;
        let all = self.list_all(None, true, |_| {}).await?;
        let all_set: HashSet<&String> = all.iter().collect();
        let mut ops = Vec::new();
        // Cached messages the mailbox no longer has.
        let rule = crate::store::ViewRule {
            account_id: self.id().to_string(),
            all_of: vec![],
            none_of: vec![],
        };
        let _ = rule;
        for label in &cached_labels {
            ctx.check()?;
            let listed = self
                .list_all(Some(&label.id), true, |_| {})
                .await
                .unwrap_or_default();
            if !listed.is_empty() {
                for id in &listed {
                    ops.push(HistoryOp::LabelsAdded {
                        id: id.clone(),
                        labels: vec![label.id.clone()],
                    });
                }
            }
        }
        self.store.apply_history(self.id(), &ops)?;
        let missing = self.store.filter_unknown_ids(self.id(), &all)?;
        for chunk in missing.chunks(100) {
            ctx.check()?;
            self.fetch_and_store(chunk, false).await?;
            ctx.changed();
        }
        let _ = all_set;
        self.finish_backfill()
    }

    async fn draft_id_for(&self, message_id: &str) -> Result<Option<String>> {
        if let Some(id) = self.store.draft_id_for_message(self.id(), message_id)? {
            return Ok(Some(id));
        }
        for (draft_id, mid) in self.api.draft_ids().await? {
            self.store.set_draft_id(self.id(), &mid, &draft_id)?;
            if mid == message_id {
                return Ok(Some(draft_id));
            }
        }
        Ok(None)
    }

    fn me(&self) -> Person {
        Person {
            name: Some(self.account.name.clone())
                .filter(|n| !n.is_empty() && *n != self.account.email),
            email: self.account.email.clone(),
        }
    }
}

#[async_trait]
impl Provider for GmailProvider {
    async fn sync(&self, ctx: &SyncContext) -> Result<()> {
        let mut state: SyncState = self.store.sync_state(self.id())?;
        if state.history_id.is_none() {
            ctx.progress("labels", 0, None);
            self.refresh_labels(true).await?;
            let seed = match self.kv("fullSyncSeed") {
                Some(seed) => seed,
                None => self.restart_feed(false).await?,
            };
            state.history_id = Some(seed);
            self.store.set_sync_state(self.id(), &state)?;
            ctx.changed();
        }
        let history_id = state.history_id.clone().unwrap_or_default();
        self.incremental(ctx, &history_id).await?;
        self.refresh_labels(false).await?;
        if let Err(err) = self.learn_drafts().await {
            log::info!("{}: learning drafts: {err:#}", self.id());
        }
        ctx.changed();
        Ok(())
    }

    fn needs_backfill(&self) -> bool {
        let state = self.store.sync_state(self.id()).unwrap_or_default();
        !state.full_sync_done
            || self.kv("fullSyncRefresh").as_deref() == Some("1")
            || self.kv("spamTrashBackfilled").as_deref() != Some("1")
    }

    async fn backfill(&self, ctx: &SyncContext) -> Result<()> {
        let state = self.store.sync_state(self.id())?;
        if self.kv("fullSyncRefresh").as_deref() == Some("1") {
            self.refresh_mailbox(ctx).await?;
        } else if !state.full_sync_done {
            let over_imap = match imap_fill::fill(&self.api, &self.store, ctx).await {
                Ok(()) => true,
                Err(err) if err.to_string() == "cancelled" => return Err(err),
                Err(err) => {
                    log::warn!(
                        "{}: filling over IMAP failed, using the API: {err:#}",
                        self.id()
                    );
                    false
                }
            };
            if !over_imap {
                self.fill_over_api(ctx).await?;
            }
            self.finish_backfill()?;
            if over_imap {
                self.set_kv("spamTrashBackfilled", Some("1"))?;
            }
            ctx.changed();
        }
        if self.kv("spamTrashBackfilled").as_deref() != Some("1") {
            for label in ["SPAM", "TRASH"] {
                ctx.check()?;
                let ids = self.list_all(Some(label), true, |_| {}).await?;
                let unknown = self.store.filter_unknown_ids(self.id(), &ids)?;
                for chunk in unknown.chunks(100) {
                    self.fetch_and_store(chunk, false).await?;
                }
            }
            self.set_kv("spamTrashBackfilled", Some("1"))?;
            ctx.changed();
        }
        Ok(())
    }

    async fn download_bodies(&self, ctx: &SyncContext) -> Result<bool> {
        let now = chrono::Utc::now().timestamp_millis();
        let attempted = self.attempted.lock().clone();
        let batch: Vec<(String, String)> = self
            .store
            .undownloaded(self.id(), 60 + attempted.len().min(500), now)?
            .into_iter()
            .filter(|(id, _)| !attempted.contains(id))
            .take(60)
            .collect();
        if batch.is_empty() {
            self.attempted.lock().clear();
            return Ok(false);
        }
        self.attempted
            .lock()
            .extend(batch.iter().map(|(id, _)| id.clone()));
        // Conversations with several messages come in one request.
        let mut threads: Vec<(String, Vec<String>)> = Vec::new();
        for (id, thread) in &batch {
            match threads.iter_mut().find(|(t, _)| t == thread) {
                Some((_, ids)) => ids.push(id.clone()),
                None => threads.push((thread.clone(), vec![id.clone()])),
            }
        }
        let account = self.account.id.clone();
        let results: Vec<(Vec<String>, Result<Vec<Message>>)> = stream::iter(threads)
            .map(|(thread, ids)| {
                let api = self.api.clone();
                let account = account.clone();
                async move {
                    let result = if ids.len() > 1 {
                        api.thread_full(&thread).await.map(|v| {
                            v["messages"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|m| parse::detail(&account, m))
                                .collect()
                        })
                    } else {
                        api.message_full(&ids[0])
                            .await
                            .map(|v| parse::detail(&account, &v).into_iter().collect())
                    };
                    (ids, result)
                }
            })
            .buffer_unordered(FETCH_CONCURRENCY)
            .collect()
            .await;
        let mut messages = Vec::new();
        for (ids, result) in results {
            match result {
                Ok(ms) => messages.extend(ms),
                Err(err) if status_of(&err) == Some(404) => {
                    self.store.delete_messages(self.id(), &ids)?;
                }
                Err(err) if status_of(&err) == Some(429) || api::is_offline(&err) => {
                    return Err(err);
                }
                Err(err) => {
                    if err.downcast_ref::<crate::google::SignInExpired>().is_some() {
                        return Err(err);
                    }
                    for id in &ids {
                        self.store.mark_body_failed(self.id(), id, now)?;
                    }
                }
            }
        }
        ctx.check()?;
        // Only what's still cached (the feed may have deleted some meanwhile).
        let unknown: HashSet<String> = self
            .store
            .filter_unknown_ids(
                self.id(),
                &messages.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
            )?
            .into_iter()
            .collect();
        messages.retain(|m| !unknown.contains(&m.id));
        self.store.upsert_details(&messages)?;
        Ok(true)
    }

    async fn fetch_thread(&self, thread_id: &str) -> Result<()> {
        let v = self.api.thread_full(thread_id).await?;
        let messages: Vec<Message> = v["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| parse::detail(self.id(), m))
            .collect();
        self.store.upsert_details(&messages)?;
        Ok(())
    }

    async fn fetch_message(&self, message_id: &str) -> Result<()> {
        let v = self.api.message_full(message_id).await?;
        if let Some(m) = parse::detail(self.id(), &v) {
            self.store.upsert_details(&[m])?;
        }
        Ok(())
    }

    async fn modify(&self, thread_id: &str, ids: &[String], action: &ThreadAction) -> Result<()> {
        let whole_thread = {
            let all = self.store.thread_message_ids(self.id(), thread_id)?;
            !all.is_empty() && all.len() == ids.len()
        } || ids.is_empty();
        match action {
            ThreadAction::DeleteForever => {
                self.api.batch_delete(ids).await?;
            }
            ThreadAction::Trash if whole_thread => self.api.trash_thread(thread_id).await?,
            ThreadAction::Untrash if whole_thread => self.api.untrash_thread(thread_id).await?,
            ThreadAction::Trash => {
                for id in ids {
                    self.api.trash_message(id).await?;
                }
            }
            ThreadAction::Untrash => {
                for id in ids {
                    self.api.untrash_message(id).await?;
                }
            }
            _ => {
                let (add, remove) = action.label_changes();
                if whole_thread {
                    self.api.modify_thread(thread_id, &add, &remove).await?;
                } else {
                    for id in ids {
                        self.api.modify_message(id, &add, &remove).await?;
                    }
                }
            }
        }
        if matches!(
            action,
            ThreadAction::Trash | ThreadAction::Untrash | ThreadAction::MoveToInbox
        ) {
            // Gmail decides what else changes; read it back.
            let _ = self.fetch_and_store(ids, false).await;
            self.store.recount_labels(self.id())?;
        }
        Ok(())
    }

    async fn send(&self, draft: &Draft) -> Result<()> {
        let raw = crate::mime::build(&self.me(), draft, true)?;
        let sent = self.api.send_raw(&raw, draft.thread_id.as_deref()).await?;
        if let Some(draft_id) = &draft.draft_id {
            if let Err(err) = self.api.delete_draft(draft_id).await {
                log::info!("deleting the sent draft: {err:#}");
            }
            let rows: Vec<String> = self
                .store
                .local_draft_rows(self.id())?
                .into_iter()
                .map(|(id, _)| id)
                .filter(|id| {
                    self.store
                        .draft_id_for_message(self.id(), id)
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some(draft_id)
                })
                .collect();
            self.store.delete_messages(self.id(), &rows)?;
        }
        if let Some(id) = sent["id"].as_str() {
            let _ = self.fetch_and_store(&[id.to_string()], true).await;
            self.store.recount_labels(self.id())?;
        }
        Ok(())
    }

    async fn save_draft(&self, draft: &Draft) -> Result<SavedDraft> {
        let raw = crate::mime::build(&self.me(), draft, true)?;
        let draft_id = match &draft.draft_id {
            Some(id) if id.starts_with('r') || !id.is_empty() => Some(id.clone()),
            _ => None,
        };
        let result = match self
            .api
            .save_draft(draft_id.as_deref(), &raw, draft.thread_id.as_deref())
            .await
        {
            Ok(v) => v,
            // Deleted elsewhere: start a new one.
            Err(err) if status_of(&err) == Some(404) && draft_id.is_some() => {
                self.api
                    .save_draft(None, &raw, draft.thread_id.as_deref())
                    .await?
            }
            Err(err) => return Err(err),
        };
        let new_draft_id = result["id"].as_str().unwrap_or_default().to_string();
        let message_id = result["message"]["id"].as_str().map(String::from);
        let thread_id = result["message"]["threadId"].as_str().map(String::from);
        // Older versions of this draft leave the cache.
        let stale: Vec<String> = self
            .store
            .local_draft_rows(self.id())?
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| Some(id) != message_id.as_ref())
            .filter(|id| {
                self.store
                    .draft_id_for_message(self.id(), id)
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(&new_draft_id)
            })
            .collect();
        self.store.delete_messages(self.id(), &stale)?;
        if let Some(mid) = &message_id {
            let _ = self.fetch_and_store(&[mid.clone()], true).await;
            self.store.set_draft_id(self.id(), mid, &new_draft_id)?;
            self.store.recount_labels(self.id())?;
        }
        Ok(SavedDraft {
            draft_id: new_draft_id,
            message_id,
            thread_id,
        })
    }

    async fn delete_draft(&self, draft_id: &str) -> Result<()> {
        // A message id (a draft opened from the list) or a draft id.
        let draft_id = if self.store.message(self.id(), draft_id)?.is_some() {
            self.draft_id_for(draft_id)
                .await?
                .unwrap_or_else(|| draft_id.to_string())
        } else {
            draft_id.to_string()
        };
        match self.api.delete_draft(&draft_id).await {
            Ok(()) => {}
            Err(err) if status_of(&err) == Some(404) => {}
            Err(err) => return Err(err),
        }
        let rows: Vec<String> = self
            .store
            .local_draft_rows(self.id())?
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| {
                *id == draft_id
                    || self
                        .store
                        .draft_id_for_message(self.id(), id)
                        .ok()
                        .flatten()
                        .as_deref()
                        == Some(&draft_id)
            })
            .collect();
        self.store.delete_messages(self.id(), &rows)?;
        Ok(())
    }

    async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>> {
        self.api.attachment(message_id, attachment_id).await
    }

    async fn search(&self, query: &str, page: Option<String>) -> Result<SearchPage> {
        let lower = query.to_ascii_lowercase();
        let spam_trash = [
            "in:spam",
            "in:trash",
            "in:anywhere",
            "label:spam",
            "label:trash",
        ]
        .iter()
        .any(|op| lower.contains(op));
        let (refs, next, estimate) = self
            .api
            .list_ids(None, Some(query), page.as_deref(), 50, spam_trash)
            .await?;
        let ids: Vec<String> = refs.iter().map(|(id, _)| id.clone()).collect();
        let unknown = self.store.filter_unknown_ids(self.id(), &ids)?;
        self.fetch_and_store(&unknown, false).await?;
        let mut threads: Vec<(String, String)> = Vec::new();
        for (_, thread) in refs {
            let r = (self.id().to_string(), thread);
            if !threads.contains(&r) {
                threads.push(r);
            }
        }
        Ok(SearchPage {
            refs: threads,
            next,
            estimate,
        })
    }

    async fn create_label(&self, name: &str) -> Result<Label> {
        let v = self.api.create_label(name).await?;
        parse::label(self.id(), &v).ok_or_else(|| anyhow!("Gmail didn't return the label"))
    }

    async fn update_label(
        &self,
        id: &str,
        name: Option<&str>,
        color: Option<(String, String)>,
    ) -> Result<()> {
        if let Some(name) = name {
            let labels = self.api.labels().await?;
            let old = labels
                .iter()
                .find(|l| l["id"].as_str() == Some(id))
                .and_then(|l| l["name"].as_str())
                .unwrap_or_default()
                .to_string();
            self.api
                .patch_label(id, serde_json::json!({"name": name}))
                .await?;
            for l in &labels {
                let (Some(lid), Some(lname)) = (l["id"].as_str(), l["name"].as_str()) else {
                    continue;
                };
                if l["type"].as_str() == Some("user")
                    && !old.is_empty()
                    && lname.starts_with(&format!("{old}/"))
                {
                    let renamed = format!("{name}{}", &lname[old.len()..]);
                    self.api
                        .patch_label(lid, serde_json::json!({"name": renamed}))
                        .await?;
                }
            }
        }
        if let Some((bg, fg)) = color {
            self.api
                .patch_label(
                    id,
                    serde_json::json!({"color": {"backgroundColor": bg, "textColor": fg}}),
                )
                .await?;
        }
        self.refresh_labels(true).await
    }

    async fn delete_label(&self, id: &str) -> Result<()> {
        self.api.delete_label(id).await
    }

    async fn empty_folder(&self, label_id: &str) -> Result<usize> {
        let mut ids = self.list_all(Some(label_id), true, |_| {}).await?;
        let rule = crate::store::ViewRule {
            account_id: self.id().to_string(),
            all_of: vec![label_id.to_string()],
            none_of: vec![],
        };
        let (rows, _) = self.store.threads_page(&[rule], 0, 100_000)?;
        for row in rows {
            for id in self.store.thread_message_ids(self.id(), &row.id)? {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        self.api.batch_delete(&ids).await?;
        self.store.delete_messages(self.id(), &ids)?;
        Ok(ids.len())
    }

    async fn unsubscribe_headers(
        &self,
        message_id: &str,
    ) -> Result<Option<(String, Option<String>)>> {
        let v = self
            .api
            .headers(message_id, &["List-Unsubscribe", "List-Unsubscribe-Post"])
            .await?;
        let m = parse::summary(self.id(), &v);
        Ok(m.and_then(|m| m.list_unsubscribe.map(|h| (h, m.list_unsubscribe_post))))
    }

    async fn send_raw(&self, mime: Vec<u8>) -> Result<()> {
        self.api.send_raw(&mime, None).await?;
        Ok(())
    }

    async fn signature(&self) -> Result<Option<String>> {
        let send_as = self.api.send_as().await?;
        let entry = send_as
            .iter()
            .find(|s| {
                s["sendAsEmail"]
                    .as_str()
                    .is_some_and(|e| e.eq_ignore_ascii_case(&self.account.email))
            })
            .or_else(|| {
                send_as
                    .iter()
                    .find(|s| s["isPrimary"].as_bool() == Some(true))
            });
        Ok(entry
            .and_then(|e| e["signature"].as_str())
            .map(String::from))
    }

    async fn set_signature(&self, signature: &str) -> Result<()> {
        self.api.set_signature(&self.account.email, signature).await
    }
}

impl GmailProvider {
    #[allow(dead_code)]
    pub fn google(&self) -> &Arc<GoogleAuth> {
        &self.google
    }
}
