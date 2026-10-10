//! The main window: a title bar, the mailbox sidebar, the message list and
//! the reader (or composer) and native browser in resizable panes.

use std::collections::{HashMap, HashSet};
use std::time::Duration;
use std::{cell::Cell, rc::Rc};

use gpui_kit::base::{HandleEdge, resize_handle};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::list::{List, ListEvent, ListState};
use gpui_kit::component::resizable::resize_handle_appearance;

use gpui_kit::component::Disableable as _;
use gpui_kit::component::Selectable as _;
use gpui_kit::component::{
    ActiveTheme as _, Sizable as _, TitleBar, WindowExt as _, h_flex, notification::Notification,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::backend::{Backend, Event, ThreadRef};
use mail_core::model::Scope;
use mail_core::model::*;

use crate::app::AppBackend;
use crate::composer::{ComposeMode, Composer, ComposerEvent};
use crate::layout::{Pane, PaneWidths};
use crate::message_list::{MessageList, RowContext};
use crate::ui::{LIST_WIDTH, RAIL_WIDTH, SIDEBAR_WIDTH, TITLE_HEIGHT, icon, tool_button};

pub const PAGE_SIZE: usize = 100;

#[derive(Clone)]
struct PaneDrag {
    pane: Pane,
    start_x: Rc<Cell<f32>>,
    widths: PaneWidths,
}

impl Render for PaneDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

pub struct OpenThread {
    pub r: ThreadRef,
    pub thread: Option<Thread>,
    pub loading: bool,
    pub error: Option<String>,
    /// Messages shown whole; the rest are one-line rows.
    pub expanded: HashSet<String>,
    /// Messages whose quoted history is shown.
    pub quotes: HashSet<String>,
    pub show_all: bool,
    pub scroll: ScrollHandle,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Main {
    Reader,
    Compose,
}

pub struct Undoable {
    pub refs: Vec<ThreadRef>,
    pub action: ThreadAction,
}

pub struct Workspace {
    pub backend: Backend,
    pub focus: FocusHandle,
    pub accounts: Vec<Account>,
    pub labels: HashMap<String, Vec<Label>>,
    pub scope: Scope,
    pub folder: Folder,
    pub list: Entity<ListState<MessageList>>,
    pub selected: Option<ThreadRef>,
    pub open: Option<OpenThread>,
    pub main: Main,
    pub composer: Option<Entity<Composer>>,
    pub sidebar_collapsed: bool,
    pub settings_view: Option<Entity<crate::settings::SettingsView>>,
    pub browser: Entity<crate::browser::BrowserPanel>,
    pub browser_open: bool,
    sidebar_width: f32,
    list_width: f32,
    browser_width: f32,
    resizing: bool,
    mouse_down_x: f32,
    pub search_visible: bool,
    pub search: Entity<InputState>,
    pub unread_only: bool,
    pub total: i64,
    pub unread: i64,
    pub undo: Vec<Undoable>,
    pub redo: Vec<Undoable>,
    history: Vec<(Scope, Folder, Option<ThreadRef>)>,
    history_index: usize,
    pub syncing: HashMap<String, mail_core::SyncStatus>,
    search_cursors: HashMap<String, Option<String>>,
    pub palette_query: String,
    pub palette_mail: Vec<ThreadSummary>,
    pending_sends: HashMap<usize, (Draft, Task<()>)>,
    next_send_id: usize,
    reload: Option<Task<()>>,
    mark_read: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
    _events: Task<()>,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let backend = cx.global::<AppBackend>().0.clone();
        let accounts = backend.accounts();
        let arrangement = backend.arrangement();
        let enabled: Vec<&Account> = accounts.iter().filter(|a| a.enabled).collect();
        let scope = if enabled.len() > 1 && arrangement.combined {
            Scope::All
        } else {
            enabled
                .first()
                .map(|a| Scope::Account(a.id.clone()))
                .unwrap_or(Scope::All)
        };
        let weak = cx.entity().downgrade();
        let list = cx.new(|cx| ListState::new(MessageList::new(weak), window, cx));
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search mail"));

        let mut events = backend.subscribe();
        let events_task = cx.spawn_in(window, async move |this, cx| {
            use futures::StreamExt as _;
            while let Some(event) = events.next().await {
                if this
                    .update_in(cx, |this, window, cx| this.on_event(event, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let subscriptions = vec![
            cx.subscribe_in(
                &search,
                window,
                |this, input, event: &InputEvent, window, cx| match event {
                    InputEvent::PressEnter { .. } => {
                        let q = input.read(cx).value().trim().to_string();
                        if q.is_empty() {
                            this.go(
                                this.scope.clone(),
                                Folder::System(SystemFolder::Inbox),
                                window,
                                cx,
                            );
                        } else {
                            this.run_search(q, window, cx);
                        }
                    }
                    InputEvent::Change if input.read(cx).value().is_empty() => {
                        if matches!(this.folder, Folder::Search(_)) {
                            this.go(
                                this.scope.clone(),
                                Folder::System(SystemFolder::Inbox),
                                window,
                                cx,
                            );
                        }
                    }
                    _ => {}
                },
            ),
            cx.subscribe_in(
                &list,
                window,
                |this, list, event: &ListEvent, window, cx| {
                    // Arrow keys in the focused list open as they move.
                    if let ListEvent::Select(ix) = event {
                        let r = list.read(cx).delegate().row_at(*ix).map(Workspace::row_ref);
                        if let Some(r) = r {
                            this.open_thread(r, false, window, cx);
                        }
                    }
                },
            ),
        ];
        let browser = cx.new(|cx| crate::browser::BrowserPanel::new(window, cx));
        let browser_open =
            crate::browser::SUPPORTED && backend.ui_pref("gmail:chat-open").as_deref() == Some("1");
        let width = |key, default: f32, min: f32, max: f32| {
            backend
                .ui_pref(key)
                .and_then(|v| v.parse::<f32>().ok())
                .filter(|v| v.is_finite())
                .unwrap_or(default)
                .clamp(min, max)
        };
        let mut this = Workspace {
            backend: backend.clone(),
            focus: cx.focus_handle(),
            accounts,
            labels: HashMap::new(),
            scope,
            folder: Folder::System(SystemFolder::Inbox),
            list,
            selected: None,
            open: None,
            main: Main::Reader,
            composer: None,
            sidebar_collapsed: matches!(
                backend.ui_pref("gmail:sidebar-open").as_deref(),
                Some("0" | "false")
            ),
            settings_view: None,
            browser,
            browser_open,
            sidebar_width: width("gmail:pane:sidebar", SIDEBAR_WIDTH, 180., 400.),
            list_width: width("gmail:pane:list", LIST_WIDTH, 280., 640.),
            browser_width: width("gmail:pane:chat", 340., 280., 1200.),
            resizing: false,
            mouse_down_x: 0.,
            search_visible: false,
            search,
            unread_only: false,
            total: 0,
            unread: 0,
            undo: vec![],
            redo: vec![],
            history: vec![],
            history_index: 0,
            syncing: HashMap::new(),
            search_cursors: HashMap::new(),
            palette_query: String::new(),
            palette_mail: vec![],
            pending_sends: HashMap::new(),
            next_send_id: 0,
            reload: None,
            mark_read: None,
            _subscriptions: subscriptions,
            _events: events_task,
        };
        this.push_history();
        this.reload_labels(cx);
        this.reload_list(true, cx);
        window.focus(&this.focus, cx);
        this
    }

    // ---- backend events -----------------------------------------------------

    fn on_event(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            Event::AccountsChanged => {
                self.accounts = self.backend.accounts();
                if let Scope::Account(id) = &self.scope {
                    if !self.accounts.iter().any(|a| &a.id == id) {
                        self.scope = Scope::All;
                    }
                }
                self.schedule_reload(cx);
            }
            Event::MailChanged { .. } => self.schedule_reload(cx),
            Event::SyncStatus(status) => {
                self.syncing.insert(status.account_id.clone(), status);
                cx.notify();
            }
            Event::WriteFailed { message } => {
                window.push_notification(Notification::error(message), cx)
            }
            Event::SendFailed {
                subject,
                saved_to_drafts,
            } => {
                let note = if saved_to_drafts {
                    format!("“{subject}” wasn't sent. It's in Drafts.")
                } else {
                    format!("“{subject}” wasn't sent.")
                };
                window.push_notification(Notification::error(note), cx);
            }
            Event::NewMail {
                account_id,
                messages,
            } => self.notify_new_mail(&account_id, messages, window, cx),
            Event::SchedulesChanged | Event::SettingsChanged => cx.notify(),
            Event::SignInFinished { result } => match result {
                Ok(email) => {
                    window.push_notification(Notification::success(format!("Added {email}")), cx);
                    self.accounts = self.backend.accounts();
                    self.go(
                        Scope::Account(email),
                        Folder::System(SystemFolder::Inbox),
                        window,
                        cx,
                    );
                }
                Err(err) if err == "cancelled" => {}
                Err(err) => window.push_notification(Notification::error(err), cx),
            },
        }
    }

    fn notify_new_mail(
        &mut self,
        account_id: &str,
        messages: Vec<Message>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mode = self.backend.settings().notifications_mode;
        if mode == "off"
            || !self
                .accounts
                .iter()
                .any(|a| a.id == account_id && a.enabled)
        {
            return;
        }
        let messages: Vec<Message> = messages
            .into_iter()
            .filter(|m| mode == "all" || m.label_ids.iter().any(|l| l == "INBOX"))
            .collect();
        if messages.len() > 3 {
            window.push_notification(
                Notification::new()
                    .title("Otter Mail")
                    .message(format!("{} new messages", messages.len()))
                    .system(),
                cx,
            );
            return;
        }
        for m in messages {
            let r = ThreadRef {
                account_id: m.account_id.clone(),
                thread_id: m.thread_id.clone(),
            };
            let weak = cx.entity().downgrade();
            window.push_notification(
                Notification::new()
                    .title(m.from.display().to_string())
                    .message(format!("{}\n{}", m.subject, m.snippet))
                    .system()
                    .on_click(move |_, window, cx| {
                        if let Some(this) = weak.upgrade() {
                            this.update(cx, |this, cx| {
                                this.open_thread(r.clone(), true, window, cx)
                            });
                        }
                    }),
                cx,
            );
        }
    }

    // ---- loading -------------------------------------------------------------

    pub fn mailbox(&self) -> Mailbox {
        Mailbox {
            scope: self.scope.clone(),
            folder: self.folder.clone(),
        }
    }

    pub fn account(&self, id: &str) -> Option<&Account> {
        self.accounts.iter().find(|a| a.id == id)
    }

    pub fn label(&self, account_id: &str, label_id: &str) -> Option<&Label> {
        self.labels
            .get(account_id)?
            .iter()
            .find(|l| l.id == label_id)
    }

    pub fn row_ref(row: &ThreadSummary) -> ThreadRef {
        ThreadRef {
            account_id: row.account_id.clone(),
            thread_id: row.id.clone(),
        }
    }

    pub fn row(&self, r: &ThreadRef, cx: &App) -> Option<ThreadSummary> {
        self.list.read(cx).delegate().row(r).cloned()
    }

    fn row_context(&self) -> RowContext {
        RowContext {
            combined: self.scope == Scope::All,
            folder: Some(self.folder.clone()),
            labels: self.labels.clone(),
            accounts: self.accounts.clone(),
            group_by_day: self
                .backend
                .ui_pref("otter:group-messages-by-day")
                .as_deref()
                != Some("false"),
        }
    }

    /// Re-reads after the cache changed, at most every 150ms.
    fn schedule_reload(&mut self, cx: &mut Context<Self>) {
        if self.reload.is_some() {
            return;
        }
        self.reload = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(150))
                .await;
            let _ = this.update(cx, |this, cx| {
                this.reload = None;
                this.reload_labels(cx);
                this.reload_list(false, cx);
                this.fetch_open_thread(false, cx);
            });
        }));
    }

    pub fn reload_labels(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self.accounts.iter().map(|a| a.id.clone()).collect();
        let task = self.backend.blocking(move |b| {
            let mut out = HashMap::new();
            for id in ids {
                out.insert(id.clone(), b.labels(&id)?);
            }
            Ok(out)
        });
        cx.spawn(async move |this, cx| {
            if let Ok(labels) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.labels = labels;
                    let ctx = this.row_context();
                    this.list.update(cx, |list, cx| {
                        list.delegate_mut().ctx = ctx;
                        cx.notify();
                    });
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// Re-reads the list (keeping how far it was paged); `reset` starts over.
    pub fn reload_list(&mut self, reset: bool, cx: &mut Context<Self>) {
        let mailbox = self.mailbox();
        let ctx = self.row_context();
        if reset {
            self.list.update(cx, |list, cx| {
                let d = list.delegate_mut();
                d.reset();
                d.ctx = ctx.clone();
                cx.notify();
            });
            self.total = 0;
            self.unread = 0;
        }
        if let Folder::Search(_) = mailbox.folder {
            if !reset {
                let refs: Vec<(String, String)> = self
                    .list
                    .read(cx)
                    .delegate()
                    .rows
                    .iter()
                    .map(|r| (r.account_id.clone(), r.id.clone()))
                    .collect();
                let task = self
                    .backend
                    .blocking(move |b| b.store().thread_summaries(&refs));
                cx.spawn(async move |this, cx| {
                    if let Ok(rows) = task.await {
                        let _ = this.update(cx, |this, cx| this.set_rows(rows, None, cx));
                    }
                })
                .detach();
            }
            return;
        }
        let limit = self.list.read(cx).delegate().rows.len().max(PAGE_SIZE);
        let unread_only = self.unread_only;
        let task = self.backend.blocking(move |b| {
            let mut rules = b.rules(&mailbox);
            if unread_only {
                for r in &mut rules {
                    r.all_of.push("UNREAD".into());
                }
            }
            let (rows, more) = b.store().threads_page(&rules, 0, limit)?;
            let counts = b.counts(&mailbox)?;
            Ok((rows, more, counts, mailbox))
        });
        cx.spawn(async move |this, cx| match task.await {
            Ok((rows, more, (total, unread), mailbox)) => {
                let _ = this.update(cx, |this, cx| {
                    if this.mailbox() != mailbox {
                        return;
                    }
                    this.total = total;
                    this.unread = unread;
                    this.set_rows(rows, Some(more), cx);
                });
            }
            Err(err) => log::warn!("loading the list: {err:#}"),
        })
        .detach();
    }

    fn set_rows(&mut self, rows: Vec<ThreadSummary>, more: Option<bool>, cx: &mut Context<Self>) {
        let selected = self.selected.clone();
        self.list.update(cx, |list, cx| {
            let d = list.delegate_mut();
            d.set_rows(rows);
            d.loading = false;
            d.loaded_once = true;
            if let Some(more) = more {
                d.has_more = more;
            }
            d.selected = selected.as_ref().and_then(|r| d.index_of(r));
            cx.notify();
        });
        cx.notify();
    }

    pub fn load_more(&mut self, cx: &mut Context<Self>) {
        if let Folder::Search(q) = self.folder.clone() {
            if self.search_cursors.values().any(|c| c.is_some()) {
                self.search_page(q, false, cx);
            } else {
                self.list
                    .update(cx, |list, _| list.delegate_mut().loading = false);
            }
            return;
        }
        let mailbox = self.mailbox();
        let offset = self.list.read(cx).delegate().rows.len();
        let unread_only = self.unread_only;
        let task = self.backend.blocking(move |b| {
            let mut rules = b.rules(&mailbox);
            if unread_only {
                for r in &mut rules {
                    r.all_of.push("UNREAD".into());
                }
            }
            let (rows, more) = b.store().threads_page(&rules, offset, PAGE_SIZE)?;
            Ok((rows, more, mailbox))
        });
        cx.spawn(async move |this, cx| {
            if let Ok((rows, more, mailbox)) = task.await {
                let _ = this.update(cx, |this, cx| {
                    if this.mailbox() != mailbox {
                        return;
                    }
                    let mut all = this.list.read(cx).delegate().rows.clone();
                    all.extend(rows);
                    this.set_rows(all, Some(more), cx);
                });
            }
        })
        .detach();
    }

    // ---- navigation ---------------------------------------------------------------

    fn push_history(&mut self) {
        let entry = (
            self.scope.clone(),
            self.folder.clone(),
            self.open.as_ref().map(|o| o.r.clone()),
        );
        if self.history_index > 0 && self.history.get(self.history_index - 1) == Some(&entry) {
            return;
        }
        self.history.truncate(self.history_index);
        self.history.push(entry);
        if self.history.len() > 100 {
            self.history.remove(0);
        }
        self.history_index = self.history.len();
    }

    pub fn can_go_back(&self) -> bool {
        self.history_index > 1
    }

    pub fn can_go_forward(&self) -> bool {
        self.history_index < self.history.len()
    }

    pub fn go(
        &mut self,
        scope: Scope,
        folder: Folder,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let same = self.scope == scope && self.folder == folder;
        self.scope = scope;
        self.folder = folder;
        if !same {
            self.close_thread(cx);
            self.selected = None;
            if !matches!(self.folder, Folder::Search(_)) {
                self.search.update(cx, |s, cx| s.set_value("", window, cx));
            }
            self.reload_list(true, cx);
            self.push_history();
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    pub fn go_back(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let target = if forward {
            if !self.can_go_forward() {
                return;
            }
            self.history_index + 1
        } else {
            if !self.can_go_back() {
                return;
            }
            self.history_index - 1
        };
        let Some((scope, folder, thread)) = self.history.get(target - 1).cloned() else {
            return;
        };
        self.history_index = target;
        let changed = self.scope != scope || self.folder != folder;
        self.scope = scope;
        self.folder = folder;
        self.main = Main::Reader;
        if changed {
            self.reload_list(true, cx);
        }
        match thread {
            Some(r) => {
                self.selected = Some(r.clone());
                self.load_thread(r, cx);
            }
            None => self.close_thread(cx),
        }
        window.focus(&self.focus, cx);
        cx.notify();
    }

    // ---- the open conversation ------------------------------------------------------

    pub fn open_thread(
        &mut self,
        r: ThreadRef,
        mark_read_now: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selected = Some(r.clone());
        if self.main == Main::Compose
            && self
                .composer
                .as_ref()
                .is_some_and(|c| !c.read(cx).is_inline())
        {
            // Leave the new message open in the background? Close it, keeping the draft.
            if let Some(c) = self.composer.take() {
                c.update(cx, |c, cx| c.save_now(cx));
            }
        }
        self.main = Main::Reader;
        if let Some(row) = self.row(&r, cx) {
            if row.draft_only {
                self.open_draft(r, window, cx);
                return;
            }
        }
        self.load_thread(r.clone(), cx);
        self.push_history();
        let ix = self.list.read(cx).delegate().index_of(&r);
        self.list.update(cx, |list, cx| {
            list.delegate_mut().selected = ix;
            list.set_selected_index(ix, window, cx);
            list.scroll_to_selected_item(window, cx);
        });
        let delay = self
            .backend
            .ui_pref("otter:mark-read-delay")
            .and_then(|v| v.parse::<f32>().ok())
            .unwrap_or(2000.)
            .clamp(0., 5000.);
        self.mark_read = None;
        if mark_read_now || delay <= 0. {
            self.mark_open_read(cx);
        } else {
            self.mark_read = Some(cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(delay as u64))
                    .await;
                let _ = this.update(cx, |this, cx| this.mark_open_read(cx));
            }));
        }
        cx.notify();
    }

    fn mark_open_read(&mut self, cx: &mut Context<Self>) {
        let Some(open) = &self.open else { return };
        let r = open.r.clone();
        if self.row(&r, cx).is_some_and(|row| row.unread) {
            let _ = self.backend.act(vec![r], ThreadAction::MarkRead);
        }
    }

    pub fn load_thread(&mut self, r: ThreadRef, cx: &mut Context<Self>) {
        if !self.open.as_ref().is_some_and(|o| o.r == r) {
            self.open = Some(OpenThread {
                r,
                thread: None,
                loading: true,
                error: None,
                expanded: HashSet::new(),
                quotes: HashSet::new(),
                show_all: false,
                scroll: ScrollHandle::new(),
            });
        }
        self.fetch_open_thread(true, cx);
    }

    fn fetch_open_thread(&mut self, first: bool, cx: &mut Context<Self>) {
        use futures::FutureExt as _;
        let Some(open) = &self.open else { return };
        let r = open.r.clone();
        let backend = self.backend.clone();
        let (a, t) = (r.account_id.clone(), r.thread_id.clone());
        let task = if first {
            let b = backend.clone();
            backend.spawn(async move { b.thread(a, t).await }).boxed()
        } else {
            let b = backend.clone();
            backend
                .spawn(async move {
                    let messages = b.store().thread_messages(&a, &t)?;
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
                        account_id: a,
                        id: t,
                        messages,
                        label_ids,
                    })
                })
                .boxed()
        };
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let Some(open) = this.open.as_mut().filter(|o| o.r == r) else {
                    return;
                };
                open.loading = false;
                match result {
                    Ok(thread) if thread.messages.is_empty() && !first => {}
                    Ok(thread) => {
                        if open.thread.is_none() || first {
                            open.expanded.clear();
                            let last = thread.messages.len().saturating_sub(1);
                            for (i, m) in thread.messages.iter().enumerate() {
                                if i == last || m.unread {
                                    open.expanded.insert(m.id.clone());
                                }
                            }
                        }
                        open.thread = Some(thread);
                        open.error = None;
                    }
                    Err(err) => open.error = Some(mail_core::backend::short_error(&err)),
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub fn close_thread(&mut self, cx: &mut Context<Self>) {
        self.open = None;
        self.mark_read = None;
        cx.notify();
    }

    pub fn move_selection(
        &mut self,
        delta: isize,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let refs = self.list.read(cx).delegate().visible_refs();
        if refs.is_empty() {
            return;
        }
        let pos = self
            .selected
            .as_ref()
            .and_then(|s| refs.iter().position(|r| r == s));
        let next = match pos {
            Some(p) => (p as isize + delta).clamp(0, refs.len() as isize - 1) as usize,
            None => 0,
        };
        let r = refs[next].clone();
        if extend {
            let current = self.selected.clone();
            self.list.update(cx, |list, cx| {
                let d = list.delegate_mut();
                if let Some(c) = current {
                    d.checked.insert(c);
                }
                d.checked.insert(r.clone());
                cx.notify();
            });
            self.selected = Some(r.clone());
            let ix = self.list.read(cx).delegate().index_of(&r);
            self.list.update(cx, |list, cx| {
                list.set_selected_index(ix, window, cx);
                list.scroll_to_selected_item(window, cx);
            });
            cx.notify();
            return;
        }
        self.open_thread(r, false, window, cx);
    }

    // ---- acting on conversations -------------------------------------------------------

    /// What an action applies to: the selected rows, else the open one.
    pub fn targets(&self, cx: &App) -> Vec<ThreadRef> {
        let list = self.list.read(cx).delegate();
        if !list.checked.is_empty() {
            return list
                .visible_refs()
                .into_iter()
                .filter(|r| list.checked.contains(r))
                .collect();
        }
        self.open
            .as_ref()
            .map(|o| o.r.clone())
            .or_else(|| self.selected.clone())
            .into_iter()
            .collect()
    }

    pub fn checked_count(&self, cx: &App) -> usize {
        self.list.read(cx).delegate().checked.len()
    }

    pub fn clear_checked(&mut self, cx: &mut Context<Self>) {
        self.list.update(cx, |list, cx| {
            list.delegate_mut().checked.clear();
            cx.notify();
        });
        cx.notify();
    }

    pub fn act(&mut self, action: ThreadAction, window: &mut Window, cx: &mut Context<Self>) {
        let refs = self.targets(cx);
        self.act_on(refs, action, window, cx);
    }

    pub fn act_on(
        &mut self,
        refs: Vec<ThreadRef>,
        action: ThreadAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if refs.is_empty() {
            return;
        }
        let leaves = action.removes_from(&self.folder);
        let next = if leaves {
            self.next_after(&refs, cx)
        } else {
            None
        };
        if let Err(err) = self.backend.act(refs.clone(), action.clone()) {
            window.push_notification(Notification::error(format!("{err:#}")), cx);
            return;
        }
        if action.inverse().is_some() {
            self.undo.push(Undoable {
                refs: refs.clone(),
                action: action.clone(),
            });
            self.redo.clear();
        }
        if leaves {
            let mut rows = self.list.read(cx).delegate().rows.clone();
            rows.retain(|row| !refs.contains(&Self::row_ref(row)));
            self.list
                .update(cx, |list, _| list.delegate_mut().checked.clear());
            self.set_rows(rows, None, cx);
            let open_left = self.open.as_ref().is_some_and(|o| refs.contains(&o.r));
            if open_left || self.selected.as_ref().is_some_and(|s| refs.contains(s)) {
                match next {
                    Some(r) if open_left => self.open_thread(r, false, window, cx),
                    Some(r) => self.selected = Some(r),
                    None => {
                        self.selected = None;
                        self.close_thread(cx);
                    }
                }
            }
        }
        if let Some(summary) = crate::actions::describe(&action, refs.len()) {
            let weak = cx.entity().downgrade();
            window.push_notification(
                Notification::new()
                    .message(summary)
                    .action(move |_, _, _| {
                        let weak = weak.clone();
                        gpui_kit::component::button::Button::new("undo")
                            .label("Undo")
                            .on_click(move |_, window, cx| {
                                if let Some(this) = weak.upgrade() {
                                    this.update(cx, |this, cx| this.undo(window, cx));
                                }
                            })
                    })
                    .autohide(true),
                cx,
            );
        }
        cx.notify();
    }

    fn next_after(&self, refs: &[ThreadRef], cx: &App) -> Option<ThreadRef> {
        let advance = self
            .backend
            .ui_pref("gmail:advance")
            .unwrap_or_else(|| "next".into());
        if advance == "none" {
            return None;
        }
        let rows = self.list.read(cx).delegate().visible_refs();
        let current = self.selected.as_ref()?;
        let pos = rows.iter().position(|r| r == current)?;
        let candidates: Vec<&ThreadRef> = if advance == "previous" {
            rows[..pos].iter().rev().collect()
        } else {
            rows[pos..].iter().chain(rows[..pos].iter().rev()).collect()
        };
        candidates.into_iter().find(|r| !refs.contains(r)).cloned()
    }

    pub fn undo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(last) = self.undo.pop() else { return };
        if let Some(inverse) = last.action.inverse() {
            let _ = self.backend.act(last.refs.clone(), inverse);
            window.push_notification(Notification::new().message("Undone"), cx);
        }
        self.redo.push(last);
        cx.notify();
    }

    pub fn redo(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(last) = self.redo.pop() else { return };
        let _ = self.backend.act(last.refs.clone(), last.action.clone());
        window.push_notification(Notification::new().message("Redone"), cx);
        self.undo.push(last);
        cx.notify();
    }

    fn thread_labels(&self, r: &ThreadRef, cx: &App) -> Vec<String> {
        self.row(r, cx)
            .map(|row| row.label_ids)
            .or_else(|| {
                self.open
                    .as_ref()
                    .filter(|o| &o.r == r)
                    .and_then(|o| o.thread.as_ref())
                    .map(|t| t.label_ids.clone())
            })
            .unwrap_or_default()
    }

    /// Archive, or back to the Inbox when it's already out of it.
    pub fn toggle_archive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let refs = self.targets(cx);
        let labels: Vec<Vec<String>> = refs.iter().map(|r| self.thread_labels(r, cx)).collect();
        let action = if labels.iter().any(|l| l.iter().any(|x| x == "TRASH")) {
            ThreadAction::Untrash
        } else if labels.iter().any(|l| l.iter().any(|x| x == "INBOX")) {
            ThreadAction::Archive
        } else {
            ThreadAction::MoveToInbox
        };
        self.act_on(refs, action, window, cx);
    }

    pub fn toggle_star(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let refs = self.targets(cx);
        let starred = refs
            .iter()
            .all(|r| self.thread_labels(r, cx).iter().any(|l| l == "STARRED"));
        self.act_on(
            refs,
            if starred {
                ThreadAction::Unstar
            } else {
                ThreadAction::Star
            },
            window,
            cx,
        );
    }

    pub fn trash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.folder, Folder::System(SystemFolder::Trash)) {
            let refs = self.targets(cx);
            self.confirm_delete_forever(refs, window, cx);
        } else {
            self.act(ThreadAction::Trash, window, cx);
        }
    }

    pub fn confirm_delete_forever(
        &mut self,
        refs: Vec<ThreadRef>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if refs.is_empty() {
            return;
        }
        let weak = cx.entity().downgrade();
        let n = refs.len();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let weak = weak.clone();
            let refs = refs.clone();
            alert
                .title(if n == 1 {
                    "Delete this conversation forever?".to_string()
                } else {
                    format!("Delete {n} conversations forever?")
                })
                .description("This can't be undone.")
                .confirm()
                .ok_text("Delete Forever")
                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    if let Some(this) = weak.upgrade() {
                        let refs = refs.clone();
                        this.update(cx, |this, cx| {
                            this.act_on(refs, ThreadAction::DeleteForever, window, cx)
                        });
                    }
                    true
                })
        });
    }

    // ---- search -------------------------------------------------------------------------

    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search_visible = true;
        cx.notify();
        self.search.update(cx, |s, cx| s.focus(window, cx));
    }

    pub fn run_search(&mut self, q: String, window: &mut Window, cx: &mut Context<Self>) {
        self.folder = Folder::Search(q.clone());
        self.close_thread(cx);
        self.selected = None;
        self.search.update(cx, |s, cx| {
            if s.value() != q.as_str() {
                s.set_value(q.clone(), window, cx)
            }
        });
        self.search_cursors.clear();
        self.reload_list(true, cx);
        self.push_history();
        self.search_page(q, true, cx);
        cx.notify();
    }

    fn search_page(&mut self, q: String, first: bool, cx: &mut Context<Self>) {
        let accounts: Vec<String> = match &self.scope {
            Scope::All => self
                .accounts
                .iter()
                .filter(|a| a.enabled)
                .map(|a| a.id.clone())
                .collect(),
            Scope::Account(id) => vec![id.clone()],
        };
        let cursors = if first {
            HashMap::new()
        } else {
            self.search_cursors.clone()
        };
        self.list
            .update(cx, |list, _| list.delegate_mut().loading = true);
        let backend = self.backend.clone();
        let query = q.clone();
        cx.spawn(async move |this, cx| {
            let result = backend.search(query, accounts, cursors).await;
            let _ = this.update(cx, |this, cx| {
                if this.folder != Folder::Search(q.clone()) {
                    return;
                }
                match result {
                    Ok((found, cursors)) => {
                        let mut rows = if first {
                            vec![]
                        } else {
                            this.list.read(cx).delegate().rows.clone()
                        };
                        for row in found {
                            if !rows
                                .iter()
                                .any(|r| r.account_id == row.account_id && r.id == row.id)
                            {
                                rows.push(row);
                            }
                        }
                        this.total = rows.len() as i64;
                        this.unread = rows.iter().filter(|r| r.unread).count() as i64;
                        let more = cursors.values().any(|c| c.is_some());
                        this.search_cursors = cursors;
                        this.set_rows(rows, Some(more), cx);
                    }
                    Err(err) => {
                        log::warn!("search: {err:#}");
                        this.set_rows(vec![], Some(false), cx);
                    }
                }
            });
        })
        .detach();
    }

    // ---- composing -------------------------------------------------------------------------

    pub fn compose(&mut self, mode: ComposeMode, window: &mut Window, cx: &mut Context<Self>) {
        let inline = matches!(mode, ComposeMode::Reply { .. } | ComposeMode::Forward);
        if inline && self.open.is_none() {
            return;
        }
        let account_id = match &mode {
            ComposeMode::New { account_id, .. } => account_id.clone(),
            ComposeMode::Draft { message } => Some(message.account_id.clone()),
            _ => self.open.as_ref().map(|o| o.r.account_id.clone()),
        }
        .or_else(|| match &self.scope {
            Scope::Account(id) => Some(id.clone()),
            Scope::All => None,
        })
        .or_else(|| {
            self.accounts
                .iter()
                .find(|a| a.enabled)
                .map(|a| a.id.clone())
        });
        let Some(account_id) = account_id else {
            window.push_notification(Notification::warning("Add a mailbox first"), cx);
            return;
        };
        let thread = self.open.as_ref().and_then(|o| o.thread.clone());
        let accounts = self.accounts.clone();
        let composer = cx.new(|cx| Composer::new(mode, account_id, accounts, thread, window, cx));
        let sub = cx.subscribe_in(&composer, window, |this, _, event, window, cx| {
            match event {
                ComposerEvent::Close => {}
                ComposerEvent::Send { draft } => this.send_with_undo(draft.clone(), window, cx),
            }
            this.composer = None;
            this.main = Main::Reader;
            window.focus(&this.focus, cx);
            cx.notify();
        });
        self._subscriptions.push(sub);
        composer.update(cx, |c, cx| c.focus_first(window, cx));
        self.composer = Some(composer);
        if !inline {
            self.main = Main::Compose;
        }
        cx.notify();
    }

    fn open_draft(&mut self, r: ThreadRef, window: &mut Window, cx: &mut Context<Self>) {
        let backend = self.backend.clone();
        let (a, t) = (r.account_id.clone(), r.thread_id.clone());
        let task = {
            let b = backend.clone();
            backend.spawn(async move { b.thread(a, t).await })
        };
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(thread) = task.await {
                if let Some(draft) = thread.messages.iter().rev().find(|m| m.draft).cloned() {
                    let _ = this.update_in(cx, |this, window, cx| {
                        this.compose(
                            ComposeMode::Draft {
                                message: Box::new(draft),
                            },
                            window,
                            cx,
                        );
                    });
                }
            }
        })
        .detach();
    }

    /// Sends after 10 seconds, unless Undo puts the message back in a composer.
    fn send_with_undo(&mut self, draft: Draft, window: &mut Window, cx: &mut Context<Self>) {
        let id = self.next_send_id;
        self.next_send_id += 1;
        let backend = self.backend.clone();
        let d = draft.clone();
        let task = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_secs(10))
                .await;
            let _ = this.update(cx, |this, _| this.pending_sends.remove(&id));
            let b = backend.clone();
            let subject = d.subject.clone();
            let result = backend.spawn(async move { b.send(d).await }).await;
            let _ = cx.update(|window, cx| match result {
                Ok(()) => window.push_notification(Notification::success("Sent"), cx),
                Err(err) => window.push_notification(
                    Notification::error(format!(
                        "“{subject}” wasn't sent: {}",
                        mail_core::backend::short_error(&err)
                    )),
                    cx,
                ),
            });
        });
        self.pending_sends.insert(id, (draft, task));
        let weak = cx.entity().downgrade();
        window.push_notification(
            Notification::new()
                .message("Sending…")
                .action(move |_, _, _| {
                    let weak = weak.clone();
                    gpui_kit::component::button::Button::new("undo-send")
                        .label("Undo")
                        .on_click(move |_, window, cx| {
                            if let Some(this) = weak.upgrade() {
                                this.update(cx, |this, cx| this.undo_send(id, window, cx));
                            }
                        })
                })
                .autohide(true),
            cx,
        );
    }

    fn undo_send(&mut self, id: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some((draft, _task)) = self.pending_sends.remove(&id) else {
            return;
        };
        let account = self.account(&draft.account_id).cloned();
        let message = Message {
            account_id: draft.account_id.clone(),
            id: draft.draft_id.clone().unwrap_or_default(),
            thread_id: draft.thread_id.clone().unwrap_or_default(),
            date: chrono::Utc::now().timestamp_millis(),
            from: Person {
                name: account.as_ref().and_then(|a| a.name.clone()),
                email: account.map(|a| a.email).unwrap_or_default(),
            },
            to: draft.to.clone(),
            cc: draft.cc.clone(),
            bcc: draft.bcc.clone(),
            reply_to: vec![],
            subject: draft.subject.clone(),
            snippet: String::new(),
            label_ids: vec!["DRAFT".into()],
            unread: false,
            starred: false,
            draft: true,
            body_html: None,
            body_text: Some(draft.body_text.clone()),
            attachments: vec![],
            message_id_header: None,
            references: draft.references.clone(),
            in_reply_to: draft.in_reply_to.clone(),
            list_unsubscribe: None,
            list_unsubscribe_post: None,
        };
        self.compose(
            ComposeMode::Draft {
                message: Box::new(message),
            },
            window,
            cx,
        );
    }

    // ---- rendering -------------------------------------------------------------------------

    pub fn title(&self) -> String {
        match &self.folder {
            Folder::System(f) => f.title().to_string(),
            Folder::Label(id) => match &self.scope {
                Scope::Account(a) => self
                    .label(a, id)
                    .map(|l| l.leaf_name().to_string())
                    .unwrap_or_else(|| id.clone()),
                Scope::All => id.clone(),
            },
            Folder::Search(q) => format!("Search: {q}"),
        }
    }

    pub fn scope_title(&self) -> String {
        match &self.scope {
            Scope::All => "All mailboxes".into(),
            Scope::Account(id) => self
                .account(id)
                .map(|a| a.title().to_string())
                .unwrap_or_else(|| id.clone()),
        }
    }

    fn render_title_bar(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let settings = self.settings_view.is_some();
        let widths = self.pane_widths(_window);
        let left_width = RAIL_WIDTH
            + if settings {
                SIDEBAR_WIDTH
            } else {
                widths.sidebar
            };
        let navigation_width = (left_width - 82.).max(100.);
        let list_title_width = (widths.list - (82. + navigation_width - left_width)).max(0.);
        let title_reader_width = (Self::available_width(_window)
            - widths.sidebar
            - widths.list
            - widths.browser
            - if crate::browser::SUPPORTED && !self.browser_open {
                34.
            } else {
                0.
            })
        .max(0.);
        let counts = if matches!(self.folder, Folder::Search(_)) {
            format!(" · {} results", self.total)
        } else if self.unread > 0 {
            format!(" · {} messages · {} unread", self.total, self.unread)
        } else {
            format!(" · {} messages", self.total)
        };
        TitleBar::new()
            .h(px(TITLE_HEIGHT))
            .pl(px(82.))
            .border_0()
            .bg(cx.theme().title_bar)
            .child(
                h_flex()
                    .size_full()
                    .gap_0()
                    .child(
                        h_flex()
                            .w(px(navigation_width))
                            .occlude()
                            .flex_none()
                            .gap_1()
                            .child(
                                tool_button(
                                    "toggle-sidebar",
                                    "panel-left",
                                    "Toggle sidebar",
                                    Some("cmd-b"),
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_sidebar(cx))),
                            )
                            .child(
                                tool_button("recent", "clock", "Recently viewed", None).on_click(
                                    cx.listener(|this, _, w, cx| this.open_palette(w, cx)),
                                ),
                            )
                            .child(
                                tool_button("back", "chevron-left", "Back", Some("cmd-["))
                                    .disabled(!settings && !self.can_go_back())
                                    .on_click(cx.listener(|this, _, w, cx| {
                                        if this.settings_view.is_some() {
                                            this.hide_settings(w, cx);
                                        } else {
                                            this.go_back(false, w, cx);
                                        }
                                    })),
                            )
                            .child(
                                tool_button("forward", "chevron-right", "Forward", Some("cmd-]"))
                                    .disabled(settings || !self.can_go_forward())
                                    .on_click(
                                        cx.listener(|this, _, w, cx| this.go_back(true, w, cx)),
                                    ),
                            ),
                    )
                    .when(!settings, |el| {
                        el.child(
                            h_flex()
                                .w(px(list_title_width))
                                .occlude()
                                .min_w_0()
                                .flex_none()
                                .px_4()
                                .gap_1()
                                .child(
                                    h_flex()
                                        .flex_1()
                                        .min_w_0()
                                        .text_size(px(14.))
                                        .child(self.title())
                                        .child(
                                            div()
                                                .truncate()
                                                .text_color(cx.theme().muted_foreground)
                                                .child(counts),
                                        ),
                                )
                                .child(
                                    tool_button(
                                        "search-mail",
                                        "search",
                                        "Search mail",
                                        Some("cmd-f"),
                                    )
                                    .on_click(
                                        cx.listener(|this, _, w, cx| this.focus_search(w, cx)),
                                    ),
                                )
                                .child(
                                    tool_button(
                                        "unread-only",
                                        "list-filter",
                                        "Show unread only",
                                        None,
                                    )
                                    .selected(self.unread_only)
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.unread_only = !this.unread_only;
                                            this.reload_list(true, cx);
                                        },
                                    )),
                                ),
                        )
                    })
                    .child(
                        div()
                            .w(px(title_reader_width))
                            .flex_none()
                            .min_w_0()
                            .h_full()
                            .overflow_hidden()
                            .when(
                                !settings && self.open.is_some() && self.main == Main::Reader,
                                |el| {
                                    el.child(self.render_reader_toolbar(
                                        title_reader_width,
                                        _window,
                                        cx,
                                    ))
                                },
                            ),
                    )
                    .when(!settings && self.browser_open, |el| {
                        el.child(
                            div()
                                .w(px(widths.browser - 44.))
                                .flex_none()
                                .min_w_0()
                                .h_full()
                                .child(
                                    self.browser
                                        .update(cx, |browser, cx| browser.render_tabs(cx)),
                                ),
                        )
                    })
                    .when(!settings && crate::browser::SUPPORTED, |el| {
                        el.child(
                            tool_button(
                                "toggle-browser",
                                "panel-right",
                                "Toggle browser panel",
                                Some("cmd-shift-b"),
                            )
                            .occlude()
                            .selected(self.browser_open)
                            .mr_3()
                            .on_click(cx.listener(|this, _, w, cx| this.toggle_browser(w, cx))),
                        )
                    }),
            )
    }

    fn render_list_pane(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let checked = self.checked_count(cx);
        v_flex()
            .size_full()
            .border_r_1()
            .border_color(cx.theme().border.opacity(0.7))
            .when(self.search_visible, |el| {
                el.child(
                    div().p_2().child(
                        Input::new(&self.search)
                            .small()
                            .prefix(icon("search").small())
                            .cleanable(true),
                    ),
                )
            })
            .when(checked > 0, |el| {
                el.child(self.render_bulk_bar(checked, cx))
            })
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .child(List::new(&self.list).scrollbar_visible(true)),
            )
    }

    fn render_bulk_bar(&mut self, n: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let in_trash = matches!(self.folder, Folder::System(SystemFolder::Trash));
        let in_spam = matches!(self.folder, Folder::System(SystemFolder::Spam));
        let mut bar = h_flex()
            .flex_none()
            .gap_1()
            .px_2()
            .py_1()
            .border_b_1()
            .border_color(cx.theme().border)
            .bg(cx.theme().secondary)
            .child(
                div()
                    .flex_1()
                    .text_sm()
                    .pl_1()
                    .child(format!("{n} selected")),
            );
        let button = |id: &'static str,
                      name: &str,
                      tip: &str,
                      action: ThreadAction,
                      cx: &mut Context<Self>| {
            tool_button(id, name, tip, None).on_click(cx.listener(move |this, _, w, cx| {
                match &action {
                    ThreadAction::DeleteForever => {
                        let t = this.targets(cx);
                        this.confirm_delete_forever(t, w, cx)
                    }
                    a => this.act(a.clone(), w, cx),
                }
            }))
        };
        if in_trash {
            bar = bar
                .child(button(
                    "bulk-restore",
                    "rotate-ccw",
                    "Restore",
                    ThreadAction::Untrash,
                    cx,
                ))
                .child(button(
                    "bulk-delete",
                    "trash",
                    "Delete Forever",
                    ThreadAction::DeleteForever,
                    cx,
                ));
        } else if in_spam {
            bar = bar
                .child(button(
                    "bulk-notspam",
                    "shield-check",
                    "Not Junk",
                    ThreadAction::NotSpam,
                    cx,
                ))
                .child(button(
                    "bulk-delete",
                    "trash",
                    "Delete Forever",
                    ThreadAction::DeleteForever,
                    cx,
                ));
        } else {
            bar = bar
                .child(button(
                    "bulk-archive",
                    "archive",
                    "Archive",
                    ThreadAction::Archive,
                    cx,
                ))
                .child(button(
                    "bulk-trash",
                    "trash",
                    "Move to Trash",
                    ThreadAction::Trash,
                    cx,
                ))
                .child(button(
                    "bulk-spam",
                    "archive-x",
                    "Move to Junk",
                    ThreadAction::Spam,
                    cx,
                ));
        }
        bar.child(button(
            "bulk-read",
            "mail-open",
            "Mark as Read",
            ThreadAction::MarkRead,
            cx,
        ))
        .child(button(
            "bulk-unread",
            "mail",
            "Mark as Unread",
            ThreadAction::MarkUnread,
            cx,
        ))
        .child(
            tool_button("bulk-clear", "x", "Clear Selection", Some("escape"))
                .on_click(cx.listener(|this, _, _, cx| this.clear_checked(cx))),
        )
    }

    pub fn show_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_view.is_none() {
            self.settings_view = Some(cx.new(|cx| crate::settings::SettingsView::new(window, cx)));
        }
        self.browser
            .update(cx, |browser, cx| browser.set_visible(false, cx));
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn hide_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_view = None;
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn toggle_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::browser::SUPPORTED {
            return;
        }
        self.browser_open = !self.browser_open;
        self.backend.set_ui_pref(
            "gmail:chat-open",
            Some(if self.browser_open { "1" } else { "0" }.into()),
        );
        self.browser.update(cx, |browser, cx| {
            browser.set_visible(self.browser_open && self.settings_view.is_none(), cx)
        });
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn new_browser_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::browser::SUPPORTED {
            return;
        }
        self.browser_open = true;
        self.settings_view = None;
        self.browser
            .update(cx, |browser, cx| browser.new_tab(window, cx));
        cx.notify();
    }

    pub fn focus_browser_address(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !crate::browser::SUPPORTED {
            return;
        }
        self.browser_open = true;
        self.settings_view = None;
        self.browser
            .update(cx, |browser, cx| browser.focus_address(window, cx));
        cx.notify();
    }

    pub fn open_link(&mut self, url: &str, window: &mut Window, cx: &mut Context<Self>) {
        if url.starts_with("mailto:") {
            let email = url
                .trim_start_matches("mailto:")
                .split('?')
                .next()
                .unwrap_or_default();
            self.compose(
                ComposeMode::New {
                    account_id: None,
                    to: vec![Person {
                        name: None,
                        email: email.into(),
                    }],
                },
                window,
                cx,
            );
            return;
        }
        if !crate::browser::SUPPORTED
            || self.backend.ui_pref("otter:browser:open-links").as_deref() == Some("false")
        {
            let _ = open::that_detached(url);
            return;
        }
        if let Some(url) = crate::browser::address_to_url(url) {
            self.browser_open = true;
            self.settings_view = None;
            self.browser
                .update(cx, |browser, cx| browser.open(url, window, cx));
            cx.notify();
        }
    }

    pub fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_collapsed = !self.sidebar_collapsed;
        self.backend.set_ui_pref(
            "gmail:sidebar-open",
            Some(if self.sidebar_collapsed { "0" } else { "1" }.into()),
        );
        cx.notify();
    }

    fn available_width(window: &Window) -> f32 {
        (window.viewport_size().width.as_f32() - RAIL_WIDTH - 6.).max(0.)
    }

    fn pane_widths(&self, window: &Window) -> PaneWidths {
        PaneWidths {
            sidebar: self.sidebar_width,
            list: self.list_width,
            browser: self.browser_width,
        }
        .fit(
            Self::available_width(window),
            !self.sidebar_collapsed,
            self.browser_open,
        )
    }

    fn render_resize_handle(&self, pane: Pane, window: &Window, cx: &Context<Self>) -> AnyElement {
        let weak = cx.entity().downgrade();
        let widths = self.pane_widths(window);
        let handle = resize_handle(format!("pane-{pane:?}"), Axis::Horizontal)
            .with_appearance(resize_handle_appearance())
            .on_drag(
                PaneDrag {
                    pane,
                    start_x: Rc::new(Cell::new(0.)),
                    widths,
                },
                move |drag, _, window, cx| {
                    if let Some(ws) = weak.upgrade() {
                        ws.update(cx, |ws, cx| {
                            drag.start_x.set(ws.mouse_down_x);
                            ws.resizing = true;
                            ws.resize_pane(&drag, window.mouse_position().x.as_f32(), window, cx);
                            ws.browser
                                .update(cx, |browser, cx| browser.set_visible(false, cx));
                            cx.notify();
                        });
                    }
                    cx.new(|_| drag.as_ref().clone())
                },
            );
        if matches!(pane, Pane::Browser) {
            handle.inside(HandleEdge::Trailing).into_any_element()
        } else {
            handle.into_any_element()
        }
    }

    fn resize_pane(&mut self, drag: &PaneDrag, x: f32, window: &Window, cx: &mut Context<Self>) {
        let widths = drag.widths.drag(
            drag.pane,
            x - drag.start_x.get(),
            Self::available_width(window),
        );
        match drag.pane {
            Pane::Sidebar => self.sidebar_width = widths.sidebar,
            Pane::List => self.list_width = widths.list,
            Pane::Browser => self.browser_width = widths.browser,
        }
        cx.notify();
    }

    fn finish_resize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.resizing {
            return;
        }
        self.resizing = false;
        let visible = self.browser_open
            && self.settings_view.is_none()
            && !window.has_active_dialog(cx)
            && !window.has_active_sheet(cx);
        self.browser
            .update(cx, |browser, cx| browser.set_visible(visible, cx));
        window.refresh();
        for (key, width) in [
            ("gmail:pane:sidebar", self.sidebar_width),
            ("gmail:pane:list", self.list_width),
            ("gmail:pane:chat", self.browser_width),
        ] {
            self.backend.set_ui_pref(key, Some(width.to_string()));
        }
        cx.notify();
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The list highlights the open (or keyboard-selected) conversation.
        let ix = self
            .selected
            .as_ref()
            .and_then(|r| self.list.read(cx).delegate().index_of(r));
        if self.list.read(cx).selected_index() != ix {
            self.list
                .update(cx, |list, cx| list.set_selected_index(ix, window, cx));
        }
        let settings = self.settings_view.clone();
        let visible = self.browser_open
            && !self.resizing
            && settings.is_none()
            && !window.has_active_dialog(cx)
            && !window.has_active_sheet(cx);
        self.browser
            .update(cx, |browser, cx| browser.set_visible(visible, cx));
        let theme = cx.theme().clone();
        let content = if let Some(settings) = settings {
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .child(settings)
                .into_any_element()
        } else {
            let widths = self.pane_widths(window);
            h_flex()
                .size_full()
                .min_w_0()
                .when(!self.sidebar_collapsed, |el| {
                    el.child(
                        div()
                            .w(px(widths.sidebar))
                            .h_full()
                            .flex_none()
                            .child(self.render_sidebar(window, cx)),
                    )
                })
                .child(
                    div()
                        .w(px(widths.list))
                        .h_full()
                        .flex_none()
                        .relative()
                        .child(self.render_list_pane(window, cx))
                        .when(!self.sidebar_collapsed, |el| {
                            el.child(self.render_resize_handle(Pane::Sidebar, window, cx))
                        }),
                )
                .child(
                    div()
                        .w(px((Self::available_width(window)
                            - widths.sidebar
                            - widths.list
                            - widths.browser)
                            .max(0.)))
                        .flex_none()
                        .min_w_0()
                        .h_full()
                        .relative()
                        .child(
                            div()
                                .size_full()
                                .overflow_hidden()
                                .child(self.render_main(window, cx)),
                        )
                        .child(self.render_resize_handle(Pane::List, window, cx))
                        .when(self.browser_open, |el| {
                            el.child(self.render_resize_handle(Pane::Browser, window, cx))
                        }),
                )
                .when(self.browser_open, |el| {
                    el.child(
                        div()
                            .w(px(widths.browser))
                            .h_full()
                            .flex_none()
                            .border_l_1()
                            .border_color(theme.border.opacity(0.7))
                            .child(self.browser.clone()),
                    )
                })
                .into_any_element()
        };
        v_flex()
            .id("workspace")
            .key_context(if self.settings_view.is_some() {
                "Settings"
            } else {
                "Workspace"
            })
            .track_focus(&self.focus)
            .size_full()
            .bg(theme.title_bar)
            .text_color(theme.foreground)
            .text_size(px(13.))
            .map(|el| crate::actions::bind(el, cx))
            .on_drag_move(
                cx.listener(|this, event: &DragMoveEvent<Rc<PaneDrag>>, window, cx| {
                    let drag = event.drag(cx).clone();
                    this.resize_pane(&drag, event.event.position.x.as_f32(), window, cx);
                }),
            )
            .on_drop(
                cx.listener(|this, _: &Rc<PaneDrag>, window, cx| this.finish_resize(window, cx)),
            )
            // Observe the press and release at window level: child controls and
            // the native webview can occlude the workspace's own hitbox.
            .child(
                canvas(|_, _, _| {}, {
                    let workspace = cx.entity().downgrade();
                    move |_, _, window, _| {
                        let down = workspace.clone();
                        window.on_mouse_event(move |event: &MouseDownEvent, phase, _, cx| {
                            if phase.capture() && event.button == MouseButton::Left {
                                if let Some(ws) = down.upgrade() {
                                    ws.update(cx, |ws, _| {
                                        ws.mouse_down_x = event.position.x.as_f32()
                                    });
                                }
                            }
                        });
                        let up = workspace.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
                            if phase.capture() && event.button == MouseButton::Left {
                                if let Some(ws) = up.upgrade() {
                                    ws.update(cx, |ws, cx| ws.finish_resize(window, cx));
                                }
                            }
                        });
                    }
                })
                .absolute()
                .size_0(),
            )
            .child(self.render_title_bar(window, cx))
            .child(
                h_flex()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .items_start()
                    .child(self.render_rail(window, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .pr(px(4.))
                            .pb(px(4.))
                            .child(
                                div()
                                    .size_full()
                                    .rounded(px(12.))
                                    .overflow_hidden()
                                    .border_1()
                                    .border_color(theme.foreground.opacity(0.05))
                                    .bg(theme.background)
                                    .child(content),
                            ),
                    ),
            )
    }
}
