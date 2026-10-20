//! The message list: a gpui-component `List` whose sections are days
//! (collapsible), with keyboard selection, ⌘/⇧-click multi-select, a context
//! menu per conversation and pages loaded as you scroll.

use std::collections::{HashMap, HashSet};

use gpui_kit::component::StyledExt as _;
use gpui_kit::component::list::{ListDelegate, ListItem, ListState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::{ActiveTheme as _, IndexPath, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::backend::ThreadRef;
use mail_core::model::*;

use crate::ui::{icon, label_tag, list_date, parse_hex};
use crate::workspace::Workspace;

pub struct Section {
    pub key: i64,
    pub label: SharedString,
    pub rows: Vec<usize>,
    pub unread: usize,
}

/// What rows need to know about the window (refreshed as it changes).
#[derive(Default, Clone)]
pub struct RowContext {
    pub combined: bool,
    pub folder: Option<Folder>,
    pub labels: HashMap<String, Vec<Label>>,
    pub accounts: Vec<Account>,
    pub group_by_day: bool,
}

pub struct MessageList {
    pub workspace: WeakEntity<Workspace>,
    pub rows: Vec<ThreadSummary>,
    pub sections: Vec<Section>,
    pub collapsed: HashSet<i64>,
    pub selected: Option<IndexPath>,
    pub checked: HashSet<ThreadRef>,
    pub anchor: Option<ThreadRef>,
    pub loading: bool,
    pub loaded_once: bool,
    pub has_more: bool,
    pub ctx: RowContext,
}

impl MessageList {
    pub fn new(workspace: WeakEntity<Workspace>) -> Self {
        MessageList {
            workspace,
            rows: vec![],
            sections: vec![],
            collapsed: HashSet::new(),
            selected: None,
            checked: HashSet::new(),
            anchor: None,
            loading: true,
            loaded_once: false,
            has_more: false,
            ctx: RowContext::default(),
        }
    }

    pub fn reset(&mut self) {
        self.rows.clear();
        self.sections.clear();
        self.collapsed.clear();
        self.selected = None;
        self.checked.clear();
        self.loading = true;
        self.loaded_once = false;
        self.has_more = false;
    }

    /// New rows: regroups them by day.
    pub fn set_rows(&mut self, rows: Vec<ThreadSummary>) {
        self.rows = rows;
        self.sections.clear();
        if !self.ctx.group_by_day {
            self.sections.push(Section {
                key: 0,
                label: SharedString::default(),
                unread: self.rows.iter().filter(|r| r.unread).count(),
                rows: (0..self.rows.len()).collect(),
            });
            return;
        }
        for (i, row) in self.rows.iter().enumerate() {
            let day = crate::ui::local(row.date).date_naive();
            let key = day
                .and_hms_opt(0, 0, 0)
                .map(|d| d.and_utc().timestamp())
                .unwrap_or(0);
            match self.sections.last_mut() {
                Some(s) if s.key == key => {
                    s.rows.push(i);
                    s.unread += row.unread as usize;
                }
                _ => self.sections.push(Section {
                    key,
                    label: crate::ui::day_label(row.date).into(),
                    rows: vec![i],
                    unread: row.unread as usize,
                }),
            }
        }
    }

    pub fn row_at(&self, ix: IndexPath) -> Option<&ThreadSummary> {
        let section = self.sections.get(ix.section)?;
        self.rows.get(*section.rows.get(ix.row)?)
    }

    pub fn index_of(&self, r: &ThreadRef) -> Option<IndexPath> {
        for (s, section) in self.sections.iter().enumerate() {
            if self.collapsed.contains(&section.key) {
                continue;
            }
            for (row_ix, i) in section.rows.iter().enumerate() {
                let row = &self.rows[*i];
                if row.account_id == r.account_id && row.id == r.thread_id {
                    return Some(IndexPath::new(row_ix).section(s));
                }
            }
        }
        None
    }

    /// Conversations as shown (collapsed days left out), in order.
    pub fn visible_refs(&self) -> Vec<ThreadRef> {
        self.sections
            .iter()
            .filter(|s| !self.collapsed.contains(&s.key))
            .flat_map(|s| s.rows.iter().map(|i| Workspace::row_ref(&self.rows[*i])))
            .collect()
    }

    pub fn row(&self, r: &ThreadRef) -> Option<&ThreadSummary> {
        self.rows
            .iter()
            .find(|row| row.account_id == r.account_id && row.id == r.thread_id)
    }

    fn label(&self, account: &str, id: &str) -> Option<&Label> {
        self.ctx.labels.get(account)?.iter().find(|l| l.id == id)
    }

    fn sender_line(&self, row: &ThreadSummary) -> String {
        let me = self
            .ctx
            .accounts
            .iter()
            .find(|a| a.id == row.account_id)
            .map(|a| a.email.to_lowercase());
        let names: Vec<String> = row
            .senders
            .iter()
            .map(|s| {
                if Some(s.email.to_lowercase()) == me {
                    "Me".to_string()
                } else {
                    s.display().to_string()
                }
            })
            .collect();
        if names.len() > 2 {
            format!("{}, {}", names[0], names[names.len() - 1])
        } else {
            names.join(", ")
        }
    }

    /// Up to two labels as tags, then "+N" (the list's own label left out).
    fn tags(&self, row: &ThreadSummary) -> (Vec<(String, Option<String>, Option<String>)>, usize) {
        let mut tags = Vec::new();
        for id in &row.label_ids {
            if self.ctx.folder.as_ref() == Some(&Folder::Label(id.clone())) {
                continue;
            }
            if let Some(label) = self.label(&row.account_id, id) {
                if !label.system && !label.id.starts_with("CATEGORY_") {
                    tags.push((
                        label.leaf_name().to_string(),
                        label.background_color.clone(),
                        label.text_color.clone(),
                    ));
                }
            }
        }
        let extra = tags.len().saturating_sub(2);
        tags.truncate(2);
        (tags, extra)
    }

    fn select_range(&mut self, to: ThreadRef) {
        let anchor = self.anchor.clone().unwrap_or(to.clone());
        let refs = self.visible_refs();
        let a = refs.iter().position(|r| *r == anchor);
        let b = refs.iter().position(|r| *r == to);
        if let (Some(a), Some(b)) = (a, b) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            self.checked = refs[lo..=hi].iter().cloned().collect();
        }
    }

    fn notify_workspace(&self, cx: &mut Context<ListState<Self>>) {
        if let Some(ws) = self.workspace.upgrade() {
            cx.defer(move |cx| ws.update(cx, |_, cx| cx.notify()));
        }
    }
}

impl ListDelegate for MessageList {
    type Item = ListItem;

    fn sections_count(&self, _: &App) -> usize {
        self.sections.len()
    }

    fn items_count(&self, section: usize, _: &App) -> usize {
        match self.sections.get(section) {
            Some(s) if !self.collapsed.contains(&s.key) => s.rows.len(),
            _ => 0,
        }
    }

    fn render_section_header(
        &mut self,
        section: usize,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<impl IntoElement> {
        if !self.ctx.group_by_day {
            return None;
        }
        let s = self.sections.get(section)?;
        let key = s.key;
        let collapsed = self.collapsed.contains(&key);
        Some(
            h_flex()
                .id(SharedString::from(format!("day-{key}")))
                .w_full()
                .px_3()
                .h(px(32.))
                .border_y_1()
                .border_color(cx.theme().border.opacity(0.6))
                .gap_1()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .cursor_pointer()
                .child(
                    icon(if collapsed {
                        "chevron-right"
                    } else {
                        "chevron-down"
                    })
                    .size_3p5(),
                )
                .child(
                    div()
                        .font_medium()
                        .text_color(cx.theme().foreground)
                        .child(s.label.clone()),
                )
                .child(div().flex_1())
                .child(s.rows.len().to_string())
                .when(s.unread > 0, |el| {
                    el.child(
                        div()
                            .text_color(cx.theme().primary)
                            .child(format!("· {} unread", s.unread)),
                    )
                })
                .on_click(cx.listener(move |this, _, _, cx| {
                    let list = this.delegate_mut();
                    if !list.collapsed.remove(&key) {
                        list.collapsed.insert(key);
                    }
                    cx.notify();
                })),
        )
    }

    fn render_item(
        &mut self,
        ix: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<Self::Item> {
        let row = self.row_at(ix)?.clone();
        let r = Workspace::row_ref(&row);
        let theme = cx.theme();
        let checked = self.checked.contains(&r);
        let (tags, extra) = self.tags(&row);
        let account_color = self
            .ctx
            .accounts
            .iter()
            .find(|a| a.id == row.account_id)
            .and_then(|a| a.color.as_deref().and_then(parse_hex))
            .unwrap_or(theme.muted_foreground);
        let subject = if row.subject.trim().is_empty() {
            "(no subject)".to_string()
        } else {
            row.subject.clone()
        };
        let sender = if row.draft_only {
            let to: Vec<String> = row
                .draft_to
                .iter()
                .map(|p| p.display().to_string())
                .collect();
            if to.is_empty() {
                "(no recipients)".to_string()
            } else {
                format!("to {}", to.join(", "))
            }
        } else {
            self.sender_line(&row)
        };
        let muted = theme.muted_foreground;
        let dim = self
            .workspace
            .upgrade()
            .map(|ws| {
                ws.read(cx)
                    .backend
                    .ui_pref("otter:dim-read-messages")
                    .as_deref()
                    != Some("false")
            })
            .unwrap_or(true);
        let content = v_flex()
            .w_full()
            .gap(px(2.))
            .line_height(relative(1.375))
            .child(
                h_flex()
                    .w_full()
                    .gap_1p5()
                    .child(
                        div()
                            .size_1p5()
                            .flex_none()
                            .rounded_full()
                            .when(row.unread, |el| el.bg(theme.primary))
                            .when(!row.unread, |el| el.w(px(0.))),
                    )
                    .when(row.label_ids.iter().any(|id| id == "IMPORTANT"), |el| {
                        el.child(
                            icon("chevrons-right")
                                .size(px(14.))
                                .text_color(muted.opacity(0.6)),
                        )
                    })
                    .when(row.draft_only, |el| {
                        el.child(div().text_sm().text_color(theme.danger).child("Draft"))
                    })
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_sm()
                            .when(row.unread, |el| el.font_medium())
                            .child(sender.clone()),
                    )
                    .child(
                        h_flex()
                            .flex_none()
                            .gap_1()
                            .text_xs()
                            .text_color(muted)
                            .when(row.starred, |el| {
                                el.child(icon("flag").size_3p5().text_color(theme.warning))
                            })
                            .when(row.has_attachments, |el| {
                                el.child(icon("paperclip").size_3())
                            })
                            .when(row.message_count > 1, |el| {
                                el.child(row.message_count.to_string())
                            })
                            .when(self.ctx.combined, |el| {
                                el.child(div().size_2().rounded_full().bg(account_color))
                            })
                            .child(list_date(row.date)),
                    ),
            )
            .child(
                h_flex().w_full().gap_1().child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(13.))
                        .text_color(theme.foreground.opacity(0.9))
                        .child(subject),
                ),
            )
            .child(
                div()
                    .w_full()
                    .truncate()
                    .text_size(px(13.))
                    .text_color(muted.opacity(0.75))
                    .child(if row.snippet.is_empty() {
                        " ".to_string()
                    } else {
                        row.snippet.clone()
                    }),
            )
            .child(
                h_flex()
                    .mt(px(4.))
                    .min_h(px(20.))
                    .gap_1()
                    .children(
                        tags.into_iter()
                            .map(|(name, bg, _)| label_tag(&name, bg.as_deref(), cx)),
                    )
                    .when(extra > 0, |el| {
                        el.child(
                            div()
                                .text_size(px(11.))
                                .text_color(muted)
                                .child(format!("+{extra}")),
                        )
                    }),
            );

        let workspace = self.workspace.clone();
        let flags = RowFlags {
            unread: row.unread,
            starred: row.starred,
            in_inbox: row.label_ids.iter().any(|l| l == "INBOX"),
            in_trash: row.label_ids.iter().any(|l| l == "TRASH"),
            in_spam: row.label_ids.iter().any(|l| l == "SPAM"),
        };
        Some(
            ListItem::new(SharedString::from(format!(
                "row-{}-{}",
                row.account_id, row.id
            )))
            .accessibility_label(format!("{}, {}", sender, row.subject))
            .mx(px(4.))
            .my(px(1.))
            .rounded(px(8.))
            .py(px(10.))
            .px(px(12.))
            .when(dim && !row.unread && self.selected != Some(ix), |el| {
                el.bg(theme.foreground.opacity(0.04))
            })
            .when(checked, |el| el.bg(theme.accent))
            .child(
                div()
                    .id("row-content")
                    .w_full()
                    .child(content)
                    .context_menu(move |menu, _, _| row_menu(menu, &workspace, &r, flags)),
            ),
        )
    }

    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> impl IntoElement {
        let (title, text) = if self.loading || !self.loaded_once {
            ("", "")
        } else if matches!(self.ctx.folder, Some(Folder::Search(_))) {
            ("No results", "Try other words, or fewer filters.")
        } else {
            ("No messages", "")
        };
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_1()
            .py_10()
            .child(div().text_color(cx.theme().muted_foreground).child(title))
            .child(
                div()
                    .text_xs()
                    .text_color(cx.theme().muted_foreground)
                    .child(text),
            )
    }

    fn set_selected_index(
        &mut self,
        ix: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = ix;
    }

    fn confirm(&mut self, secondary: bool, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        let Some(row) = self.selected.and_then(|ix| self.row_at(ix)).cloned() else {
            return;
        };
        let r = Workspace::row_ref(&row);
        if secondary {
            // ⌘-click toggles a conversation in the selection.
            if !self.checked.remove(&r) {
                self.checked.insert(r.clone());
            }
            self.anchor = Some(r);
            cx.notify();
            self.notify_workspace(cx);
            return;
        }
        if window.modifiers().shift {
            self.select_range(r);
            cx.notify();
            self.notify_workspace(cx);
            return;
        }
        self.checked.clear();
        self.anchor = Some(r.clone());
        if let Some(ws) = self.workspace.upgrade() {
            window.defer(cx, move |window, cx| {
                ws.update(cx, |ws, cx| ws.open_thread(r, true, window, cx));
            });
        }
    }

    fn loading(&self, _: &App) -> bool {
        self.loading && self.rows.is_empty() && !self.loaded_once
    }

    fn has_more(&self, _: &App) -> bool {
        self.has_more && !self.loading
    }

    fn load_more_threshold(&self) -> usize {
        30
    }

    fn load_more(&mut self, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        if let Some(ws) = self.workspace.upgrade() {
            self.loading = true;
            window.defer(cx, move |_, cx| ws.update(cx, |ws, cx| ws.load_more(cx)));
        }
    }
}

#[derive(Clone, Copy)]
struct RowFlags {
    unread: bool,
    starred: bool,
    in_inbox: bool,
    in_trash: bool,
    in_spam: bool,
}

fn row_menu(
    menu: PopupMenu,
    workspace: &WeakEntity<Workspace>,
    r: &ThreadRef,
    f: RowFlags,
) -> PopupMenu {
    let act = |action: ThreadAction| {
        let workspace = workspace.clone();
        let r = r.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            if let Some(ws) = workspace.upgrade() {
                let action = action.clone();
                ws.update(cx, |ws, cx| {
                    let targets = ws.menu_targets(&r, cx);
                    ws.act_on(targets, action, window, cx)
                });
            }
        }
    };
    let label = {
        let workspace = workspace.clone();
        let r = r.clone();
        move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
            if let Some(ws) = workspace.upgrade() {
                let r = r.clone();
                ws.update(cx, |ws, cx| {
                    ws.selected = Some(r);
                    ws.open_label_picker(window, cx)
                });
            }
        }
    };
    let mut menu = menu
        .item(
            PopupMenuItem::new(if f.unread {
                "Mark as Read"
            } else {
                "Mark as Unread"
            })
            .icon(icon(if f.unread { "mail-open" } else { "mail" }))
            .on_click(act(if f.unread {
                ThreadAction::MarkRead
            } else {
                ThreadAction::MarkUnread
            })),
        )
        .item(
            PopupMenuItem::new(if f.starred { "Unflag" } else { "Flag" })
                .icon(icon("flag"))
                .on_click(act(if f.starred {
                    ThreadAction::Unstar
                } else {
                    ThreadAction::Star
                })),
        )
        .item(
            PopupMenuItem::new("Label…")
                .icon(icon("tag"))
                .on_click(label),
        )
        .separator();
    if f.in_inbox {
        menu = menu.item(
            PopupMenuItem::new("Archive")
                .icon(icon("archive"))
                .on_click(act(ThreadAction::Archive)),
        );
    } else if !f.in_trash && !f.in_spam {
        menu = menu.item(
            PopupMenuItem::new("Move to Inbox")
                .icon(icon("archive-restore"))
                .on_click(act(ThreadAction::MoveToInbox)),
        );
    }
    menu = if f.in_spam {
        menu.item(
            PopupMenuItem::new("Not Junk")
                .icon(icon("shield-check"))
                .on_click(act(ThreadAction::NotSpam)),
        )
    } else {
        menu.item(
            PopupMenuItem::new("Move to Junk")
                .icon(icon("archive-x"))
                .on_click(act(ThreadAction::Spam)),
        )
    };
    menu = if f.in_trash {
        menu.item(
            PopupMenuItem::new("Restore from Trash")
                .icon(icon("rotate-ccw"))
                .on_click(act(ThreadAction::Untrash)),
        )
    } else {
        menu.item(
            PopupMenuItem::new("Move to Trash")
                .icon(icon("trash"))
                .on_click(act(ThreadAction::Trash)),
        )
    };
    if f.in_trash || f.in_spam {
        let workspace = workspace.clone();
        let r = r.clone();
        menu = menu.separator().item(
            PopupMenuItem::new("Delete Forever…")
                .icon(icon("trash"))
                .on_click(move |_, window, cx| {
                    if let Some(ws) = workspace.upgrade() {
                        ws.update(cx, |ws, cx| {
                            let targets = ws.menu_targets(&r, cx);
                            ws.confirm_delete_forever(targets, window, cx)
                        });
                    }
                }),
        );
    }
    menu
}

impl Workspace {
    /// A right-click acts on the selection when it's part of it.
    pub fn menu_targets(&self, r: &ThreadRef, cx: &App) -> Vec<ThreadRef> {
        if self.list.read(cx).delegate().checked.contains(r) {
            self.targets(cx)
        } else {
            vec![r.clone()]
        }
    }
}
