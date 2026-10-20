//! The JSON files beside the cache, in the shapes the Electron app wrote them:
//! `accounts.json`, `settings.json`, `ui-preferences.json`, `views.json`.

use std::collections::BTreeMap;

use anyhow::Result;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::model::{Account, ProviderKind};
use crate::paths::{Paths, read_json, write_json};
use crate::store::ViewRule;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
    /// "tls" or "starttls".
    pub security: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImapSettings {
    pub username: String,
    pub imap: ServerSettings,
    pub smtp: ServerSettings,
}

/// One entry of `accounts.json`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap: Option<ImapSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_in_gmail: Option<bool>,
}

impl StoredAccount {
    pub fn provider(&self) -> ProviderKind {
        match self.provider.as_deref() {
            Some("imap") => ProviderKind::Imap,
            Some("demo") => ProviderKind::Demo,
            _ => ProviderKind::Gmail,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub sync_interval_seconds: u64,
    /// "off", "inbox" or "all".
    pub notifications_mode: String,
    pub launch_at_login: bool,
    pub dock_badge_enabled: bool,
    #[serde(default)]
    pub read_languages: Vec<String>,
    #[serde(default)]
    pub auto_translate: bool,
    #[serde(flatten)]
    pub other: BTreeMap<String, serde_json::Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            sync_interval_seconds: 30,
            notifications_mode: "inbox".into(),
            launch_at_login: false,
            dock_badge_enabled: false,
            read_languages: vec![],
            auto_translate: false,
            other: BTreeMap::new(),
        }
    }
}

/// `ui-preferences.json` → "mail:mailboxes": their order, which are off, and
/// whether "All mailboxes" is shown.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailboxArrangement {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub off: Vec<String>,
    #[serde(default = "yes")]
    pub combined: bool,
}

fn yes() -> bool {
    true
}

/// A view: a filter across mailboxes, a space in the rail.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MailView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub rules: Option<Vec<ViewRule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mailbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

pub struct Config {
    paths: Paths,
    pub accounts: RwLock<Vec<StoredAccount>>,
    pub settings: RwLock<AppSettings>,
    pub ui: RwLock<BTreeMap<String, String>>,
    pub views: RwLock<Vec<MailView>>,
    /// Keep everything in memory (the demo).
    ephemeral: bool,
}

impl Config {
    pub fn load(paths: &Paths) -> Config {
        Config {
            accounts: RwLock::new(read_json(&paths.file("accounts.json")).unwrap_or_default()),
            settings: RwLock::new(read_json(&paths.file("settings.json")).unwrap_or_default()),
            ui: RwLock::new(read_json(&paths.file("ui-preferences.json")).unwrap_or_default()),
            views: RwLock::new(read_json(&paths.file("views.json")).unwrap_or_default()),
            paths: paths.clone(),
            ephemeral: false,
        }
    }

    pub fn in_memory() -> Config {
        Config {
            paths: Paths::at(std::env::temp_dir(), true),
            accounts: RwLock::new(vec![]),
            settings: RwLock::new(AppSettings::default()),
            ui: RwLock::new(BTreeMap::new()),
            views: RwLock::new(vec![]),
            ephemeral: true,
        }
    }

    pub fn save_accounts(&self) -> Result<()> {
        if self.ephemeral {
            return Ok(());
        }
        write_json(&self.paths.file("accounts.json"), &*self.accounts.read())
    }

    pub fn save_settings(&self) -> Result<()> {
        if self.ephemeral {
            return Ok(());
        }
        write_json(&self.paths.file("settings.json"), &*self.settings.read())
    }

    pub fn save_ui(&self) -> Result<()> {
        if self.ephemeral {
            return Ok(());
        }
        write_json(&self.paths.file("ui-preferences.json"), &*self.ui.read())
    }

    pub fn save_views(&self) -> Result<()> {
        if self.ephemeral {
            return Ok(());
        }
        write_json(&self.paths.file("views.json"), &*self.views.read())
    }

    pub fn ui_get(&self, key: &str) -> Option<String> {
        self.ui.read().get(key).cloned()
    }

    pub fn ui_set(&self, key: &str, value: Option<String>) -> Result<()> {
        {
            let mut ui = self.ui.write();
            match value {
                Some(v) => {
                    ui.insert(key.to_string(), v);
                }
                None => {
                    ui.remove(key);
                }
            }
        }
        self.save_ui()
    }

    pub fn arrangement(&self) -> MailboxArrangement {
        self.ui_get("mail:mailboxes")
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or(MailboxArrangement {
                combined: true,
                ..Default::default()
            })
    }

    pub fn set_arrangement(&self, arrangement: &MailboxArrangement) -> Result<()> {
        self.ui_set("mail:mailboxes", Some(serde_json::to_string(arrangement)?))
    }

    /// The accounts as the app shows them: ordered, with their on/off state.
    pub fn account_list(&self, signed_out: &dyn Fn(&StoredAccount) -> bool) -> Vec<Account> {
        let arrangement = self.arrangement();
        let accounts = self.accounts.read();
        let mut list: Vec<Account> = accounts
            .iter()
            .map(|a| Account {
                id: a.id.clone(),
                email: a.email.clone(),
                name: (!a.name.is_empty()).then(|| a.name.clone()),
                display_name: a.display_name.clone(),
                color: a.color.clone(),
                picture: a.picture.clone(),
                provider: a.provider(),
                enabled: !arrangement.off.contains(&a.id),
                position: arrangement
                    .order
                    .iter()
                    .position(|id| *id == a.id)
                    .map(|p| p as i64)
                    .unwrap_or(i64::MAX),
                signature: a.signature.clone(),
                signed_out: signed_out(a),
            })
            .collect();
        list.sort_by_key(|a| a.position);
        for (i, a) in list.iter_mut().enumerate() {
            a.position = i as i64;
        }
        list
    }
}
