//! The reader pane: the open conversation (a toolbar of actions, its
//! messages, attachments, an inline reply), or a full-page new message.

use gpui_kit::component::Selectable as _;
use gpui_kit::component::StyledExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::separator::Separator;
use gpui_kit::component::{
    ActiveTheme as _, Sizable as _, WindowExt as _, h_flex, notification::Notification, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::backend::ThreadRef;
use mail_core::model::*;

use crate::composer::ComposeMode;
use crate::ui::{file_size, full_date, icon, label_tag, message_date, person_avatar, tool_button};
use crate::workspace::{Main, Workspace};

impl Workspace {
    pub fn render_main(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if self.main == Main::Compose {
            if let Some(composer) = &self.composer {
                return div().size_full().child(composer.clone()).into_any_element();
            }
        }
        if self.open.is_some() {
            return self.render_reader(window, cx).into_any_element();
        }
        let theme = cx.theme();
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(theme.muted_foreground)
            .child(icon("mail").size_10())
            .child(
                div()
                    .text_size(px(24.))
                    .text_color(theme.foreground)
                    .child("Select a conversation"),
            )
            .child(
                div()
                    .text_sm()
                    .child("Choose a message from the list to read it here."),
            )
            .into_any_element()
    }

    pub fn render_reader_toolbar(
        &mut self,
        width: f32,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let compact = width < 500.;
        let open = self.open.as_ref().unwrap();
        let r = open.r.clone();
        let thread = open.thread.clone();
        let row = self.row(&r, cx);
        let subject = thread
            .as_ref()
            .map(|t| t.subject.clone())
            .or_else(|| row.as_ref().map(|r| r.subject.clone()))
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "(no subject)".into());
        let label_ids: Vec<String> = thread
            .as_ref()
            .map(|t| t.label_ids.clone())
            .or_else(|| row.as_ref().map(|r| r.label_ids.clone()))
            .unwrap_or_default();
        let has = |id: &str| label_ids.iter().any(|l| l == id);
        let (in_inbox, in_trash, in_spam, starred) =
            (has("INBOX"), has("TRASH"), has("SPAM"), has("STARRED"));
        let unread = row.as_ref().is_some_and(|r| r.unread);

        let mut tags = h_flex().gap_1().flex_wrap();
        if in_inbox {
            tags = tags.child(label_tag("Inbox", None, cx));
        }
        for id in &label_ids {
            if let Some(l) = self.label(&r.account_id, id) {
                if !l.system && !l.id.starts_with("CATEGORY_") {
                    tags = tags.child(label_tag(l.leaf_name(), l.background_color.as_deref(), cx));
                }
            }
        }

        let archive = if in_trash {
            tool_button("reader-restore", "rotate-ccw", "Restore from Trash", None)
                .on_click(cx.listener(|this, _, w, cx| this.act(ThreadAction::Untrash, w, cx)))
        } else if in_inbox {
            tool_button("reader-archive", "archive", "Archive", Some("e"))
                .on_click(cx.listener(|this, _, w, cx| this.act(ThreadAction::Archive, w, cx)))
        } else {
            tool_button(
                "reader-move-to-inbox",
                "archive-restore",
                "Move to Inbox",
                None,
            )
            .on_click(cx.listener(|this, _, w, cx| this.act(ThreadAction::MoveToInbox, w, cx)))
        };
        let weak = cx.entity().downgrade();
        let more = Button::new("reader-more")
            .ghost()
            .small()
            .icon(icon("ellipsis"))
            .tooltip("More")
            .accessibility_label("More message actions")
            .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                let act = |action: ThreadAction| {
                    let weak = weak.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        if let Some(ws) = weak.upgrade() {
                            let action = action.clone();
                            ws.update(cx, |ws, cx| ws.act(action, window, cx));
                        }
                    }
                };
                let unsubscribe = {
                    let weak = weak.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        if let Some(ws) = weak.upgrade() {
                            ws.update(cx, |ws, cx| ws.unsubscribe(window, cx));
                        }
                    }
                };
                let run = |f: fn(&mut Workspace, &mut Window, &mut Context<Workspace>)| {
                    let weak = weak.clone();
                    move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                        if let Some(ws) = weak.upgrade() {
                            ws.update(cx, |ws, cx| f(ws, window, cx));
                        }
                    }
                };
                let menu = if compact {
                    menu.item(
                        PopupMenuItem::new("Reply All")
                            .icon(icon("reply-all"))
                            .on_click(run(|ws, w, cx| {
                                ws.compose(ComposeMode::Reply { all: true }, w, cx)
                            })),
                    )
                    .item(
                        PopupMenuItem::new("Forward")
                            .icon(icon("forward"))
                            .on_click(run(|ws, w, cx| ws.compose(ComposeMode::Forward, w, cx))),
                    )
                    .when(in_inbox && !in_trash, |menu| {
                        menu.item(
                            PopupMenuItem::new("Snooze")
                                .icon(icon("clock"))
                                .on_click(run(Workspace::prompt_snooze)),
                        )
                    })
                    .when(!in_trash, |menu| {
                        menu.item(
                            PopupMenuItem::new("Move to Trash")
                                .icon(icon("trash"))
                                .on_click(act(ThreadAction::Trash)),
                        )
                    })
                    .item(
                        PopupMenuItem::new("Label")
                            .icon(icon("tag"))
                            .on_click(run(Workspace::open_label_picker)),
                    )
                    .item(
                        PopupMenuItem::new(if starred { "Unflag" } else { "Flag" })
                            .icon(icon("flag"))
                            .on_click(run(Workspace::toggle_star)),
                    )
                    .separator()
                } else {
                    menu
                };
                let mut menu = menu
                    .item(
                        PopupMenuItem::new(if unread {
                            "Mark as Read"
                        } else {
                            "Mark as Unread"
                        })
                        .icon(icon(if unread { "mail-open" } else { "mail" }))
                        .on_click(act(if unread {
                            ThreadAction::MarkRead
                        } else {
                            ThreadAction::MarkUnread
                        })),
                    )
                    .item(if in_spam {
                        PopupMenuItem::new("Not Junk")
                            .icon(icon("shield-check"))
                            .on_click(act(ThreadAction::NotSpam))
                    } else {
                        PopupMenuItem::new("Move to Junk")
                            .icon(icon("archive-x"))
                            .on_click(act(ThreadAction::Spam))
                    })
                    .item(
                        PopupMenuItem::new("Unsubscribe")
                            .icon(icon("mail-x"))
                            .on_click(unsubscribe),
                    );
                if in_trash || in_spam {
                    let weak = weak.clone();
                    menu = menu.separator().item(
                        PopupMenuItem::new("Delete Forever…")
                            .icon(icon("trash"))
                            .on_click(move |_, window, cx| {
                                if let Some(ws) = weak.upgrade() {
                                    ws.update(cx, |ws, cx| {
                                        let t = ws.targets(cx);
                                        ws.confirm_delete_forever(t, window, cx)
                                    });
                                }
                            }),
                    );
                }
                menu
            });

        let toolbar = h_flex()
            .occlude()
            .w_full()
            .min_w_0()
            .h(px(crate::ui::TITLE_HEIGHT))
            .flex_none()
            .gap_1()
            .px_4()
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .overflow_hidden()
                    .gap_2()
                    .child(div().min_w_0().truncate().text_size(px(14.)).child(subject))
                    .when(width >= 640., |el| el.child(tags)),
            )
            .child(
                tool_button("reader-reply", "reply", "Reply", Some("r")).on_click(cx.listener(
                    |this, _, w, cx| this.compose(ComposeMode::Reply { all: false }, w, cx),
                )),
            )
            .when(!compact, |el| {
                el.child(
                    tool_button("reader-reply-all", "reply-all", "Reply All", Some("a")).on_click(
                        cx.listener(|this, _, w, cx| {
                            this.compose(ComposeMode::Reply { all: true }, w, cx)
                        }),
                    ),
                )
                .child(
                    tool_button("reader-forward", "forward", "Forward", Some("f")).on_click(
                        cx.listener(|this, _, w, cx| this.compose(ComposeMode::Forward, w, cx)),
                    ),
                )
                .child(Separator::vertical().h_4().mx_1())
            })
            .child(archive)
            .when(!compact && in_inbox && !in_trash, |el| {
                el.child(
                    tool_button("reader-snooze", "clock", "Snooze", None)
                        .on_click(cx.listener(|this, _, w, cx| this.prompt_snooze(w, cx))),
                )
            })
            .when(!compact && !in_trash, |el| {
                el.child(
                    tool_button("reader-trash", "trash", "Move to Trash", Some("#")).on_click(
                        cx.listener(|this, _, w, cx| this.act(ThreadAction::Trash, w, cx)),
                    ),
                )
            })
            .when(!compact, |el| {
                el.child(
                    tool_button("reader-label", "tag", "Label", Some("l"))
                        .on_click(cx.listener(|this, _, w, cx| this.open_label_picker(w, cx))),
                )
                .child(
                    tool_button(
                        "reader-flag",
                        "flag",
                        if starred { "Unflag" } else { "Flag" },
                        Some("s"),
                    )
                    .selected(starred)
                    .on_click(cx.listener(|this, _, w, cx| this.toggle_star(w, cx))),
                )
            })
            .child(more);
        toolbar.into_any_element()
    }

    fn render_reader(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let open = self.open.as_ref().unwrap();
        let r = open.r.clone();
        let thread = open.thread.clone();
        let loading = open.loading;
        let error = open.error.clone();
        let scroll = open.scroll.clone();
        let row = self.row(&r, cx);
        let in_trash = thread
            .as_ref()
            .is_some_and(|t| t.label_ids.iter().any(|l| l == "TRASH"));
        let mut body = v_flex().w_full().pb_6();
        if in_trash {
            body =
                body.child(
                    h_flex()
                        .mx_6()
                        .my_2()
                        .gap_2()
                        .px_3()
                        .py_2()
                        .rounded(cx.theme().radius)
                        .bg(cx.theme().warning.opacity(0.12))
                        .text_sm()
                        .child(icon("trash").small())
                        .child(div().flex_1().child("This conversation is in the Trash."))
                        .child(
                            Button::new("banner-restore")
                                .label("Restore")
                                .small()
                                .outline()
                                .on_click(cx.listener(|this, _, w, cx| {
                                    this.act(ThreadAction::Untrash, w, cx)
                                })),
                        ),
                );
        }
        match thread {
            None if loading => {
                body = body.child(
                    div()
                        .px_6()
                        .py_4()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(row.map(|r| r.snippet).unwrap_or_default()),
                );
            }
            None => {
                body =
                    body.child(
                        div().px_6().py_4().text_color(cx.theme().danger).child(
                            error.unwrap_or_else(|| "Couldn't load this conversation".into()),
                        ),
                    );
            }
            Some(thread) => body = self.render_messages(body, thread, window, cx),
        }

        let composer = self
            .composer
            .clone()
            .filter(|c| c.read(cx).inline_reply_for(&r));
        v_flex()
            .size_full()
            .child(
                div()
                    .id("reader-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&scroll)
                    .child(body),
            )
            .children(composer.map(|c| div().flex_none().p_3().child(c)))
    }

    fn render_messages(
        &mut self,
        mut body: Div,
        thread: Thread,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let me = self
            .account(&thread.account_id)
            .map(|a| a.email.to_lowercase())
            .unwrap_or_default();
        let (expanded, show_all) = {
            let open = self.open.as_ref().unwrap();
            (open.expanded.clone(), open.show_all)
        };
        let n = thread.messages.len();
        let mut i = 0;
        while i < n {
            let m = &thread.messages[i];
            if i == 0
                || crate::ui::local(m.date).date_naive()
                    != crate::ui::local(thread.messages[i - 1].date).date_naive()
            {
                body = body.child(
                    h_flex()
                        .w_full()
                        .h(px(44.))
                        .justify_center()
                        .text_size(px(12.))
                        .text_color(cx.theme().muted_foreground)
                        .child(crate::ui::day_label(m.date)),
                );
            }
            if !show_all && !expanded.contains(&m.id) {
                // Long runs of collapsed messages fold to the first and last.
                let mut end = i;
                while end + 1 < n && !expanded.contains(&thread.messages[end + 1].id) {
                    end += 1;
                }
                if end - i + 1 > 3 {
                    body = body.child(self.render_collapsed(m, &me, cx));
                    let hidden = end - i - 1;
                    body = body.child(
                        h_flex().px_6().py_1().child(
                            Button::new(SharedString::from(format!("fold-{}", m.id)))
                                .ghost()
                                .small()
                                .label(format!("{hidden} more messages"))
                                .on_click(cx.listener(|this, _, _, cx| {
                                    if let Some(open) = &mut this.open {
                                        open.show_all = true;
                                    }
                                    cx.notify();
                                })),
                        ),
                    );
                    body = body.child(self.render_collapsed(&thread.messages[end], &me, cx));
                    i = end + 1;
                    continue;
                }
            }
            body = body.child(if expanded.contains(&m.id) {
                self.render_expanded(m, &me, window, cx)
            } else {
                self.render_collapsed(m, &me, cx)
            });
            i += 1;
        }
        body
    }

    fn sender_name(m: &Message, me: &str) -> String {
        if m.from.email.to_lowercase() == me {
            "Me".into()
        } else {
            m.from.display().to_string()
        }
    }

    fn render_collapsed(&self, m: &Message, me: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let id = m.id.clone();
        h_flex()
            .id(SharedString::from(format!("collapsed-{}", m.id)))
            .mx_3()
            .px_3()
            .py_2()
            .gap_3()
            .rounded(theme.radius)
            .cursor_pointer()
            .hover(|s| s.bg(theme.accent))
            .border_t_1()
            .border_color(theme.border)
            .child(person_avatar(m.from.display(), &m.from.email).small())
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                div()
                                    .flex_1()
                                    .text_sm()
                                    .when(m.unread, |el| el.font_semibold())
                                    .when(m.draft, |el| el.text_color(theme.danger))
                                    .child(if m.draft {
                                        format!("Draft · {}", Self::sender_name(m, me))
                                    } else {
                                        Self::sender_name(m, me)
                                    }),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(message_date(m.date)),
                            ),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(m.snippet.clone()),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(open) = &mut this.open {
                    open.expanded.insert(id.clone());
                }
                cx.notify();
            }))
            .into_any_element()
    }

    fn render_expanded(
        &mut self,
        m: &Message,
        me: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let id = m.id.clone();
        let mut recipients: Vec<String> = m.to.iter().map(|p| p.display().to_string()).collect();
        if !m.cc.is_empty() {
            recipients.push(format!(
                "cc {}",
                m.cc.iter()
                    .map(|p| p.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let attachments: Vec<Attachment> = m
            .attachments
            .iter()
            .filter(|a| {
                let cid = a.content_id.as_deref().unwrap_or("");
                let referenced = !cid.is_empty()
                    && m.body_html
                        .as_deref()
                        .is_some_and(|h| h.contains(&format!("cid:{cid}")));
                !(a.inline && referenced)
            })
            .cloned()
            .collect();
        let date = m.date;
        let header = h_flex()
            .id(SharedString::from(format!("header-{}", m.id)))
            .items_start()
            .gap_3()
            .cursor_pointer()
            .child(person_avatar(m.from.display(), &m.from.email))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                div()
                                    .text_sm()
                                    .font_medium()
                                    .when(m.draft, |el| el.text_color(theme.danger))
                                    .child(if m.draft {
                                        format!("Draft · {}", Self::sender_name(m, me))
                                    } else {
                                        Self::sender_name(m, me)
                                    }),
                            )
                            .child(div().flex_1())
                            .child(
                                div()
                                    .id(SharedString::from(format!("date-{}", m.id)))
                                    .flex_none()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(message_date(m.date))
                                    .tooltip(move |window, cx| {
                                        gpui_kit::component::tooltip::Tooltip::new(full_date(date))
                                            .build(window, cx)
                                    }),
                            ),
                    )
                    .when(!recipients.is_empty(), |el| {
                        el.child(
                            div()
                                .truncate()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .child(format!("to {}", recipients.join(", "))),
                        )
                    }),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(open) = &mut this.open {
                    if open.thread.as_ref().is_some_and(|t| t.messages.len() > 1) {
                        open.expanded.remove(&id);
                    }
                }
                cx.notify();
            }));
        let draft = m.draft.then(|| m.clone());
        v_flex()
            .px_6()
            .py_4()
            .child(header)
            .child(div().mt_4().child(self.message_body(m, window, cx)))
            .when(!attachments.is_empty(), |el| {
                el.child(div().pl_11().child(self.render_attachments(
                    &m.account_id,
                    &m.id,
                    attachments,
                    cx,
                )))
            })
            .when_some(draft, |el, draft| {
                el.child(
                    div().mt_3().pl_11().child(
                        Button::new(SharedString::from(format!("edit-draft-{}", draft.id)))
                            .label("Edit Draft")
                            .small()
                            .outline()
                            .on_click(cx.listener(move |this, _, w, cx| {
                                this.compose(
                                    ComposeMode::Draft {
                                        message: Box::new(draft.clone()),
                                    },
                                    w,
                                    cx,
                                )
                            })),
                    ),
                )
            })
            .into_any_element()
    }

    fn render_attachments(
        &self,
        account: &str,
        message: &str,
        attachments: Vec<Attachment>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let mut list = v_flex()
            .mt_4()
            .rounded(theme.radius_lg)
            .border_1()
            .border_color(theme.border)
            .overflow_hidden();
        for (i, a) in attachments.into_iter().enumerate() {
            let (acc, msg, a2) = (account.to_string(), message.to_string(), a.clone());
            let (acc2, msg2, a3) = (account.to_string(), message.to_string(), a.clone());
            list = list.child(
                h_flex()
                    .id(SharedString::from(format!("att-{message}-{i}")))
                    .px_3()
                    .py_2()
                    .gap_3()
                    .when(i > 0, |el| el.border_t_1().border_color(theme.border))
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.accent))
                    .child(
                        icon(attachment_icon(&a.mime_type))
                            .small()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(div().truncate().text_sm().child(a.filename.clone()))
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(file_size(a.size)),
                            ),
                    )
                    .child(
                        tool_button(
                            SharedString::from(format!("save-{message}-{i}")),
                            "download",
                            "Save…",
                            None,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.save_attachment(
                                    acc2.clone(),
                                    msg2.clone(),
                                    a3.clone(),
                                    window,
                                    cx,
                                )
                            },
                        )),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_attachment(acc.clone(), msg.clone(), a2.clone(), window, cx)
                    })),
            );
        }
        list
    }

    fn open_attachment(
        &mut self,
        account: String,
        message: String,
        a: Attachment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let backend = self.backend.clone();
        let task = {
            let b = backend.clone();
            backend.spawn(async move {
                b.attachment(account, message, a.id.clone())
                    .await
                    .map(|bytes| (bytes, a))
            })
        };
        cx.spawn_in(window, async move |_, cx| match task.await {
            Ok((bytes, a)) => {
                let dir = std::env::temp_dir().join("otter-mail-attachments");
                let _ = std::fs::create_dir_all(&dir);
                let path = dir.join(sanitize(&a.filename));
                if std::fs::write(&path, bytes).is_ok() {
                    let _ = open::that_detached(&path);
                }
            }
            Err(err) => {
                let _ = cx.update(|window, cx| {
                    window.push_notification(
                        Notification::error(format!("Couldn't open it: {err:#}")),
                        cx,
                    )
                });
            }
        })
        .detach();
    }

    fn save_attachment(
        &mut self,
        account: String,
        message: String,
        a: Attachment,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let backend = self.backend.clone();
        let dir = dirs::download_dir().unwrap_or_else(std::env::temp_dir);
        let path_rx = cx.prompt_for_new_path(&dir, Some(&a.filename));
        cx.spawn_in(window, async move |_, cx| {
            let Ok(Ok(Some(path))) = path_rx.await else {
                return;
            };
            let b = backend.clone();
            let bytes = backend
                .spawn(async move { b.attachment(account, message, a.id.clone()).await })
                .await;
            let note = match bytes.and_then(|bytes| Ok(std::fs::write(&path, bytes)?)) {
                Ok(()) => Notification::success(format!(
                    "Saved {}",
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                )),
                Err(err) => Notification::error(format!("Couldn't save it: {err:#}")),
            };
            let _ = cx.update(|window, cx| window.push_notification(note, cx));
        })
        .detach();
    }

    pub fn unsubscribe(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread) = self.open.as_ref().and_then(|o| o.thread.clone()) else {
            return;
        };
        let Some(last) = thread.messages.iter().rev().find(|m| !m.draft).cloned() else {
            return;
        };
        let backend = self.backend.clone();
        let task = {
            let b = backend.clone();
            backend.spawn(async move {
                b.unsubscribe(last.account_id.clone(), last.id.clone())
                    .await
            })
        };
        cx.spawn_in(window, async move |_, cx| {
            let result = task.await;
            let _ = cx.update(|window, cx| match result {
                Ok(None) => window.push_notification(Notification::success("Unsubscribed"), cx),
                Ok(Some(url)) => {
                    let _ = open::that_detached(url);
                }
                Err(err) => window.push_notification(Notification::error(format!("{err:#}")), cx),
            });
        })
        .detach();
    }

    pub fn prompt_snooze(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        use chrono::Datelike as _;
        let Some(open) = &self.open else { return };
        let r = open.r.clone();
        let subject = open
            .thread
            .as_ref()
            .map(|t| t.subject.clone())
            .unwrap_or_default();
        let weak = cx.entity().downgrade();
        let now = chrono::Local::now();
        let at_eight = |days: i64| {
            (now + chrono::Duration::days(days))
                .date_naive()
                .and_hms_opt(8, 0, 0)
                .and_then(|d| d.and_local_timezone(chrono::Local).single())
        };
        let to_monday = {
            let d = (7 - now.weekday().num_days_from_monday() as i64) % 7;
            if d == 0 { 7 } else { d }
        };
        let options: Vec<(String, i64)> = [
            ("Later Today", Some(now + chrono::Duration::hours(3))),
            ("Tomorrow", at_eight(1)),
            ("Next Week", at_eight(to_monday)),
        ]
        .into_iter()
        .filter_map(|(l, t)| {
            t.map(|t| {
                (
                    format!("{l} — {}", t.format("%a %-I:%M %p")),
                    t.timestamp_millis(),
                )
            })
        })
        .collect();
        window.open_dialog(cx, move |dialog, _, _| {
            let mut list = v_flex().gap_1();
            for (label, at) in options.clone() {
                let weak = weak.clone();
                let r = r.clone();
                let subject = subject.clone();
                list = list.child(
                    Button::new(SharedString::from(label.clone()))
                        .label(label)
                        .ghost()
                        .w_full()
                        .on_click(move |_, window, cx| {
                            if let Some(ws) = weak.upgrade() {
                                let (r, subject) = (r.clone(), subject.clone());
                                ws.update(cx, |ws, cx| ws.snooze(r, at, subject, window, cx));
                            }
                            window.close_dialog(cx);
                        }),
                );
            }
            dialog.title("Snooze Until").child(list)
        });
    }

    fn snooze(
        &mut self,
        r: ThreadRef,
        at: i64,
        subject: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match self.backend.snooze(r.clone(), at, subject) {
            Ok(()) => {
                let refs = self.list.read(cx).delegate().visible_refs();
                let pos = refs.iter().position(|x| *x == r);
                let next = pos
                    .and_then(|p| {
                        refs.get(p + 1)
                            .or_else(|| p.checked_sub(1).and_then(|p| refs.get(p)))
                    })
                    .cloned();
                let mut rows = self.list.read(cx).delegate().rows.clone();
                rows.retain(|row| Workspace::row_ref(row) != r);
                match next {
                    Some(n) => self.open_thread(n, false, window, cx),
                    None => self.close_thread(cx),
                }
                window.push_notification(
                    Notification::new().message(format!("Snoozed until {}", full_date(at))),
                    cx,
                );
                self.reload_list(false, cx);
                let _ = rows;
            }
            Err(err) => window.push_notification(Notification::error(format!("{err:#}")), cx),
        }
    }
}

fn attachment_icon(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime == "application/pdf" {
        "file-text"
    } else if mime.contains("zip") || mime.contains("compressed") {
        "file-archive"
    } else if mime.contains("spreadsheet") || mime.contains("csv") || mime.contains("excel") {
        "file-spreadsheet"
    } else {
        "file"
    }
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == ':' {
                '_'
            } else {
                c
            }
        })
        .collect()
}
