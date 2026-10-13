//! What a mail source does for the backend: Gmail (its API, plus IMAP for the
//! first sync), IMAP/SMTP, or the made-up demo. The backend keeps the cache
//! and the UI's state; a provider talks to the server.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use async_trait::async_trait;

use crate::backend::Emitter;
use crate::model::*;
use crate::store::Store;

/// A page of server search results: message refs, and the next page.
pub struct SearchPage {
    pub refs: Vec<(String, String)>,
    pub next: Option<String>,
    pub estimate: Option<i64>,
}

pub struct SavedDraft {
    pub draft_id: String,
    pub message_id: Option<String>,
    pub thread_id: Option<String>,
}

/// What a sync run can report while it works.
pub struct SyncContext {
    pub account_id: String,
    pub store: Arc<Store>,
    pub emitter: Emitter,
    cancelled: Arc<AtomicBool>,
}

impl SyncContext {
    pub fn new(
        account_id: String,
        store: Arc<Store>,
        emitter: Emitter,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        SyncContext {
            account_id,
            store,
            emitter,
            cancelled,
        }
    }

    /// Stops a run whose mailbox was removed meanwhile.
    pub fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            anyhow::bail!("cancelled");
        }
        Ok(())
    }

    pub fn progress(&self, phase: &str, synced: i64, total: Option<i64>) {
        self.emitter
            .progress(&self.account_id, phase, synced, total);
    }

    /// The cache changed: lists re-read.
    pub fn changed(&self) {
        self.emitter.mail_changed(Some(&self.account_id));
    }

    pub fn new_mail(&self, messages: Vec<Message>) {
        self.emitter.new_mail(&self.account_id, messages);
    }
}

#[async_trait]
pub trait Provider: Send + Sync {
    /// Brings the cache up to date: labels, new mail, changes elsewhere.
    async fn sync(&self, ctx: &SyncContext) -> Result<()>;

    /// Work after a sync (filling a new mailbox): runs while this is true.
    fn needs_backfill(&self) -> bool {
        false
    }

    async fn backfill(&self, _ctx: &SyncContext) -> Result<()> {
        Ok(())
    }

    /// Downloads bodies for offline reading, a batch per call; false when done.
    async fn download_bodies(&self, _ctx: &SyncContext) -> Result<bool> {
        Ok(false)
    }

    /// Whole messages of a conversation, bodies included, written to the cache.
    async fn fetch_thread(&self, thread_id: &str) -> Result<()>;

    /// One whole message, written to the cache.
    async fn fetch_message(&self, message_id: &str) -> Result<()>;

    /// Changes a conversation (or the given messages of it) on the server.
    async fn modify(
        &self,
        thread_id: &str,
        message_ids: &[String],
        action: &ThreadAction,
    ) -> Result<()>;

    async fn send(&self, draft: &Draft) -> Result<()>;

    async fn save_draft(&self, draft: &Draft) -> Result<SavedDraft>;

    async fn delete_draft(&self, draft_id: &str) -> Result<()>;

    async fn attachment(&self, message_id: &str, attachment_id: &str) -> Result<Vec<u8>>;

    /// Server search with the mailbox's own operators.
    async fn search(&self, query: &str, page: Option<String>) -> Result<SearchPage>;

    async fn create_label(&self, name: &str) -> Result<Label>;

    async fn update_label(
        &self,
        id: &str,
        name: Option<&str>,
        color: Option<(String, String)>,
    ) -> Result<()>;

    async fn delete_label(&self, id: &str) -> Result<()>;

    /// Deletes for good everything in Trash or Junk.
    async fn empty_folder(&self, label_id: &str) -> Result<usize>;

    /// List-Unsubscribe headers of a message, when it has them.
    async fn unsubscribe_headers(
        &self,
        _message_id: &str,
    ) -> Result<Option<(String, Option<String>)>> {
        Ok(None)
    }

    async fn send_raw(&self, _mime: Vec<u8>) -> Result<()> {
        anyhow::bail!("not supported")
    }

    /// The signature saved with the mailbox, if it keeps one.
    async fn signature(&self) -> Result<Option<String>> {
        Ok(None)
    }

    async fn set_signature(&self, _signature: &str) -> Result<()> {
        Ok(())
    }
}
