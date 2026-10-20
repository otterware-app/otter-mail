//! IMAP and SMTP mailboxes.

use std::sync::Arc;

use anyhow::Result;

use crate::config::{ImapSettings, StoredAccount};
use crate::provider::Provider;
use crate::secrets::Secrets;
use crate::store::Store;

pub fn provider(
    _account: StoredAccount,
    _store: Arc<Store>,
    _secrets: Arc<Secrets>,
) -> Option<Arc<dyn Provider>> {
    None
}

pub async fn check_login(_email: &str, _password: &str, _settings: &ImapSettings) -> Result<()> {
    anyhow::bail!("IMAP isn't available yet")
}
