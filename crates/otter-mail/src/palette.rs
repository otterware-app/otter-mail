//! The command palette (⌘K): gpui-component's `Command` in a dialog. Every
//! entry carries an action; the app forwards them to the mail window, so
//! they work from the palette, menus and other windows alike.

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::component::command::{Command, CommandGroup, CommandItem, CommandState};
use gpui_kit::component::{ActiveTheme as _, ThemeMode, WindowExt as _, h_flex, kbd::Kbd};
use gpui_kit::*;
use mail_core::model::Scope;
use mail_core::model::*;

use crate::actions::*;
use crate::ui::icon;
use crate::workspace::Workspace;

#[derive(Action, Clone, PartialEq)]
#[action(namespace = otter, no_json)]
pub struct GoToMailbox(pub Option<String>);

#[derive(Action, Clone, PartialEq)]
#[action(namespace = otter, no_json)]
pub struct GoToFolder(pub SystemFolder);

#[derive(Action, Clone, PartialEq)]
#[action(namespace = otter, no_json)]
pub struct SwitchTheme(pub SharedString);

#[derive(Action, Clone, PartialEq)]
#[action(namespace = otter, no_json)]
pub struct SearchMail(pub String);

#[derive(Action, Clone, PartialEq)]
#[action(namespace = otter, no_json)]
pub struct OpenConversation(pub String, pub String);

/// The mail window, for actions dispatched from elsewhere.
pub struct MailWindow {
    pub workspace: WeakEntity<Workspace>,
    pub window: AnyWindowHandle,
}

impl Global for MailWindow {}

/// Runs `f` on the mail window's workspace.
pub fn with_workspace(
    cx: &mut App,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let Some(mail) = cx.try_global::<MailWindow>() else {
        return;
    };
    let (weak, handle) = (mail.workspace.clone(), mail.window);
    let Some(ws) = weak.upgrade() else { return };
    cx.defer(move |cx| {
        let _ = handle.update(cx, |_, window, cx| {
            ws.update(cx, |ws, cx| f(ws, window, cx))
        });
    });
}

pub fn init(cx: &mut App) {
    cx.on_action(|a: &GoToMailbox, cx| {
        let scope = match &a.0 {
            Some(id) => Scope::Account(id.clone()),
            None => Scope::All,
        };
        with_workspace(cx, move |ws, w, cx| {
            ws.go(scope, Folder::System(SystemFolder::Inbox), w, cx)
        });
    });
    cx.on_action(|a: &GoToFolder, cx| {
        let folder = a.0;
        with_workspace(cx, move |ws, w, cx| {
            ws.go(ws.scope.clone(), Folder::System(folder), w, cx)
        });
    });
    cx.on_action(|a: &SearchMail, cx| {
        let q = a.0.clone();
        with_workspace(cx, move |ws, w, cx| ws.run_search(q, w, cx));
    });
    cx.on_action(|a: &OpenConversation, cx| {
        let r = mail_core::ThreadRef {
            account_id: a.0.clone(),
            thread_id: a.1.clone(),
        };
        with_workspace(cx, move |ws, w, cx| ws.open_thread(r, true, w, cx));
    });
    cx.on_action(|a: &SwitchTheme, cx| {
        let name = a.0.clone();
        let mode = gpui_kit::component::ThemeRegistry::global(cx)
            .themes()
            .get(&name)
            .map(|t| t.mode);
        let backend = cx.global::<crate::app::AppBackend>().0.clone();
        let key = if mode == Some(ThemeMode::Dark) {
            crate::theme::DARK_KEY
        } else {
            crate::theme::LIGHT_KEY
        };
        backend.set_ui_pref(key, Some(name.to_string()));
        backend.set_ui_pref(
            crate::theme::SOURCE_KEY,
            Some(
                if mode == Some(ThemeMode::Dark) {
                    "dark"
                } else {
                    "light"
                }
                .into(),
            ),
        );
        crate::theme::apply(None, cx);
    });
    cx.on_action(|_: &Compose, cx| {
        with_workspace(cx, |ws, w, cx| {
            ws.compose(
                crate::composer::ComposeMode::New {
                    account_id: None,
                    to: vec![],
                },
                w,
                cx,
            )
        })
    });
    cx.on_action(|_: &SyncNow, cx| with_workspace(cx, |ws, _, _| ws.backend.sync_all(true)));
    cx.on_action(|_: &ToggleSidebar, cx| with_workspace(cx, |ws, _, cx| ws.toggle_sidebar(cx)));
    cx.on_action(|_: &ToggleBrowser, cx| with_workspace(cx, |ws, w, cx| ws.toggle_browser(w, cx)));
    cx.on_action(|_: &NewBrowserTab, cx| with_workspace(cx, |ws, w, cx| ws.new_browser_tab(w, cx)));
    cx.on_action(|_: &FocusBrowserAddress, cx| {
        with_workspace(cx, |ws, w, cx| ws.focus_browser_address(w, cx))
    });
    cx.on_action(|_: &OpenSettings, cx| crate::settings::open_settings(cx));
    cx.on_action(|_: &CommandPalette, cx| with_workspace(cx, |ws, w, cx| ws.open_palette(w, cx)));
}

impl Workspace {
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = cx.new(|cx| CommandState::new(window, cx));
        let weak = cx.entity().downgrade();
        let focus_on_mount = Rc::new(Cell::new(true));
        self.palette_mail.clear();
        window.open_dialog(cx, move |dialog, _, _| {
            let state = state.clone();
            let weak = weak.clone();
            let focus_on_mount = focus_on_mount.clone();
            dialog
                .close_button(false)
                .p_0()
                .content(move |content, window, cx| {
                    if focus_on_mount.replace(false) {
                        let state = state.clone();
                        window.defer(cx, move |window, cx| {
                            state.read(cx).focus_handle(cx).focus(window, cx)
                        });
                    }
                    let groups = weak
                        .read_with(cx, |ws, cx| ws.palette_groups(cx))
                        .unwrap_or_default();
                    let query_owner = weak.clone();
                    let command = groups.into_iter().fold(
                        Command::new(&state)
                            .bordered(false)
                            .placeholder("Search mail or type a command…")
                            .max_h(px(420.))
                            .on_query(move |query, _window, cx| {
                                let q = query.trim().to_string();
                                let _ = query_owner.update(cx, |ws, cx| ws.palette_search(q, cx));
                            })
                            .on_confirm(|_, window, cx| window.close_dialog(cx))
                            .footer(|_, _, cx| {
                                h_flex()
                                    .gap_3()
                                    .px_3()
                                    .py_2()
                                    .border_t_1()
                                    .border_color(cx.theme().border)
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child(key_hint(&["up", "down"], "Navigate"))
                                    .child(key_hint(&["enter"], "Open"))
                                    .child(key_hint(&["escape"], "Close"))
                            }),
                        |command, group| command.group(group),
                    );
                    content.child(command)
                })
        });
    }

    fn palette_search(&mut self, q: String, cx: &mut Context<Self>) {
        self.palette_query = q.clone();
        if q.chars().count() < 2 {
            self.palette_mail.clear();
            cx.notify();
            return;
        }
        let accounts: Vec<String> = self
            .accounts
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.id.clone())
            .collect();
        let task = self.backend.blocking(move |b| {
            let mut rows = Vec::new();
            for a in &accounts {
                let query = mail_core::search::parse_query(&q, a);
                rows.extend(b.store().search_threads(&query, 0, 10)?.0);
            }
            rows.sort_by(|a, b| b.date.cmp(&a.date));
            rows.truncate(10);
            Ok(rows)
        });
        cx.spawn(async move |this, cx| {
            if let Ok(rows) = task.await {
                let _ = this.update(cx, |this, cx| {
                    this.palette_mail = rows;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    fn palette_groups(&self, cx: &App) -> Vec<CommandGroup> {
        let mut groups = Vec::new();
        let q = self.palette_query.clone();
        if !q.is_empty() {
            let mut mail = CommandGroup::new().label("Mail").item(
                CommandItem::new()
                    .label(format!("Search mail for “{q}”"))
                    .icon(icon("search"))
                    .keywords([q.clone()])
                    .action(Box::new(SearchMail(q.clone()))),
            );
            for row in &self.palette_mail {
                let sender = row
                    .senders
                    .first()
                    .map(|s| s.display().to_string())
                    .unwrap_or_default();
                let subject = if row.subject.is_empty() {
                    "(no subject)".to_string()
                } else {
                    row.subject.clone()
                };
                mail = mail.item(
                    CommandItem::new()
                        .label(format!("{subject} — {sender}"))
                        .icon(icon("mail"))
                        .keywords([q.clone(), sender, row.snippet.clone()])
                        .action(Box::new(OpenConversation(
                            row.account_id.clone(),
                            row.id.clone(),
                        ))),
                );
            }
            groups.push(mail);
        }
        let shortcut = |keys: &str| Kbd::new(Keystroke::parse(keys).expect("a valid keystroke"));
        let _ = shortcut;
        groups.push(
            CommandGroup::new()
                .label("Actions")
                .item(
                    CommandItem::new()
                        .label("New Message")
                        .icon(icon("square-pen"))
                        .action(Box::new(Compose)),
                )
                .item(
                    CommandItem::new()
                        .label("Sync Now")
                        .icon(icon("refresh-cw"))
                        .action(Box::new(SyncNow)),
                )
                .item(
                    CommandItem::new()
                        .label("Toggle Sidebar")
                        .icon(icon("panel-left"))
                        .action(Box::new(ToggleSidebar)),
                )
                .item(
                    CommandItem::new()
                        .label("Settings")
                        .icon(icon("settings"))
                        .keywords(["preferences", "add mailbox", "account"])
                        .action(Box::new(OpenSettings)),
                ),
        );
        let mut mailboxes = CommandGroup::new().label("Mailboxes");
        let enabled: Vec<&Account> = self.accounts.iter().filter(|a| a.enabled).collect();
        if enabled.len() > 1 {
            mailboxes = mailboxes.item(
                CommandItem::new()
                    .label("All mailboxes")
                    .icon(icon("layers"))
                    .checked(self.scope == Scope::All)
                    .action(Box::new(GoToMailbox(None))),
            );
        }
        for a in enabled {
            mailboxes = mailboxes.item(
                CommandItem::new()
                    .label(a.title().to_string())
                    .icon(icon("inbox"))
                    .keywords([a.email.clone()])
                    .checked(self.scope == Scope::Account(a.id.clone()))
                    .action(Box::new(GoToMailbox(Some(a.id.clone())))),
            );
        }
        groups.push(mailboxes);
        let mut folders = CommandGroup::new().label("Go To");
        for f in SystemFolder::ALL {
            folders = folders.item(
                CommandItem::new()
                    .label(f.title())
                    .icon(icon("folder"))
                    .checked(self.folder == Folder::System(f))
                    .action(Box::new(GoToFolder(f))),
            );
        }
        groups.push(folders);
        let active = cx.theme().theme_name().clone();
        let mut themes = CommandGroup::new().label("Themes");
        for t in gpui_kit::component::ThemeRegistry::global(cx).sorted_themes() {
            themes = themes.item(
                CommandItem::new()
                    .label(format!("Theme: {}", t.name))
                    .icon(icon("palette"))
                    .keywords([t.mode.name()])
                    .checked(t.name == active)
                    .action(Box::new(SwitchTheme(t.name.clone()))),
            );
        }
        groups.push(themes);
        groups
    }
}

fn key_hint(keys: &[&str], label: &'static str) -> AnyElement {
    h_flex()
        .gap_1()
        .items_center()
        .children(
            keys.iter()
                .map(|key| Kbd::new(Keystroke::parse(key).expect("a valid key"))),
        )
        .child(label)
        .into_any_element()
}
