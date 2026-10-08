//! The first sync over IMAP: every row of a new Gmail mailbox in seconds
//! (X-GM-MSGID, X-GM-THRID, X-GM-LABELS), before the API fills in snippets
//! and bodies. Falls back to the API when it fails.

use std::sync::Arc;

use anyhow::Result;

use super::api::GmailApi;
use crate::provider::SyncContext;
use crate::store::Store;

pub async fn fill(_api: &GmailApi, _store: &Arc<Store>, _ctx: &SyncContext) -> Result<()> {
    anyhow::bail!("IMAP fill not available yet")
}
