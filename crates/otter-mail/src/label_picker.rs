//! Labels: the picker (L) that adds and removes them on conversations, and
//! creating, renaming, coloring and deleting them. All in stock dialogs.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{
    ActiveTheme as _, WindowExt as _, h_flex, notification::Notification, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::model::Scope;
use mail_core::model::*;

use crate::ui::{icon, parse_hex};
use crate::workspace::Workspace;

/// Gmail's label palette (background, text).
const LABEL_COLORS: &[(&str, &str)] = &[
    ("#fb4c2f", "#ffffff"),
    ("#ffad47", "#ffffff"),
    ("#fad165", "#000000"),
    ("#16a766", "#ffffff"),
    ("#43d692", "#ffffff"),
    ("#4a86e8", "#ffffff"),
    ("#a479e2", "#ffffff"),
    ("#f691b3", "#ffffff"),
    ("#2da2bb", "#ffffff"),
    ("#b99aff", "#ffffff"),
    ("#cccccc", "#000000"),
    ("#666666", "#ffffff"),
];

impl Workspace {
    fn target_account(&self, cx: &App) -> Option<String> {
        self.targets(cx)
            .first()
            .map(|r| r.account_id.clone())
            .or_else(|| match &self.scope {
                Scope::Account(id) => Some(id.clone()),
                Scope::All => None,
            })
    }

    /// Toggles labels on the selected conversations.
    pub fn open_label_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let refs = self.targets(cx);
        let Some(account_id) = refs.first().map(|r| r.account_id.clone()) else {
            return;
        };
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
        let current: Vec<String> = refs
            .iter()
            .filter_map(|r| self.row(r, cx).map(|row| row.label_ids))
            .chain(
                self.open
                    .as_ref()
                    .and_then(|o| o.thread.as_ref())
                    .map(|t| t.label_ids.clone()),
            )
            .flatten()
            .collect();
        let weak = cx.entity().downgrade();
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter labels"));
        filter.update(cx, |f, cx| f.focus(window, cx));
        window.open_dialog(cx, move |dialog, _, cx| {
            let theme = cx.theme().clone();
            let q = filter.read(cx).value().to_lowercase();
            let mut list = v_flex()
                .id("label-list")
                .max_h(px(360.))
                .overflow_y_scroll();
            for label in labels
                .iter()
                .filter(|l| q.is_empty() || l.name.to_lowercase().contains(&q))
            {
                let has = current.contains(&label.id);
                let (weak, refs, id) = (weak.clone(), refs.clone(), label.id.clone());
                list = list.child(
                    h_flex()
                        .id(SharedString::from(format!("pick-{}", label.id)))
                        .px_2()
                        .py_1p5()
                        .gap_2()
                        .rounded(theme.radius)
                        .cursor_pointer()
                        .hover(|s| s.bg(theme.accent))
                        .child(
                            match label.background_color.as_deref().and_then(parse_hex) {
                                Some(c) => icon("tag").text_color(c),
                                None => icon("tag"),
                            },
                        )
                        .child(
                            div()
                                .flex_1()
                                .truncate()
                                .text_sm()
                                .child(label.name.clone()),
                        )
                        .when(has, |el| el.child(icon("check")))
                        .on_click(move |_, window, cx| {
                            if let Some(ws) = weak.upgrade() {
                                let action = if has {
                                    ThreadAction::RemoveLabel(id.clone())
                                } else {
                                    ThreadAction::AddLabel(id.clone())
                                };
                                let refs = refs.clone();
                                ws.update(cx, |ws, cx| ws.act_on(refs, action, window, cx));
                            }
                            window.close_dialog(cx);
                        }),
                );
            }
            dialog
                .title("Label")
                .child(v_flex().gap_2().child(Input::new(&filter)).child(list))
        });
    }

    fn name_dialog(
        &mut self,
        title: &'static str,
        initial: String,
        confirm: &'static str,
        on_ok: impl Fn(&mut Workspace, String, &mut Window, &mut Context<Workspace>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| InputState::new(window, cx).default_value(initial));
        input.update(cx, |i, cx| i.focus(window, cx));
        let weak = cx.entity().downgrade();
        let on_ok = std::rc::Rc::new(on_ok);
        let submit = {
            let (input, on_ok) = (input.clone(), on_ok.clone());
            std::rc::Rc::new(move |window: &mut Window, cx: &mut App| {
                let name = input.read(cx).value().trim().to_string();
                if name.is_empty() {
                    return;
                }
                if let Some(ws) = weak.upgrade() {
                    let on_ok = on_ok.clone();
                    ws.update(cx, |ws, cx| on_ok(ws, name, window, cx));
                }
                window.close_dialog(cx);
            })
        };
        let on_enter = submit.clone();
        cx.subscribe_in(
            &input,
            window,
            move |_, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    on_enter(window, cx);
                }
            },
        )
        .detach();
        window.open_dialog(cx, move |dialog, _, _| {
            let submit = submit.clone();
            dialog.title(title).child(
                v_flex().gap_4().child(Input::new(&input)).child(
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("cancel")
                                .label("Cancel")
                                .outline()
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        )
                        .child(
                            Button::new("ok")
                                .label(confirm)
                                .primary()
                                .on_click(move |_, window, cx| submit(window, cx)),
                        ),
                ),
            )
        });
    }

    fn report<T: 'static>(
        &self,
        task: impl std::future::Future<Output = anyhow::Result<T>> + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.spawn_in(window, async move |_, cx| {
            if let Err(err) = task.await {
                let _ = cx.update(|window, cx| {
                    window.push_notification(Notification::error(format!("{err:#}")), cx)
                });
            }
        })
        .detach();
    }

    pub fn prompt_new_label(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(account_id) = self.target_account(cx) else {
            return;
        };
        self.name_dialog(
            "New Label",
            String::new(),
            "Create",
            move |this, name, window, cx| {
                let b = this.backend.clone();
                let account = account_id.clone();
                let task = this
                    .backend
                    .spawn(async move { b.create_label(account, name).await });
                this.report(task, window, cx);
            },
            window,
            cx,
        );
    }

    pub fn prompt_rename_label(
        &mut self,
        label: Label,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let initial = label.name.clone();
        self.name_dialog(
            "Rename Label",
            initial,
            "Rename",
            move |this, name, window, cx| {
                let b = this.backend.clone();
                let label = label.clone();
                let task = this.backend.spawn(async move {
                    b.rename_label(label.account_id.clone(), label, name).await
                });
                this.report(task, window, cx);
            },
            window,
            cx,
        );
    }

    pub fn prompt_label_color(
        &mut self,
        label: Label,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let weak = cx.entity().downgrade();
        window.open_dialog(cx, move |dialog, _, cx| {
            let theme = cx.theme().clone();
            let mut grid = h_flex().flex_wrap().gap_2();
            let choices: Vec<Option<(&str, &str)>> = std::iter::once(None)
                .chain(LABEL_COLORS.iter().map(|c| Some(*c)))
                .collect();
            for (i, color) in choices.into_iter().enumerate() {
                let (weak, label) = (weak.clone(), label.clone());
                grid = grid.child(
                    div()
                        .id(("label-color", i))
                        .size_7()
                        .rounded_full()
                        .cursor_pointer()
                        .border_1()
                        .border_color(theme.border)
                        .map(|el| match color.and_then(|(bg, _)| parse_hex(bg)) {
                            Some(c) => el.bg(c),
                            None => el.flex().items_center().justify_center().child(icon("x")),
                        })
                        .on_click(move |_, window, cx| {
                            if let Some(ws) = weak.upgrade() {
                                let label = label.clone();
                                let color = color.map(|(a, b)| (a.to_string(), b.to_string()));
                                ws.update(cx, |ws, cx| {
                                    let b = ws.backend.clone();
                                    let task = ws.backend.spawn(async move {
                                        b.set_label_color(label.account_id.clone(), label, color)
                                            .await
                                    });
                                    ws.report(task, window, cx);
                                });
                            }
                            window.close_dialog(cx);
                        }),
                );
            }
            dialog.title("Label Color").child(grid)
        });
    }

    pub fn confirm_delete_label(
        &mut self,
        label: Label,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let weak = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (weak, label) = (weak.clone(), label.clone());
            alert
                .title(format!("Delete “{}”?", label.name))
                .description("Conversations keep their other labels; none are deleted.")
                .confirm()
                .ok_text("Delete Label")
                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    if let Some(ws) = weak.upgrade() {
                        let label = label.clone();
                        ws.update(cx, |ws, cx| {
                            if ws.folder == Folder::Label(label.id.clone()) {
                                ws.go(
                                    ws.scope.clone(),
                                    Folder::System(SystemFolder::Inbox),
                                    window,
                                    cx,
                                );
                            }
                            let b = ws.backend.clone();
                            let task = ws.backend.spawn(async move {
                                b.delete_label(label.account_id.clone(), label.id.clone())
                                    .await
                            });
                            ws.report(task, window, cx);
                        });
                    }
                    true
                })
        });
    }

    pub fn confirm_empty(&mut self, label_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let accounts: Vec<String> = match &self.scope {
            Scope::All => self
                .accounts
                .iter()
                .filter(|a| a.enabled)
                .map(|a| a.id.clone())
                .collect(),
            Scope::Account(id) => vec![id.clone()],
        };
        let what = if label_id == "SPAM" { "Junk" } else { "Trash" };
        let weak = cx.entity().downgrade();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (weak, accounts, label_id) = (weak.clone(), accounts.clone(), label_id.clone());
            alert
                .title(format!("Empty {what}?"))
                .description("Everything in it is deleted forever. This can't be undone.")
                .confirm()
                .ok_text(format!("Empty {what}"))
                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                .on_ok(move |_, window, cx| {
                    if let Some(ws) = weak.upgrade() {
                        let (accounts, label_id) = (accounts.clone(), label_id.clone());
                        ws.update(cx, |ws, cx| {
                            for account in accounts {
                                let b = ws.backend.clone();
                                let label_id = label_id.clone();
                                let task = ws
                                    .backend
                                    .spawn(async move { b.empty_folder(account, label_id).await });
                                ws.report(task, window, cx);
                            }
                        });
                    }
                    true
                })
        });
    }
}
