//! The original mailbox rail and sidebar, using standard list and menu controls.

use gpui_kit::component::StyledExt as _;
use gpui_kit::component::list::ListItem;
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::sidebar::{SidebarGroup, SidebarItem as _, SidebarMenu, SidebarMenuItem};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::model::Scope;
use mail_core::model::*;

use crate::composer::ComposeMode;
use crate::ui::{RAIL_WIDTH, icon, sidebar_surface, tool_button};
use crate::workspace::Workspace;

fn folder_icon(folder: SystemFolder) -> &'static str {
    match folder {
        SystemFolder::Inbox => "inbox",
        SystemFolder::Starred => "star",
        SystemFolder::Sent => "send",
        SystemFolder::Drafts => "file",
        SystemFolder::Important => "bookmark",
        SystemFolder::All => "mails",
        SystemFolder::Spam => "archive-x",
        SystemFolder::Trash => "trash",
    }
}

impl Workspace {
    fn count_for(&self, label_id: &str, total: bool) -> i64 {
        let pick = |l: &Label| if total { l.total } else { l.unread };
        match &self.scope {
            Scope::All => self
                .accounts
                .iter()
                .filter(|a| a.enabled)
                .filter_map(|a| self.label(&a.id, label_id))
                .map(pick)
                .sum(),
            Scope::Account(id) => self.label(id, label_id).map(pick).unwrap_or(0),
        }
    }

    fn badge(count: i64) -> impl Fn(&mut Window, &mut App) -> AnyElement + 'static {
        move |_, cx| {
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(if count > 999 {
                    "999+".to_string()
                } else {
                    count.to_string()
                })
                .into_any_element()
        }
    }

    pub fn render_rail(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = cx.theme().clone();
        let mut rail = v_flex()
            .w(px(RAIL_WIDTH))
            .h_full()
            .flex_none()
            .items_center()
            .gap_2()
            .pt_3()
            .pb_2();
        if self.accounts.iter().filter(|a| a.enabled).count() > 1 {
            rail = rail.child(
                div()
                    .id("all-mailboxes")
                    .size(px(40.))
                    .rounded(px(10.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .text_color(theme.foreground)
                    .hover(|s| s.bg(theme.sidebar_accent))
                    .when(
                        self.scope == Scope::All && self.settings_view.is_none(),
                        |el| el.bg(theme.sidebar_accent),
                    )
                    .child(icon("layers").size(px(24.)))
                    .on_click(cx.listener(|this, _, w, cx| {
                        this.hide_settings(w, cx);
                        this.go(Scope::All, Folder::System(SystemFolder::Inbox), w, cx);
                    })),
            );
        }
        for account in self
            .accounts
            .iter()
            .filter(|a| a.enabled)
            .cloned()
            .collect::<Vec<_>>()
        {
            let color = account
                .color
                .as_deref()
                .and_then(crate::ui::parse_hex)
                .unwrap_or(theme.primary);
            let id = account.id.clone();
            let name = account
                .title()
                .chars()
                .next()
                .unwrap_or('M')
                .to_uppercase()
                .to_string();
            rail = rail.child(
                div()
                    .id(SharedString::from(format!("mailbox-rail-{id}")))
                    .size(px(40.))
                    .rounded(px(10.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|s| s.bg(theme.sidebar_accent))
                    .when(
                        self.scope == Scope::Account(id.clone()) && self.settings_view.is_none(),
                        |el| el.bg(theme.sidebar_accent),
                    )
                    .child(
                        div()
                            .size(px(26.))
                            .rounded(px(6.))
                            .bg(color)
                            .text_color(rgb(0xffffff))
                            .text_size(px(14.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(name),
                    )
                    .on_click(cx.listener(move |this, _, w, cx| {
                        this.hide_settings(w, cx);
                        this.go(
                            Scope::Account(id.clone()),
                            Folder::System(SystemFolder::Inbox),
                            w,
                            cx,
                        );
                    })),
            );
        }
        rail.child(div().w(px(20.)).h(px(1.)).my_2().bg(theme.border))
            .child(
                tool_button("add-mailbox-rail", "plus", "Add a mailbox", None)
                    .on_click(|_, _, cx| crate::settings::open_settings(cx)),
            )
            .child(div().flex_1())
            .child(
                tool_button(
                    "settings-rail",
                    "circle-user-round",
                    "Settings",
                    Some("cmd-,"),
                )
                .on_click(|_, _, cx| crate::settings::open_settings(cx)),
            )
    }

    pub fn render_sidebar(
        &mut self,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let searching = matches!(self.folder, Folder::Search(_));
        let theme = cx.theme().clone();
        let folders = v_flex().px_2().gap_0();
        let mut folders = folders.child(
            ListItem::new("new-message")
                .accessibility_label("New message")
                .h(px(32.))
                .px(px(10.))
                .mb_3()
                .rounded(px(8.))
                .child(
                    h_flex()
                        .gap_3()
                        .child(
                            icon("square-pen")
                                .size(px(16.))
                                .text_color(theme.muted_foreground),
                        )
                        .child(div().text_size(px(14.)).child("New message")),
                )
                .on_click(cx.listener(|this, _, w, cx| {
                    this.compose(
                        ComposeMode::New {
                            account_id: None,
                            to: vec![],
                        },
                        w,
                        cx,
                    )
                })),
        );
        for folder in SystemFolder::ALL {
            let count = match folder {
                SystemFolder::All | SystemFolder::Starred | SystemFolder::Sent => 0,
                SystemFolder::Drafts => self.count_for("DRAFT", true),
                f => self.count_for(f.label_id(), false),
            };
            let active = !searching && self.folder == Folder::System(folder);
            let item = ListItem::new(SharedString::from(format!("folder-{}", folder.label_id())))
                .accessibility_label(folder.title())
                .h(px(32.))
                .px(px(10.))
                .py_0()
                .rounded(px(8.))
                .selected(active)
                .child(
                    h_flex()
                        .gap_3()
                        .child(
                            icon(folder_icon(folder))
                                .size(px(16.))
                                .text_color(theme.muted_foreground),
                        )
                        .child(div().flex_1().text_size(px(14.)).child(folder.title()))
                        .when(count > 0, |el| {
                            el.child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.muted_foreground)
                                    .child(count.to_string()),
                            )
                        }),
                )
                .on_click(cx.listener(move |this, _, w, cx| {
                    this.go(this.scope.clone(), Folder::System(folder), w, cx)
                }));
            let item = if matches!(folder, SystemFolder::Spam | SystemFolder::Trash) {
                let weak = cx.entity().downgrade();
                let label_id = folder.label_id().to_string();
                item.context_menu(move |menu, _, _| {
                    let weak = weak.clone();
                    let label_id = label_id.clone();
                    menu.item(
                        PopupMenuItem::new(if folder == SystemFolder::Spam {
                            "Empty Junk…"
                        } else {
                            "Empty Trash…"
                        })
                        .on_click(move |_, window, cx| {
                            if let Some(ws) = weak.upgrade() {
                                ws.update(cx, |ws, cx| {
                                    ws.confirm_empty(label_id.clone(), window, cx)
                                });
                            }
                        }),
                    )
                })
                .into_any_element()
            } else {
                item.into_any_element()
            };
            folders = folders.child(item);
        }
        let mut sidebar = v_flex()
            .w_full()
            .h_full()
            .flex_none()
            .bg(sidebar_surface(cx))
            .border_r_1()
            .border_color(theme.border.opacity(0.7))
            .child(
                h_flex()
                    .h(px(58.))
                    .px_4()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(18.))
                            .font_semibold()
                            .child(self.scope_title()),
                    )
                    .child(
                        tool_button("sidebar-search", "search", "Command palette", Some("cmd-k"))
                            .on_click(cx.listener(|this, _, w, cx| this.open_palette(w, cx))),
                    ),
            )
            .child(folders);

        if let Scope::Account(account_id) = self.scope.clone() {
            let mut labels: Vec<Label> = self
                .labels
                .get(&account_id)
                .map(|ls| {
                    ls.iter()
                        .filter(|l| !l.system && !l.id.starts_with("CATEGORY_"))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default();
            labels.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            let is_imap = self
                .account(&account_id)
                .is_some_and(|a| a.provider == ProviderKind::Imap);
            let roots: Vec<&Label> = labels.iter().filter(|l| l.depth() == 0).collect();
            let mut menu = SidebarMenu::new();
            for root in roots {
                menu = menu.child(self.label_item(root, &labels, cx));
            }
            menu = menu.child(
                SidebarMenuItem::new(if is_imap {
                    "New Folder…"
                } else {
                    "New Label…"
                })
                .icon(icon("plus"))
                .on_click(cx.listener(|this, _, w, cx| this.prompt_new_label(w, cx))),
            );
            sidebar = sidebar.child(
                div()
                    .mt_6()
                    .px_2()
                    .child(
                        div()
                            .px(px(10.))
                            .mb_2()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(if is_imap { "Folders" } else { "Labels" }),
                    )
                    .child(
                        SidebarGroup::new("")
                            .child(menu)
                            .render("sidebar-labels", _window, cx),
                    ),
            );
        }

        sidebar.child(div().flex_1())
    }

    /// A label, its children nested under it.
    fn label_item(&self, label: &Label, all: &[Label], cx: &mut Context<Self>) -> SidebarMenuItem {
        let prefix = format!("{}/", label.name);
        let children: Vec<&Label> = all
            .iter()
            .filter(|l| l.name.starts_with(&prefix) && l.depth() == label.depth() + 1)
            .collect();
        let id = label.id.clone();
        let active = self.folder == Folder::Label(label.id.clone());
        let tint = label
            .background_color
            .as_deref()
            .and_then(crate::ui::parse_hex);
        let mut item = SidebarMenuItem::new(label.leaf_name().to_string())
            .icon(match tint {
                Some(c) => icon("tag").text_color(c),
                None => icon("tag"),
            })
            .active(active)
            .collapsed(self.sidebar_collapsed)
            .on_click(cx.listener(move |this, _, w, cx| {
                this.go(this.scope.clone(), Folder::Label(id.clone()), w, cx)
            }));
        if label.unread > 0 {
            item = item.suffix(Self::badge(label.unread));
        }
        let weak = cx.entity().downgrade();
        let l = label.clone();
        item = item.context_menu(move |menu, _, _| {
            let on = |f: fn(&mut Workspace, Label, &mut Window, &mut Context<Workspace>)| {
                let weak = weak.clone();
                let l = l.clone();
                move |_: &ClickEvent, window: &mut Window, cx: &mut App| {
                    if let Some(ws) = weak.upgrade() {
                        let l = l.clone();
                        ws.update(cx, |ws, cx| f(ws, l, window, cx));
                    }
                }
            };
            menu.item(
                PopupMenuItem::new("Rename…")
                    .icon(icon("pencil"))
                    .on_click(on(Workspace::prompt_rename_label)),
            )
            .item(
                PopupMenuItem::new("Change Color…")
                    .icon(icon("palette"))
                    .on_click(on(Workspace::prompt_label_color)),
            )
            .separator()
            .item(
                PopupMenuItem::new("Delete Label")
                    .icon(icon("trash"))
                    .on_click(on(Workspace::confirm_delete_label)),
            )
        });
        if !children.is_empty() {
            item = item.default_open(true).children(
                children
                    .into_iter()
                    .map(|c| self.label_item(c, all, cx))
                    .collect::<Vec<_>>(),
            );
        }
        item
    }
}
