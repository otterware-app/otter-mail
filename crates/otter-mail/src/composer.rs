//! Writing mail: a new message (in the reader pane), a reply or forward (a
//! card under the conversation), or an opened draft. Drafts save as you type;
//! sending waits 10 seconds so it can be undone (the workspace does that).

use std::time::Duration;

use gpui_kit::component::Selectable as _;
use gpui_kit::component::StyledExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::{ActiveTheme as _, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::Backend;
use mail_core::backend::ThreadRef;
use mail_core::model::*;
use mail_core::text;

use crate::app::AppBackend;
use crate::ui::{file_size, icon, shortcut_text, tool_button};

actions!(composer, [SendMessage, CloseComposer]);

pub fn key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("secondary-enter", SendMessage, Some("Composer")),
        KeyBinding::new("escape", CloseComposer, Some("Composer")),
    ]
}

#[derive(Clone, Debug)]
pub enum ComposeMode {
    New {
        account_id: Option<String>,
        to: Vec<Person>,
    },
    Reply {
        all: bool,
    },
    Forward,
    Draft {
        message: Box<Message>,
    },
}

pub enum ComposerEvent {
    Close,
    /// The message to send once the undo window passes.
    Send {
        draft: Draft,
    },
}

impl EventEmitter<ComposerEvent> for Composer {}

pub struct Composer {
    backend: Backend,
    mode: ComposeMode,
    account_id: String,
    accounts: Vec<Account>,
    thread: Option<Thread>,
    to: Entity<InputState>,
    cc: Entity<InputState>,
    bcc: Entity<InputState>,
    subject: Entity<InputState>,
    body: Entity<TextareaState>,
    show_cc: bool,
    attachments: Vec<OutgoingAttachment>,
    draft_id: Option<String>,
    status: Option<SharedString>,
    dirty: bool,
    save_task: Option<Task<()>>,
    quoted: String,
    in_reply_to: Option<String>,
    references: Option<String>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

fn people_text(people: &[Person]) -> String {
    people
        .iter()
        .map(Person::to_header)
        .collect::<Vec<_>>()
        .join(", ")
}

fn plain_body(m: &Message) -> String {
    m.body_text
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| m.body_html.as_deref().map(text::html_to_text))
        .unwrap_or_default()
}

impl Composer {
    pub fn new(
        mode: ComposeMode,
        account_id: String,
        accounts: Vec<Account>,
        thread: Option<Thread>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let backend = cx.global::<AppBackend>().0.clone();
        let me = accounts
            .iter()
            .find(|a| a.id == account_id)
            .map(|a| a.email.to_lowercase())
            .unwrap_or_default();
        let mut to_people = vec![];
        let mut cc_people: Vec<Person> = vec![];
        let mut subject = String::new();
        let mut body = String::new();
        let mut quoted = String::new();
        let (mut in_reply_to, mut references, mut draft_id) = (None, None, None);
        let mut forwarded: Vec<(String, Attachment)> = vec![];
        let last = thread
            .as_ref()
            .and_then(|t| t.messages.iter().rev().find(|m| !m.draft).cloned());
        match &mode {
            ComposeMode::New { to, .. } => to_people = to.clone(),
            ComposeMode::Reply { all } => {
                if let Some(m) = &last {
                    to_people = if m.from.email.to_lowercase() == me {
                        m.to.clone()
                    } else if !m.reply_to.is_empty() {
                        m.reply_to.clone()
                    } else {
                        vec![m.from.clone()]
                    };
                    if *all {
                        let mut seen: Vec<String> =
                            to_people.iter().map(|p| p.email.to_lowercase()).collect();
                        seen.push(me.clone());
                        for p in m.to.iter().chain(m.cc.iter()) {
                            if !seen.contains(&p.email.to_lowercase()) {
                                seen.push(p.email.to_lowercase());
                                cc_people.push(p.clone());
                            }
                        }
                    }
                    subject = text::prefix_subject("Re:", &m.subject);
                    in_reply_to = m.message_id_header.clone();
                    references = match (&m.references, &m.message_id_header) {
                        (Some(r), Some(id)) => Some(format!("{r} {id}")),
                        (None, Some(id)) => Some(id.clone()),
                        (r, None) => r.clone(),
                    };
                    let lines: Vec<String> =
                        plain_body(m).lines().map(|l| format!("> {l}")).collect();
                    quoted = format!(
                        "\n\nOn {}, {} wrote:\n{}",
                        crate::ui::full_date(m.date),
                        m.from.to_header(),
                        lines.join("\n")
                    );
                }
            }
            ComposeMode::Forward => {
                if let Some(m) = &last {
                    subject = text::prefix_subject("Fwd:", &m.subject);
                    body = format!(
                        "\n\n---------- Forwarded message ----------\nFrom: {}\nDate: {}\nSubject: {}\nTo: {}\n\n{}",
                        m.from.to_header(),
                        crate::ui::full_date(m.date),
                        m.subject,
                        people_text(&m.to),
                        plain_body(m)
                    );
                    forwarded = m
                        .attachments
                        .iter()
                        .map(|a| (m.id.clone(), a.clone()))
                        .collect();
                }
            }
            ComposeMode::Draft { message } => {
                to_people = message.to.clone();
                cc_people = message.cc.clone();
                subject = message.subject.clone();
                body = plain_body(message);
                draft_id = (!message.id.is_empty()).then(|| message.id.clone());
                in_reply_to = message.in_reply_to.clone();
                references = message.references.clone();
            }
        }
        if matches!(mode, ComposeMode::New { .. }) {
            if let Some(sig) = accounts
                .iter()
                .find(|a| a.id == account_id)
                .and_then(|a| a.signature.clone())
                .filter(|s| !s.trim().is_empty())
            {
                body = format!("\n\n{}", text::html_to_text(&sig).trim_end());
            }
        }
        let placeholder = match &mode {
            ComposeMode::Reply { all: false } => "Write a reply…",
            ComposeMode::Reply { all: true } => "Reply to everyone…",
            ComposeMode::Forward => "Add a note (optional)…",
            _ => "Write your message…",
        };
        let inline = matches!(mode, ComposeMode::Reply { .. } | ComposeMode::Forward);
        let to = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("To")
                .default_value(people_text(&to_people))
        });
        let cc = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Cc")
                .default_value(people_text(&cc_people))
        });
        let bcc = cx.new(|cx| InputState::new(window, cx).placeholder("Bcc"));
        let subject_input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Subject")
                .default_value(subject)
        });
        let body_input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder(placeholder)
                .auto_grow(if inline { 4 } else { 16 }, if inline { 12 } else { 400 })
                .default_value(body)
        });
        let mut subs = Vec::new();
        for input in [&to, &cc, &bcc, &subject_input] {
            subs.push(
                cx.subscribe_in(input, window, |this, _, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.changed(window, cx);
                    }
                }),
            );
        }
        subs.push(cx.subscribe_in(
            &body_input,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.changed(window, cx);
                }
            },
        ));
        let mut this = Composer {
            backend,
            mode,
            account_id,
            accounts,
            thread,
            to,
            cc,
            bcc,
            subject: subject_input,
            body: body_input,
            show_cc: !cc_people.is_empty(),
            attachments: vec![],
            draft_id,
            status: None,
            dirty: false,
            save_task: None,
            quoted,
            in_reply_to,
            references,
            focus: cx.focus_handle(),
            _subscriptions: subs,
        };
        if !forwarded.is_empty() {
            this.fetch_forwarded(forwarded, window, cx);
        }
        this
    }

    fn fetch_forwarded(
        &mut self,
        list: Vec<(String, Attachment)>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let backend = self.backend.clone();
        let account = self.account_id.clone();
        self.status = Some("Adding attachments…".into());
        cx.spawn_in(window, async move |this, cx| {
            let mut out = Vec::new();
            for (message_id, a) in list {
                let b = backend.clone();
                let (account, id) = (account.clone(), a.id.clone());
                if let Ok(data) = backend
                    .spawn(async move { b.attachment(account, message_id, id).await })
                    .await
                {
                    out.push(OutgoingAttachment {
                        filename: a.filename,
                        mime_type: a.mime_type,
                        data,
                    });
                }
            }
            let _ = this.update(cx, |this, cx| {
                this.attachments.extend(out);
                this.status = None;
                cx.notify();
            });
        })
        .detach();
    }

    pub fn inline_reply_for(&self, r: &ThreadRef) -> bool {
        self.is_inline()
            && self
                .thread
                .as_ref()
                .is_some_and(|t| t.account_id == r.account_id && t.id == r.thread_id)
    }

    pub fn is_inline(&self) -> bool {
        matches!(self.mode, ComposeMode::Reply { .. } | ComposeMode::Forward)
    }

    pub fn focus_first(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.to.read(cx).value().trim().is_empty() {
            self.to.update(cx, |i, cx| i.focus(window, cx));
        } else {
            self.body.update(cx, |i, cx| i.focus(window, cx));
        }
    }

    fn changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dirty = true;
        self.status = None;
        self.save_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(1500))
                .await;
            let _ = this.update(cx, |this, cx| this.save(cx));
        }));
        cx.notify();
    }

    pub fn draft(&self, cx: &App) -> Draft {
        let people = |input: &Entity<InputState>| text::parse_address_list(&input.read(cx).value());
        let body_text = format!("{}{}", self.body.read(cx).value(), self.quoted);
        Draft {
            account_id: self.account_id.clone(),
            draft_id: self.draft_id.clone(),
            thread_id: match &self.mode {
                ComposeMode::Reply { .. } => self.thread.as_ref().map(|t| t.id.clone()),
                ComposeMode::Draft { message } => (!message.thread_id.is_empty()
                    && message.thread_id != message.id)
                    .then(|| message.thread_id.clone()),
                _ => None,
            },
            to: people(&self.to),
            cc: people(&self.cc),
            bcc: people(&self.bcc),
            subject: self.subject.read(cx).value().to_string(),
            body_html: crate::body::text_to_html(&body_text),
            body_text,
            in_reply_to: self.in_reply_to.clone(),
            references: self.references.clone(),
            attachments: self.attachments.clone(),
        }
    }

    fn is_empty(&self, cx: &App) -> bool {
        self.body.read(cx).value().trim().is_empty()
            && self.subject.read(cx).value().trim().is_empty()
            && self.attachments.is_empty()
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if !self.dirty || self.is_empty(cx) {
            return;
        }
        let draft = self.draft(cx);
        self.dirty = false;
        self.status = Some("Saving draft…".into());
        cx.notify();
        let backend = self.backend.clone();
        let task = {
            let b = backend.clone();
            backend.spawn(async move { b.save_draft(draft).await })
        };
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok(saved) => {
                        this.draft_id = Some(saved.draft_id);
                        this.status = Some("Draft saved".into());
                    }
                    Err(err) => {
                        log::warn!("saving the draft: {err:#}");
                        this.dirty = true;
                        this.status = Some("Couldn't save draft".into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Keeps what was written as a draft (the composer is going away).
    pub fn save_now(&mut self, cx: &mut Context<Self>) {
        self.save_task = None;
        if self.dirty && !self.is_empty(cx) {
            let draft = self.draft(cx);
            let backend = self.backend.clone();
            let b = backend.clone();
            backend.run(async move {
                if let Err(err) = b.save_draft(draft).await {
                    log::warn!("saving the draft: {err:#}");
                }
            });
        }
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use gpui_kit::component::notification::Notification;
        let draft = self.draft(cx);
        let recipients: Vec<&Person> = draft.to.iter().chain(&draft.cc).chain(&draft.bcc).collect();
        if recipients.is_empty() {
            window.push_notification(Notification::warning("Add a recipient"), cx);
            return;
        }
        if let Some(bad) = recipients.iter().find(|p| !p.email.contains('@')) {
            window.push_notification(
                Notification::warning(format!("“{}” isn't an address", bad.email)),
                cx,
            );
            return;
        }
        self.save_task = None;
        cx.emit(ComposerEvent::Send { draft });
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        self.save_now(cx);
        cx.emit(ComposerEvent::Close);
    }

    fn discard(&mut self, cx: &mut Context<Self>) {
        self.save_task = None;
        if let Some(id) = self.draft_id.clone() {
            let backend = self.backend.clone();
            let b = backend.clone();
            let account = self.account_id.clone();
            backend.run(async move {
                let _ = b.delete_draft(account, id).await;
            });
        }
        cx.emit(ComposerEvent::Close);
    }

    fn attach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some("Attach".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let mut added = Vec::new();
            for path in paths {
                if let Ok(data) = std::fs::read(&path) {
                    let filename = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "attachment".into());
                    added.push(OutgoingAttachment {
                        mime_type: mime_for(&filename).into(),
                        filename,
                        data,
                    });
                }
            }
            let _ = this.update_in(cx, |this, window, cx| {
                let total: usize = this
                    .attachments
                    .iter()
                    .chain(&added)
                    .map(|a| a.data.len())
                    .sum();
                if total > mail_core::mime::MAX_ATTACHMENT_BYTES {
                    window.push_notification(
                        gpui_kit::component::notification::Notification::warning(
                            "Attachments can add up to 25 MB",
                        ),
                        cx,
                    );
                    return;
                }
                this.attachments.extend(added);
                this.changed(window, cx);
            });
        })
        .detach();
    }

    fn from_picker(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let current = self
            .accounts
            .iter()
            .find(|a| a.id == self.account_id)
            .map(|a| a.email.clone())
            .unwrap_or_default();
        let accounts: Vec<Account> = self
            .accounts
            .iter()
            .filter(|a| a.enabled && !a.signed_out)
            .cloned()
            .collect();
        let weak = cx.entity().downgrade();
        Button::new("from")
            .ghost()
            .small()
            .label(current)
            .icon(icon("chevron-down").size(px(14.)))
            .dropdown_menu(move |mut menu, _, _| {
                for a in &accounts {
                    let weak = weak.clone();
                    let id = a.id.clone();
                    menu = menu.item(PopupMenuItem::new(a.email.clone()).on_click(
                        move |_, _, cx| {
                            if let Some(this) = weak.upgrade() {
                                this.update(cx, |this, cx| {
                                    this.account_id = id.clone();
                                    cx.notify();
                                });
                            }
                        },
                    ));
                }
                menu
            })
    }

    fn footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        h_flex()
            .gap_1()
            .child(
                tool_button("attach", "paperclip", "Attach Files", None)
                    .on_click(cx.listener(|this, _, w, cx| this.attach(w, cx))),
            )
            .child(
                tool_button("discard", "trash", "Discard Draft", None)
                    .on_click(cx.listener(|this, _, _, cx| this.discard(cx))),
            )
            .when_some(self.status.clone(), |el, s| {
                el.child(
                    div()
                        .pl_1()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(s),
                )
            })
            .child(div().flex_1())
            .child(
                Button::new("send")
                    .primary()
                    .small()
                    .rounded_full()
                    .label(format!("Send  {}", shortcut_text("cmd-enter")))
                    .on_click(cx.listener(|this, _, w, cx| this.send(w, cx))),
            )
    }

    fn attachment_tags(&self, cx: &mut Context<Self>) -> impl IntoElement {
        h_flex()
            .flex_wrap()
            .gap_1()
            .children(self.attachments.iter().enumerate().map(|(i, a)| {
                Button::new(SharedString::from(format!("att-{i}")))
                    .outline()
                    .xsmall()
                    .icon(icon("x"))
                    .label(format!(
                        "{} · {}",
                        a.filename,
                        file_size(a.data.len() as i64)
                    ))
                    .tooltip("Remove")
                    .on_click(cx.listener(move |this, _, w, cx| {
                        if i < this.attachments.len() {
                            this.attachments.remove(i);
                        }
                        this.changed(w, cx);
                    }))
            }))
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Composer {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let inline = self.is_inline();
        let multiple = self.accounts.iter().filter(|a| a.enabled).count() > 1;
        let title = match &self.mode {
            ComposeMode::Reply { all: false } => "Reply",
            ComposeMode::Reply { all: true } => "Reply All",
            ComposeMode::Forward => "Forward",
            ComposeMode::Draft { .. } => "Draft",
            ComposeMode::New { .. } => "New Message",
        };
        let header = h_flex()
            .gap_2()
            .child(div().flex_1().font_semibold().child(title))
            .when(multiple && !inline, |el| el.child(self.from_picker(cx)))
            .child(
                Button::new("toggle-cc")
                    .ghost()
                    .small()
                    .label("Cc/Bcc")
                    .selected(self.show_cc)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.show_cc = !this.show_cc;
                        cx.notify();
                    })),
            )
            .child(
                tool_button("close-composer", "x", "Close", Some("escape"))
                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
            );
        let fields = v_flex()
            .gap_2()
            .child(Input::new(&self.to).small())
            .when(self.show_cc, |el| {
                el.child(Input::new(&self.cc).small())
                    .child(Input::new(&self.bcc).small())
            })
            .when(!inline, |el| el.child(Input::new(&self.subject).small()));
        let content = v_flex()
            .gap_3()
            .child(header)
            .child(fields)
            .child(Textarea::new(&self.body))
            .when(!self.attachments.is_empty(), |el| {
                el.child(self.attachment_tags(cx))
            })
            .child(self.footer(cx));
        let root = div()
            .key_context("Composer")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &SendMessage, w, cx| this.send(w, cx)))
            .on_action(cx.listener(|this, _: &CloseComposer, _, cx| this.close(cx)));
        if inline {
            root.child(
                div()
                    .p_3()
                    .rounded(theme.radius_lg)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.background)
                    .shadow_md()
                    .child(content),
            )
        } else {
            let account = self.accounts.iter().find(|a| a.id == self.account_id);
            let email = account.map(|a| a.email.clone()).unwrap_or_default();
            let from = h_flex()
                .h(px(40.))
                .border_b_1()
                .border_color(theme.border.opacity(0.6))
                .gap_4()
                .child(
                    div()
                        .w(px(52.))
                        .flex_none()
                        .text_size(px(14.))
                        .text_color(theme.muted_foreground)
                        .child("From"),
                )
                .child(if multiple {
                    self.from_picker(cx).into_any_element()
                } else {
                    div().text_size(px(14.)).child(email).into_any_element()
                });
            let to = h_flex()
                .h(px(40.))
                .border_b_1()
                .border_color(theme.border.opacity(0.6))
                .gap_4()
                .child(
                    div()
                        .w(px(52.))
                        .flex_none()
                        .text_size(px(14.))
                        .text_color(theme.muted_foreground)
                        .child("To"),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(Input::new(&self.to).small().appearance(false)),
                )
                .child(
                    Button::new("compose-cc")
                        .ghost()
                        .small()
                        .label("Cc")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_cc = !this.show_cc;
                            cx.notify();
                        })),
                )
                .child(
                    Button::new("compose-bcc")
                        .ghost()
                        .small()
                        .label("Bcc")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.show_cc = !this.show_cc;
                            cx.notify();
                        })),
                );
            root.size_full().child(
                v_flex()
                    .size_full()
                    .child(
                        h_flex()
                            .h(px(40.))
                            .px_4()
                            .flex_none()
                            .child(
                                div()
                                    .flex_1()
                                    .text_size(px(14.))
                                    .text_color(theme.muted_foreground)
                                    .child(title),
                            )
                            .child(
                                tool_button("close-new-message", "x", "Close", Some("escape"))
                                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                            ),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_h_0()
                            .w_full()
                            .max_w(px(800.))
                            .mx_auto()
                            .px_6()
                            .gap_2()
                            .child(from)
                            .child(to)
                            .when(self.show_cc, |el| {
                                el.child(Input::new(&self.cc).small().appearance(false))
                                    .child(Input::new(&self.bcc).small().appearance(false))
                            })
                            .child(
                                div().mt_4().child(
                                    Input::new(&self.subject)
                                        .appearance(false)
                                        .text_size(px(20.)),
                                ),
                            )
                            .child(
                                div().flex_1().min_h_0().child(
                                    Textarea::new(&self.body).appearance(false).h(relative(1.)),
                                ),
                            )
                            .when(!self.attachments.is_empty(), |el| {
                                el.child(self.attachment_tags(cx))
                            }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .border_t_1()
                            .border_color(theme.border.opacity(0.4))
                            .px_6()
                            .py_3()
                            .child(div().max_w(px(752.)).mx_auto().child(self.footer(cx))),
                    ),
            )
        }
    }
}

pub fn mime_for(filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ics" => "text/calendar",
        "json" => "application/json",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}
