//! The backend the app drives: one per process, on its own tokio runtime so
//! syncing never holds up the UI. Writes are local first (the cache changes
//! at once, the server catches up); reads come from the cache.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context as _, Result, anyhow};
use futures::channel::{mpsc, oneshot};
use parking_lot::{Mutex, RwLock};

use crate::config::{AppSettings, Config, MailView, MailboxArrangement, StoredAccount};
use crate::demo_provider::DemoProvider;
use crate::model::*;
use crate::paths::Paths;
use crate::provider::{Provider, SyncContext};
use crate::secrets::{Sealer, Secrets};
use crate::store::{Contact, Schedule, Store, ViewRule};

/// What the backend tells the UI.
#[derive(Clone, Debug)]
pub enum Event {
    AccountsChanged,
    /// The cache changed (one mailbox, or any): lists and counts re-read.
    MailChanged {
        account_id: Option<String>,
    },
    SyncStatus(SyncStatus),
    /// A change made here didn't reach the server and was put back.
    WriteFailed {
        message: String,
    },
    SendFailed {
        subject: String,
        saved_to_drafts: bool,
    },
    /// New mail found by a sync (for notifications).
    NewMail {
        account_id: String,
        messages: Vec<Message>,
    },
    SchedulesChanged,
    SettingsChanged,
    /// A sign-in finished (or failed) in the browser.
    SignInFinished {
        result: Result<String, String>,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SyncStatus {
    pub account_id: String,
    pub syncing: bool,
    /// "idle", "labels", "full", "incremental", "downloads".
    pub phase: String,
    pub synced: i64,
    pub total: Option<i64>,
    pub last_sync_at: Option<i64>,
    pub error: Option<String>,
    pub revision: u64,
}

/// Fans events out to every subscriber.
#[derive(Clone)]
pub struct Emitter {
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<Event>>>>,
    status: Arc<Mutex<HashMap<String, SyncStatus>>>,
    revision: Arc<AtomicU64>,
}

impl Emitter {
    fn new() -> Self {
        Emitter {
            subscribers: Arc::new(Mutex::new(vec![])),
            status: Arc::new(Mutex::new(HashMap::new())),
            revision: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn emit(&self, event: Event) {
        self.subscribers
            .lock()
            .retain(|tx| tx.unbounded_send(event.clone()).is_ok());
    }

    pub fn mail_changed(&self, account_id: Option<&str>) {
        self.revision.fetch_add(1, Ordering::Relaxed);
        self.emit(Event::MailChanged {
            account_id: account_id.map(String::from),
        });
    }

    pub fn new_mail(&self, account_id: &str, messages: Vec<Message>) {
        if !messages.is_empty() {
            self.emit(Event::NewMail {
                account_id: account_id.to_string(),
                messages,
            });
        }
    }

    fn update_status(&self, account_id: &str, f: impl FnOnce(&mut SyncStatus)) {
        let status = {
            let mut all = self.status.lock();
            let status = all
                .entry(account_id.to_string())
                .or_insert_with(|| SyncStatus {
                    account_id: account_id.to_string(),
                    phase: "idle".into(),
                    ..Default::default()
                });
            f(status);
            status.revision = self.revision.load(Ordering::Relaxed);
            status.clone()
        };
        self.emit(Event::SyncStatus(status));
    }

    pub fn progress(&self, account_id: &str, phase: &str, synced: i64, total: Option<i64>) {
        self.update_status(account_id, |s| {
            s.phase = phase.to_string();
            s.synced = synced;
            s.total = total;
        });
    }
}

struct AccountRuntime {
    provider: Arc<dyn Provider>,
    cancelled: Arc<AtomicBool>,
    running: AtomicBool,
    rerun: AtomicBool,
    failures: Mutex<(u32, Option<Instant>)>,
    last_finished: Mutex<Option<Instant>>,
}

struct Inner {
    runtime: tokio::runtime::Runtime,
    paths: Paths,
    store: Arc<Store>,
    config: Arc<Config>,
    pub(crate) sealer: Arc<Sealer>,
    secrets: Arc<Secrets>,
    pub(crate) google: Arc<crate::google::GoogleAuth>,
    accounts: RwLock<HashMap<String, Arc<AccountRuntime>>>,
    emitter: Emitter,
    demo: bool,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

#[derive(Clone)]
pub struct Backend {
    inner: Arc<Inner>,
}

/// One conversation the user acts on.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ThreadRef {
    pub account_id: String,
    pub thread_id: String,
}

impl Backend {
    /// The app's backend over its data home.
    pub fn open(paths: Paths) -> Result<Backend> {
        let sealer = Arc::new(Sealer::new(&paths)?);
        Self::open_with_sealer(paths, sealer)
    }

    fn open_with_sealer(paths: Paths, sealer: Arc<Sealer>) -> Result<Backend> {
        paths.ensure()?;
        let store = Arc::new(Store::open(&paths.file("mail-cache.db"))?);
        let config = Arc::new(Config::load(&paths));
        let secrets = Arc::new(Secrets::load(&paths, sealer.clone())?);
        let google = Arc::new(crate::google::GoogleAuth::load(&paths, sealer.clone())?);
        // Open both files before migrating either: a missing key must never be
        // replaced just because the other file still contains legacy plain values.
        secrets.protect()?;
        google.protect()?;
        Ok(Self::build(
            paths, store, config, sealer, secrets, google, false,
        ))
    }

    /// The made-up mailboxes, in memory.
    pub fn demo() -> Result<Backend> {
        let paths = Paths::at(std::env::temp_dir().join("otter-mail-demo"), true);
        let store = Arc::new(Store::open_in_memory()?);
        let config = Arc::new(Config::in_memory());
        let now = chrono::Utc::now().timestamp_millis();
        let mut order = Vec::new();
        for mailbox in crate::demo::mailboxes(now) {
            store.replace_labels(&mailbox.account.id, &mailbox.labels)?;
            store.upsert_details(&mailbox.messages)?;
            store.recount_labels(&mailbox.account.id)?;
            order.push(mailbox.account.id.clone());
            config.accounts.write().push(StoredAccount {
                id: mailbox.account.id.clone(),
                email: mailbox.account.email.clone(),
                name: mailbox.account.name.clone().unwrap_or_default(),
                provider: Some("demo".into()),
                imap: None,
                picture: None,
                display_name: mailbox.account.display_name.clone(),
                color: mailbox.account.color.clone(),
                signature: mailbox.account.signature.clone(),
                signature_in_gmail: None,
            });
        }
        config.set_arrangement(&MailboxArrangement {
            order,
            off: vec![],
            combined: true,
        })?;
        let sealer = Arc::new(Sealer::plain());
        let secrets = Arc::new(Secrets::in_memory(sealer.clone()));
        let google = Arc::new(crate::google::GoogleAuth::empty(sealer.clone()));
        Ok(Self::build(
            paths, store, config, sealer, secrets, google, true,
        ))
    }

    fn build(
        paths: Paths,
        store: Arc<Store>,
        config: Arc<Config>,
        sealer: Arc<Sealer>,
        secrets: Arc<Secrets>,
        google: Arc<crate::google::GoogleAuth>,
        demo: bool,
    ) -> Backend {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("otter-backend")
            .enable_all()
            .build()
            .expect("tokio runtime");
        let backend = Backend {
            inner: Arc::new(Inner {
                runtime,
                paths,
                store,
                config,
                sealer,
                secrets,
                google,
                accounts: RwLock::new(HashMap::new()),
                emitter: Emitter::new(),
                demo,
                timer: Mutex::new(None),
            }),
        };
        backend.refresh_providers();
        backend
    }

    pub fn is_demo(&self) -> bool {
        self.inner.demo
    }

    pub fn paths(&self) -> &Paths {
        &self.inner.paths
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.inner.store
    }

    pub fn config(&self) -> &Arc<Config> {
        &self.inner.config
    }

    pub fn secrets(&self) -> &Arc<Secrets> {
        &self.inner.secrets
    }

    /// Runs `f` on the backend's runtime; the future resolves on any executor.
    pub fn spawn<T: Send + 'static, F: Future<Output = Result<T>> + Send + 'static>(
        &self,
        f: F,
    ) -> impl Future<Output = Result<T>> + use<T, F> {
        let (tx, rx) = oneshot::channel();
        self.inner.runtime.spawn(async move {
            let _ = tx.send(f.await);
        });
        async move { rx.await.map_err(|_| anyhow!("backend stopped"))? }
    }

    /// Runs blocking cache work off the runtime's async threads.
    pub fn blocking<T: Send + 'static, F: FnOnce(&Backend) -> Result<T> + Send + 'static>(
        &self,
        f: F,
    ) -> impl Future<Output = Result<T>> + use<T, F> {
        let backend = self.clone();
        self.spawn(async move {
            tokio::task::spawn_blocking(move || f(&backend))
                .await
                .map_err(|e| anyhow!("{e}"))?
        })
    }

    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded();
        self.inner.emitter.subscribers.lock().push(tx);
        rx
    }

    pub fn emitter(&self) -> &Emitter {
        &self.inner.emitter
    }

    // ---- accounts ------------------------------------------------------------

    pub fn accounts(&self) -> Vec<Account> {
        let google = &self.inner.google;
        self.inner.config.account_list(&|a| {
            a.provider() == ProviderKind::Gmail && !google.has_tokens(&a.id)
                || a.provider() == ProviderKind::Imap
                    && self
                        .inner
                        .secrets
                        .get(&format!("imap-password:{}", a.id))
                        .is_none()
        })
    }

    pub fn arrangement(&self) -> MailboxArrangement {
        self.inner.config.arrangement()
    }

    pub fn set_arrangement(&self, arrangement: MailboxArrangement) -> Result<()> {
        self.inner.config.set_arrangement(&arrangement)?;
        self.refresh_providers();
        self.inner.emitter.emit(Event::AccountsChanged);
        Ok(())
    }

    /// Makes a provider for each signed-in mailbox (and drops removed ones).
    pub(crate) fn refresh_providers(&self) {
        let accounts = self.inner.config.accounts.read().clone();
        let mut runtimes = self.inner.accounts.write();
        let ids: HashSet<String> = accounts.iter().map(|a| a.id.clone()).collect();
        runtimes.retain(|id, rt| {
            let keep = ids.contains(id);
            if !keep {
                rt.cancelled.store(true, Ordering::Relaxed);
            }
            keep
        });
        for stored in accounts {
            if runtimes.contains_key(&stored.id) {
                continue;
            }
            let provider: Option<Arc<dyn Provider>> = match stored.provider() {
                ProviderKind::Demo => {
                    let account = self
                        .inner
                        .config
                        .account_list(&|_| false)
                        .into_iter()
                        .find(|a| a.id == stored.id);
                    account.map(|account| {
                        Arc::new(DemoProvider {
                            account,
                            store: self.inner.store.clone(),
                        }) as Arc<dyn Provider>
                    })
                }
                ProviderKind::Gmail => Some(Arc::new(crate::gmail::GmailProvider::new(
                    stored.clone(),
                    self.inner.store.clone(),
                    self.inner.google.clone(),
                    self.inner.emitter.clone(),
                    self.inner.paths.clone(),
                )) as Arc<dyn Provider>),
                ProviderKind::Imap => crate::imap::provider(
                    stored.clone(),
                    self.inner.store.clone(),
                    self.inner.secrets.clone(),
                ),
            };
            if let Some(provider) = provider {
                runtimes.insert(
                    stored.id.clone(),
                    Arc::new(AccountRuntime {
                        provider,
                        cancelled: Arc::new(AtomicBool::new(false)),
                        running: AtomicBool::new(false),
                        rerun: AtomicBool::new(false),
                        failures: Mutex::new((0, None)),
                        last_finished: Mutex::new(None),
                    }),
                );
            }
        }
    }

    fn provider(&self, account_id: &str) -> Result<Arc<dyn Provider>> {
        self.inner
            .accounts
            .read()
            .get(account_id)
            .map(|rt| rt.provider.clone())
            .ok_or_else(|| anyhow!("{account_id} isn't signed in"))
    }

    pub fn update_account(
        &self,
        account_id: &str,
        display_name: Option<Option<String>>,
        color: Option<Option<String>>,
        signature: Option<String>,
    ) -> Result<()> {
        {
            let mut accounts = self.inner.config.accounts.write();
            let account = accounts
                .iter_mut()
                .find(|a| a.id == account_id)
                .ok_or_else(|| anyhow!("no such mailbox"))?;
            if let Some(name) = display_name {
                account.display_name = name.filter(|n| !n.trim().is_empty());
            }
            if let Some(color) = color {
                account.color = color;
            }
            if let Some(signature) = &signature {
                account.signature = Some(signature.clone());
            }
        }
        self.inner.config.save_accounts()?;
        if let Some(signature) = signature {
            if let Ok(provider) = self.provider(account_id) {
                let emitter = self.inner.emitter.clone();
                self.inner.runtime.spawn(async move {
                    if let Err(err) = provider.set_signature(&signature).await {
                        emitter.emit(Event::WriteFailed {
                            message: format!("Couldn't save the signature: {err}"),
                        });
                    }
                });
            }
        }
        self.inner.emitter.emit(Event::AccountsChanged);
        Ok(())
    }

    pub fn remove_account(&self, account_id: &str) -> Result<()> {
        self.inner
            .config
            .accounts
            .write()
            .retain(|a| a.id != account_id);
        self.inner.config.save_accounts()?;
        let mut arrangement = self.inner.config.arrangement();
        arrangement.order.retain(|id| id != account_id);
        arrangement.off.retain(|id| id != account_id);
        self.inner.config.set_arrangement(&arrangement)?;
        self.inner.google.remove(account_id)?;
        self.inner
            .secrets
            .set(&format!("imap-password:{account_id}"), None)?;
        self.refresh_providers();
        self.inner.store.remove_account_data(account_id)?;
        self.inner.emitter.emit(Event::AccountsChanged);
        self.inner.emitter.mail_changed(None);
        Ok(())
    }

    /// Adds (or updates) a mailbox entry and starts syncing it.
    pub(crate) fn add_stored_account(&self, account: StoredAccount) -> Result<()> {
        {
            let mut accounts = self.inner.config.accounts.write();
            match accounts.iter_mut().find(|a| a.id == account.id) {
                Some(existing) => {
                    existing.name = account.name;
                    existing.picture = account.picture.or(existing.picture.take());
                    existing.imap = account.imap.or(existing.imap.take());
                }
                None => accounts.push(account.clone()),
            }
        }
        self.inner.config.save_accounts()?;
        let mut arrangement = self.inner.config.arrangement();
        if !arrangement.order.contains(&account.id) {
            arrangement.order.push(account.id.clone());
            self.inner.config.set_arrangement(&arrangement)?;
        }
        // A fresh provider, with the new credentials.
        if let Some(rt) = self.inner.accounts.write().remove(&account.id) {
            rt.cancelled.store(true, Ordering::Relaxed);
        }
        self.refresh_providers();
        self.inner.emitter.emit(Event::AccountsChanged);
        self.sync_account(&account.id, true);
        Ok(())
    }

    /// Opens Google's sign-in in the browser; `SignInFinished` reports the end.
    pub fn add_gmail_account(&self, login_hint: Option<String>) {
        let backend = self.clone();
        self.inner.runtime.spawn(async move {
            let result = async {
                let profile = backend.inner.google.sign_in(login_hint).await?;
                backend.add_stored_account(StoredAccount {
                    id: profile.email.clone(),
                    email: profile.email.clone(),
                    name: profile
                        .name
                        .clone()
                        .unwrap_or_else(|| profile.email.clone()),
                    provider: None,
                    imap: None,
                    picture: profile.picture.clone(),
                    display_name: None,
                    color: None,
                    signature: None,
                    signature_in_gmail: None,
                })?;
                Ok::<_, anyhow::Error>(profile.email)
            }
            .await;
            backend.inner.emitter.emit(Event::SignInFinished {
                result: result.map_err(|e| format!("{e:#}")),
            });
        });
    }

    pub fn cancel_sign_in(&self) {
        self.inner.google.cancel_sign_in();
    }

    /// Adds a mailbox signed in with a refresh token (development's demo mailboxes).
    pub fn add_gmail_with_refresh_token(&self, email: &str, refresh_token: &str) -> Result<()> {
        let email = email.to_string();
        if self.inner.google.has_tokens(&email) {
            return Ok(());
        }
        self.inner
            .google
            .store_refresh_token(&email, refresh_token)?;
        self.add_stored_account(StoredAccount {
            id: email.clone(),
            email: email.clone(),
            name: email.clone(),
            provider: None,
            imap: None,
            picture: None,
            display_name: None,
            color: None,
            signature: None,
            signature_in_gmail: None,
        })
    }

    pub async fn add_imap_account(
        &self,
        email: String,
        password: String,
        name: Option<String>,
        settings: crate::config::ImapSettings,
    ) -> Result<()> {
        let id = email.to_lowercase();
        crate::imap::check_login(&email, &password, &settings).await?;
        self.inner
            .secrets
            .set(&format!("imap-password:{id}"), Some(&password))?;
        self.add_stored_account(StoredAccount {
            id: id.clone(),
            email: email.clone(),
            name: name.unwrap_or_else(|| email.clone()),
            provider: Some("imap".into()),
            imap: Some(settings),
            picture: None,
            display_name: None,
            color: None,
            signature: None,
            signature_in_gmail: None,
        })
    }

    // ---- settings ----------------------------------------------------------------

    pub fn settings(&self) -> AppSettings {
        self.inner.config.settings.read().clone()
    }

    pub fn set_settings(&self, settings: AppSettings) -> Result<()> {
        let interval_changed = self.inner.config.settings.read().sync_interval_seconds
            != settings.sync_interval_seconds;
        *self.inner.config.settings.write() = settings;
        self.inner.config.save_settings()?;
        if interval_changed {
            self.start_auto_sync();
        }
        self.inner.emitter.emit(Event::SettingsChanged);
        Ok(())
    }

    pub fn ui_pref(&self, key: &str) -> Option<String> {
        self.inner.config.ui_get(key)
    }

    pub fn set_ui_pref(&self, key: &str, value: Option<String>) {
        if let Err(err) = self.inner.config.ui_set(key, value) {
            log::warn!("couldn't save {key}: {err}");
        }
    }

    pub fn views(&self) -> Vec<MailView> {
        self.inner.config.views.read().clone()
    }

    pub fn save_views(&self, views: Vec<MailView>) -> Result<()> {
        *self.inner.config.views.write() = views;
        self.inner.config.save_views()
    }

    // ---- reading -------------------------------------------------------------------

    pub fn labels(&self, account_id: &str) -> Result<Vec<Label>> {
        self.inner.store.labels(account_id)
    }

    /// The cache's rules for a mailbox list.
    pub fn rules(&self, mailbox: &Mailbox) -> Vec<ViewRule> {
        let accounts: Vec<String> = match &mailbox.scope {
            Scope::All => self
                .accounts()
                .into_iter()
                .filter(|a| a.enabled)
                .map(|a| a.id)
                .collect(),
            Scope::Account(id) => vec![id.clone()],
        };
        let all_of = match &mailbox.folder {
            Folder::System(SystemFolder::All) => vec![],
            Folder::System(f) => vec![f.label_id().to_string()],
            Folder::Label(id) => vec![id.clone()],
            Folder::Search(_) => return vec![],
        };
        accounts
            .into_iter()
            .map(|account_id| ViewRule {
                account_id,
                all_of: all_of.clone(),
                none_of: vec![],
            })
            .collect()
    }

    pub fn threads(
        &self,
        mailbox: &Mailbox,
        offset: usize,
        limit: usize,
    ) -> Result<(Vec<ThreadSummary>, bool)> {
        self.inner
            .store
            .threads_page(&self.rules(mailbox), offset, limit)
    }

    /// Conversations and unread conversations in a mailbox list.
    pub fn counts(&self, mailbox: &Mailbox) -> Result<(i64, i64)> {
        self.inner
            .store
            .count_threads_by_rules(&self.rules(mailbox))
    }

    /// A conversation from the cache, bodies fetched first when missing.
    pub async fn thread(&self, account_id: String, thread_id: String) -> Result<Thread> {
        let store = self.inner.store.clone();
        let cached = store.thread_messages(&account_id, &thread_id)?;
        if cached.is_empty() || cached.iter().any(|m| !m.has_body()) {
            let provider = self.provider(&account_id)?;
            let fetch = {
                let thread_id = thread_id.clone();
                let ids: Vec<String> = cached
                    .iter()
                    .filter(|m| !m.has_body())
                    .map(|m| m.id.clone())
                    .collect();
                let single = cached.len() == 1;
                self.spawn(async move {
                    if single && !ids.is_empty() {
                        provider.fetch_message(&ids[0]).await
                    } else {
                        provider.fetch_thread(&thread_id).await
                    }
                })
            };
            if let Err(err) = fetch.await {
                log::warn!("couldn't fetch {thread_id}: {err:#}");
                if cached.is_empty() {
                    return Err(err);
                }
            }
        }
        let messages = store.thread_messages(&account_id, &thread_id)?;
        let mut label_ids: Vec<String> = Vec::new();
        for m in &messages {
            for l in &m.label_ids {
                if !label_ids.contains(l) {
                    label_ids.push(l.clone());
                }
            }
        }
        Ok(Thread {
            subject: messages
                .first()
                .map(|m| m.subject.clone())
                .unwrap_or_default(),
            account_id,
            id: thread_id,
            messages,
            label_ids,
        })
    }

    pub async fn attachment(
        &self,
        account_id: String,
        message_id: String,
        attachment_id: String,
    ) -> Result<Vec<u8>> {
        let cache_dir = self.inner.paths.file("attachment-cache");
        let key = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(format!(
                "{account_id}:{message_id}:{attachment_id}"
            )))
        };
        let path = cache_dir.join(key);
        if let Ok(bytes) = std::fs::read(&path) {
            return Ok(bytes);
        }
        let provider = self.provider(&account_id)?;
        let bytes = self
            .spawn(async move { provider.attachment(&message_id, &attachment_id).await })
            .await?;
        if !self.inner.demo {
            let _ = std::fs::create_dir_all(&cache_dir);
            let _ = std::fs::write(&path, &bytes);
        }
        Ok(bytes)
    }

    pub fn suggest_contacts(&self, q: &str, limit: usize) -> Result<Vec<Contact>> {
        self.inner.store.suggest_contacts(q, limit)
    }

    /// Searches every mailbox in `accounts`: Gmail on the server, the rest in
    /// the cache. Returns conversation rows (newest first) and the next cursors.
    pub async fn search(
        &self,
        query: String,
        accounts: Vec<String>,
        cursors: HashMap<String, Option<String>>,
    ) -> Result<(Vec<ThreadSummary>, HashMap<String, Option<String>>)> {
        let mut refs: Vec<(String, String)> = Vec::new();
        let mut next = HashMap::new();
        let mut failures = 0;
        for account in &accounts {
            let cursor = cursors.get(account).cloned().flatten();
            if cursors.contains_key(account) && cursor.is_none() {
                continue;
            }
            let Ok(provider) = self.provider(account) else {
                continue;
            };
            let q = query.clone();
            match self
                .spawn(async move { provider.search(&q, cursor).await })
                .await
            {
                Ok(page) => {
                    for r in page.refs {
                        if !refs.contains(&r) {
                            refs.push(r);
                        }
                    }
                    next.insert(account.clone(), page.next);
                }
                Err(err) => {
                    failures += 1;
                    log::warn!("search in {account} failed: {err:#}");
                    next.insert(account.clone(), None);
                }
            }
        }
        if failures == accounts.len() && !accounts.is_empty() {
            // Offline: search the cache.
            let mut rows = Vec::new();
            for account in &accounts {
                let q = crate::search::parse_query(&query, account);
                rows.extend(self.inner.store.search_threads(&q, 0, 50)?.0);
            }
            rows.sort_by(|a, b| b.date.cmp(&a.date));
            return Ok((rows, HashMap::new()));
        }
        let mut rows = self.inner.store.thread_summaries(&refs)?;
        rows.sort_by(|a, b| b.date.cmp(&a.date));
        Ok((rows, next))
    }

    // ---- changing mail ---------------------------------------------------------------

    /// Applies an action to conversations: in the cache now, on the server
    /// next. A server failure puts the cache back and reports `WriteFailed`.
    pub fn act(&self, refs: Vec<ThreadRef>, action: ThreadAction) -> Result<()> {
        let store = &self.inner.store;
        let (add, remove) = action.label_changes();
        let mut work = Vec::new();
        for r in &refs {
            let mut ids = store.thread_message_ids(&r.account_id, &r.thread_id)?;
            if matches!(action, ThreadAction::DeleteForever) {
                // Only what's in Trash or Junk goes for good.
                ids.retain(|id| {
                    store
                        .message(&r.account_id, id)
                        .ok()
                        .flatten()
                        .is_some_and(|m| m.label_ids.iter().any(|l| l == "TRASH" || l == "SPAM"))
                });
                store.delete_messages(&r.account_id, &ids)?;
            } else {
                store.begin_pending(&r.account_id, &ids, &add, &remove);
                store.apply_label_change(&r.account_id, &ids, &add, &remove)?;
            }
            work.push((r.clone(), ids));
        }
        self.inner.emitter.mail_changed(None);
        let backend = self.clone();
        self.inner.runtime.spawn(async move {
            for (r, ids) in work {
                let result = match backend.provider(&r.account_id) {
                    Ok(provider) => provider.modify(&r.thread_id, &ids, &action).await,
                    Err(err) => Err(err),
                };
                let store = &backend.inner.store;
                match result {
                    Ok(()) => store.settle_pending(&r.account_id, &ids),
                    Err(err) => {
                        log::warn!("{action:?} on {} failed: {err:#}", r.thread_id);
                        store.drop_pending(&r.account_id, &ids);
                        if !matches!(action, ThreadAction::DeleteForever) {
                            let _ = store.apply_label_change(&r.account_id, &ids, &remove, &add);
                        }
                        backend.inner.emitter.mail_changed(Some(&r.account_id));
                        backend.inner.emitter.emit(Event::WriteFailed {
                            message: format!(
                                "Couldn't update the conversation: {}",
                                short_error(&err)
                            ),
                        });
                    }
                }
            }
        });
        Ok(())
    }

    /// Marks single messages read or unread (opening a conversation).
    pub fn mark_messages(&self, account_id: &str, ids: Vec<String>, read: bool) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let store = &self.inner.store;
        let (add, remove): (Vec<String>, Vec<String>) = if read {
            (vec![], vec!["UNREAD".into()])
        } else {
            (vec!["UNREAD".into()], vec![])
        };
        store.begin_pending(account_id, &ids, &add, &remove);
        store.apply_label_change(account_id, &ids, &add, &remove)?;
        self.inner.emitter.mail_changed(Some(account_id));
        let backend = self.clone();
        let account_id = account_id.to_string();
        self.inner.runtime.spawn(async move {
            let action = if read {
                ThreadAction::MarkRead
            } else {
                ThreadAction::MarkUnread
            };
            let Ok(provider) = backend.provider(&account_id) else {
                return;
            };
            let thread_id = backend
                .inner
                .store
                .message(&account_id, &ids[0])
                .ok()
                .flatten()
                .map(|m| m.thread_id)
                .unwrap_or_default();
            match provider.modify(&thread_id, &ids, &action).await {
                Ok(()) => backend.inner.store.settle_pending(&account_id, &ids),
                Err(err) => {
                    backend.inner.store.drop_pending(&account_id, &ids);
                    let _ =
                        backend
                            .inner
                            .store
                            .apply_label_change(&account_id, &ids, &remove, &add);
                    backend.inner.emitter.mail_changed(Some(&account_id));
                    log::warn!("marking read failed: {err:#}");
                }
            }
        });
        Ok(())
    }

    pub async fn create_label(&self, account_id: String, name: String) -> Result<Label> {
        let provider = self.provider(&account_id)?;
        let label = self
            .spawn(async move { provider.create_label(&name).await })
            .await?;
        self.inner.store.put_label(&label)?;
        self.inner.emitter.mail_changed(Some(&account_id));
        Ok(label)
    }

    pub async fn rename_label(&self, account_id: String, label: Label, name: String) -> Result<()> {
        let provider = self.provider(&account_id)?;
        let store = self.inner.store.clone();
        // Children follow their parent's new name.
        let old = label.name.clone();
        for l in store.labels(&account_id)? {
            if l.id == label.id || l.name.starts_with(&format!("{old}/")) {
                let mut renamed = l.clone();
                renamed.name = format!("{name}{}", &l.name[old.len()..]);
                store.put_label(&renamed)?;
            }
        }
        self.inner.emitter.mail_changed(Some(&account_id));
        let id = label.id.clone();
        self.spawn(async move { provider.update_label(&id, Some(&name), None).await })
            .await
    }

    pub async fn set_label_color(
        &self,
        account_id: String,
        label: Label,
        color: Option<(String, String)>,
    ) -> Result<()> {
        let provider = self.provider(&account_id)?;
        let mut updated = label.clone();
        updated.background_color = color.as_ref().map(|c| c.0.clone());
        updated.text_color = color.as_ref().map(|c| c.1.clone());
        self.inner.store.put_label(&updated)?;
        self.inner.emitter.mail_changed(Some(&account_id));
        let id = label.id.clone();
        self.spawn(async move { provider.update_label(&id, None, color).await })
            .await
    }

    pub async fn delete_label(&self, account_id: String, label_id: String) -> Result<()> {
        let provider = self.provider(&account_id)?;
        self.inner.store.delete_label(&account_id, &label_id)?;
        self.inner.emitter.mail_changed(Some(&account_id));
        self.spawn(async move { provider.delete_label(&label_id).await })
            .await
    }

    pub async fn empty_folder(&self, account_id: String, label_id: String) -> Result<usize> {
        let provider = self.provider(&account_id)?;
        let n = self
            .spawn(async move { provider.empty_folder(&label_id).await })
            .await?;
        self.inner.store.recount_labels(&account_id)?;
        self.inner.emitter.mail_changed(Some(&account_id));
        Ok(n)
    }

    // ---- composing ---------------------------------------------------------------------

    pub async fn save_draft(&self, draft: Draft) -> Result<crate::provider::SavedDraft> {
        let provider = self.provider(&draft.account_id)?;
        let account_id = draft.account_id.clone();
        let saved = self
            .spawn(async move { provider.save_draft(&draft).await })
            .await?;
        self.inner.emitter.mail_changed(Some(&account_id));
        Ok(saved)
    }

    pub async fn delete_draft(&self, account_id: String, draft_id: String) -> Result<()> {
        let provider = self.provider(&account_id)?;
        self.spawn(async move { provider.delete_draft(&draft_id).await })
            .await?;
        self.inner.emitter.mail_changed(Some(&account_id));
        Ok(())
    }

    /// Sends now. A failure that comes after the message left is reported as
    /// `SendFailed` (and the message is saved to Drafts).
    pub async fn send(&self, draft: Draft) -> Result<()> {
        let provider = self.provider(&draft.account_id)?;
        let account_id = draft.account_id.clone();
        let backend = self.clone();
        self.spawn(async move {
            let result = provider.send(&draft).await;
            if let Err(err) = &result {
                log::warn!("send failed: {err:#}");
                let saved = provider.save_draft(&draft).await.is_ok();
                backend.inner.emitter.emit(Event::SendFailed {
                    subject: draft.subject.clone(),
                    saved_to_drafts: saved,
                });
            }
            result
        })
        .await?;
        self.inner.emitter.mail_changed(Some(&account_id));
        // Pick the sent message up.
        self.sync_account(&account_id, true);
        Ok(())
    }

    /// Sends later (this device keeps the queue while the app runs).
    pub fn schedule_send(&self, draft: Draft, due_at: i64) -> Result<()> {
        self.inner.store.put_schedule(&Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: draft.account_id.clone(),
            kind: "send".into(),
            due_at,
            state: "pending".into(),
            subject: draft.subject.clone(),
            thread_id: draft.thread_id.clone(),
            payload: Some(serde_json::to_string(&draft)?),
            error: None,
        })?;
        self.inner.emitter.emit(Event::SchedulesChanged);
        Ok(())
    }

    /// Takes a conversation out of the Inbox until `due_at`.
    pub fn snooze(&self, r: ThreadRef, due_at: i64, subject: String) -> Result<()> {
        let store = &self.inner.store;
        let ids: Vec<String> = store
            .thread_message_ids(&r.account_id, &r.thread_id)?
            .into_iter()
            .filter(|id| {
                store
                    .message(&r.account_id, id)
                    .ok()
                    .flatten()
                    .is_some_and(|m| m.label_ids.iter().any(|l| l == "INBOX"))
            })
            .collect();
        store.put_schedule(&Schedule {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: r.account_id.clone(),
            kind: "snooze".into(),
            due_at,
            state: "pending".into(),
            subject,
            thread_id: Some(r.thread_id.clone()),
            payload: Some(serde_json::to_string(&ids)?),
            error: None,
        })?;
        self.act(vec![r], ThreadAction::Archive)?;
        self.inner.emitter.emit(Event::SchedulesChanged);
        Ok(())
    }

    pub fn schedules(&self) -> Result<Vec<Schedule>> {
        self.inner.store.schedules()
    }

    /// Cancels a scheduled send (back to Drafts) or wakes a snooze now.
    pub fn cancel_schedule(&self, id: &str) -> Result<()> {
        let Some(schedule) = self
            .inner
            .store
            .schedules()?
            .into_iter()
            .find(|s| s.id == id)
        else {
            return Ok(());
        };
        self.inner.store.delete_schedule(id)?;
        let backend = self.clone();
        self.inner.runtime.spawn(async move {
            if let Err(err) = backend.finish_schedule(&schedule, true).await {
                log::warn!("cancelling a schedule: {err:#}");
            }
        });
        self.inner.emitter.emit(Event::SchedulesChanged);
        Ok(())
    }

    async fn finish_schedule(&self, schedule: &Schedule, cancelled: bool) -> Result<()> {
        match schedule.kind.as_str() {
            "send" => {
                let draft: Draft =
                    serde_json::from_str(schedule.payload.as_deref().unwrap_or("{}"))?;
                let provider = self.provider(&schedule.account_id)?;
                if cancelled {
                    provider.save_draft(&draft).await?;
                } else {
                    provider.send(&draft).await?;
                }
            }
            _ => {
                let ids: Vec<String> =
                    serde_json::from_str(schedule.payload.as_deref().unwrap_or("[]"))?;
                if let Some(thread_id) = &schedule.thread_id {
                    let store = &self.inner.store;
                    let add = vec!["INBOX".to_string()];
                    store.apply_label_change(&schedule.account_id, &ids, &add, &[])?;
                    let provider = self.provider(&schedule.account_id)?;
                    provider
                        .modify(thread_id, &ids, &ThreadAction::MoveToInbox)
                        .await?;
                }
            }
        }
        self.inner.emitter.mail_changed(Some(&schedule.account_id));
        Ok(())
    }

    /// Runs what's due in the send-later and snooze queue.
    async fn process_schedules(&self) {
        let Ok(schedules) = self.inner.store.schedules() else {
            return;
        };
        let now = chrono::Utc::now().timestamp_millis();
        for mut s in schedules {
            if s.state != "pending" || s.due_at > now {
                continue;
            }
            s.state = "running".into();
            let _ = self.inner.store.put_schedule(&s);
            match self.finish_schedule(&s, false).await {
                Ok(()) => {
                    let _ = self.inner.store.delete_schedule(&s.id);
                }
                Err(err) => {
                    s.state = "failed".into();
                    s.error = Some(short_error(&err));
                    let _ = self.inner.store.put_schedule(&s);
                }
            }
            self.inner.emitter.emit(Event::SchedulesChanged);
        }
    }

    // ---- syncing ---------------------------------------------------------------------------

    /// Starts the background work: auto-sync, the schedule queue, a first sync.
    pub fn start(&self) {
        // Rows interrupted mid-run last time are failures now.
        if let Ok(schedules) = self.inner.store.schedules() {
            for mut s in schedules.into_iter().filter(|s| s.state == "running") {
                s.state = "failed".into();
                s.error = Some("Interrupted while processing".into());
                let _ = self.inner.store.put_schedule(&s);
            }
        }
        self.start_auto_sync();
        let backend = self.clone();
        self.inner.runtime.spawn(async move {
            loop {
                backend.process_schedules().await;
                tokio::time::sleep(Duration::from_secs(15)).await;
            }
        });
        self.sync_all(true);
    }

    fn start_auto_sync(&self) {
        let seconds = self.inner.config.settings.read().sync_interval_seconds;
        let mut timer = self.inner.timer.lock();
        if let Some(handle) = timer.take() {
            handle.abort();
        }
        if seconds == 0 {
            return;
        }
        let backend = self.clone();
        *timer = Some(self.inner.runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(seconds.clamp(5, 86_400)));
            interval.tick().await;
            loop {
                interval.tick().await;
                backend.sync_all(false);
            }
        }));
    }

    pub fn sync_all(&self, force: bool) {
        for account in self.accounts() {
            if account.enabled {
                self.sync_account(&account.id, force);
            }
        }
    }

    pub fn sync_status(&self, account_id: &str) -> Option<SyncStatus> {
        self.inner.emitter.status.lock().get(account_id).cloned()
    }

    /// Syncs one mailbox (a run already going reruns once it ends).
    pub fn sync_account(&self, account_id: &str, force: bool) {
        let Some(rt) = self.inner.accounts.read().get(account_id).cloned() else {
            return;
        };
        if self.inner.demo {
            return;
        }
        if rt.running.swap(true, Ordering::AcqRel) {
            rt.rerun.store(true, Ordering::Relaxed);
            return;
        }
        if !force {
            let (failures, at) = *rt.failures.lock();
            if let Some(at) = at {
                let backoff = Duration::from_secs(30 * (1 << failures.min(5)).min(20));
                if at.elapsed() < backoff {
                    rt.running.store(false, Ordering::Release);
                    return;
                }
            }
        }
        let backend = self.clone();
        let account_id = account_id.to_string();
        self.inner.runtime.spawn(async move {
            loop {
                backend.run_sync(&account_id, &rt).await;
                if !rt.rerun.swap(false, Ordering::AcqRel) {
                    break;
                }
            }
            rt.running.store(false, Ordering::Release);
        });
    }

    async fn run_sync(&self, account_id: &str, rt: &Arc<AccountRuntime>) {
        let emitter = &self.inner.emitter;
        let started = chrono::Utc::now().timestamp_millis();
        emitter.update_status(account_id, |s| {
            s.syncing = true;
            s.error = None;
            s.phase = "incremental".into();
        });
        let ctx = SyncContext::new(
            account_id.to_string(),
            self.inner.store.clone(),
            emitter.clone(),
            rt.cancelled.clone(),
        );
        let result = async {
            rt.provider.sync(&ctx).await?;
            while rt.provider.needs_backfill() {
                ctx.check()?;
                emitter.update_status(account_id, |s| s.phase = "full".into());
                rt.provider.backfill(&ctx).await?;
                rt.provider.sync(&ctx).await?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        *rt.last_finished.lock() = Some(Instant::now());
        match &result {
            Ok(()) => {
                *rt.failures.lock() = (0, None);
                let mut state = self.inner.store.sync_state(account_id).unwrap_or_default();
                state.last_sync_at = Some(started);
                let _ = self.inner.store.set_sync_state(account_id, &state);
            }
            Err(err) => {
                log::warn!("sync {account_id}: {err:#}");
                let mut failures = rt.failures.lock();
                *failures = (failures.0 + 1, Some(Instant::now()));
            }
        }
        emitter.update_status(account_id, |s| {
            s.syncing = false;
            s.phase = "idle".into();
            s.error = result.as_ref().err().map(short_error);
            if result.is_ok() {
                s.last_sync_at = Some(started);
            }
        });
        if result.is_ok() {
            self.download_bodies(account_id, rt, &ctx).await;
        }
    }

    /// Downloads bodies for offline reading, a batch at a time, after a sync.
    async fn download_bodies(&self, account_id: &str, rt: &Arc<AccountRuntime>, ctx: &SyncContext) {
        loop {
            if rt.cancelled.load(Ordering::Relaxed) || rt.rerun.load(Ordering::Relaxed) {
                return;
            }
            match rt.provider.download_bodies(ctx).await {
                Ok(true) => continue,
                Ok(false) => return,
                Err(err) => {
                    log::info!("body downloads for {account_id} paused: {err:#}");
                    return;
                }
            }
        }
    }

    /// The unread inbox count across turned-on mailboxes (the Dock badge).
    pub fn inbox_unread_total(&self) -> i64 {
        let on: HashSet<String> = self
            .accounts()
            .into_iter()
            .filter(|a| a.enabled)
            .map(|a| a.id)
            .collect();
        self.inner
            .store
            .inbox_unread_counts()
            .map(|counts| {
                counts
                    .into_iter()
                    .filter(|(id, _)| on.contains(id))
                    .map(|(_, n)| n)
                    .sum()
            })
            .unwrap_or(0)
    }

    /// Unsubscribes from a list: one-click POST, a mailto, or a page to open.
    pub async fn unsubscribe(
        &self,
        account_id: String,
        message_id: String,
    ) -> Result<Option<String>> {
        let provider = self.provider(&account_id)?;
        let backend = self.clone();
        self.spawn(async move {
            let Some((header, post)) = provider.unsubscribe_headers(&message_id).await? else {
                anyhow::bail!("This message has no unsubscribe link");
            };
            let links: Vec<String> = header
                .split(',')
                .filter_map(|p| {
                    let p = p.trim();
                    p.strip_prefix('<')
                        .and_then(|p| p.strip_suffix('>'))
                        .map(String::from)
                })
                .collect();
            let https = links.iter().find(|l| l.starts_with("https:")).cloned();
            let mailto = links.iter().find(|l| l.starts_with("mailto:")).cloned();
            let one_click = post.as_deref().is_some_and(|p| {
                p.to_ascii_lowercase()
                    .contains("list-unsubscribe=one-click")
            });
            if let (true, Some(url)) = (one_click, &https) {
                let response = reqwest::Client::new()
                    .post(url)
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body("List-Unsubscribe=One-Click")
                    .timeout(Duration::from_secs(15))
                    .send()
                    .await?;
                if response.status().is_success() {
                    return Ok(None);
                }
                anyhow::bail!("The list answered {}", response.status());
            }
            if let Some(mailto) = mailto {
                let url = url::Url::parse(&mailto)?;
                let to = url.path().to_string();
                let mut subject = "unsubscribe".to_string();
                let mut body = "unsubscribe".to_string();
                for (k, v) in url.query_pairs() {
                    match k.as_ref() {
                        "subject" => subject = v.to_string(),
                        "body" => body = v.to_string(),
                        _ => {}
                    }
                }
                let draft = Draft {
                    account_id: account_id.clone(),
                    to: vec![Person {
                        name: None,
                        email: to,
                    }],
                    subject,
                    body_text: body,
                    ..Default::default()
                };
                provider.send(&draft).await?;
                let _ = backend;
                return Ok(None);
            }
            Ok(https)
        })
        .await
    }

    pub fn run<F>(&self, f: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        self.inner.runtime.spawn(f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::write_json;
    use crate::secrets::test_sealer;

    #[test]
    fn unreadable_google_file_does_not_rewrite_legacy_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::at(dir.path(), true);
        let passwords = std::collections::BTreeMap::from([(
            "imap-password:demo@example.test".to_string(),
            Sealer::plain().seal("fake-password").unwrap(),
        )]);
        write_json(&paths.file("secrets.json"), &passwords).unwrap();
        std::fs::write(paths.file("google-tokens.json"), b"{invalid").unwrap();
        let before = std::fs::read(paths.file("secrets.json")).unwrap();
        assert!(Backend::open_with_sealer(paths.clone(), Arc::new(test_sealer())).is_err());
        assert_eq!(std::fs::read(paths.file("secrets.json")).unwrap(), before);
    }
}

/// An error short enough for a toast.
pub fn short_error(err: &anyhow::Error) -> String {
    let text = format!("{err}");
    let line = text.lines().next().unwrap_or_default();
    if line.chars().count() > 160 {
        format!("{}…", line.chars().take(160).collect::<String>())
    } else {
        line.to_string()
    }
}

#[allow(unused)]
fn _assert_send() {
    fn is_send<T: Send + Sync>() {}
    is_send::<Backend>();
}

#[allow(unused)]
fn context_unused() -> Result<()> {
    Err(anyhow!("x")).context("y")
}
