//! Settings inside the mail workspace (⌘,), built on gpui-component's `Settings`
//! (pages, groups, search, reset to defaults).

use gpui_kit::component::StyledExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::group_box::GroupBoxVariant;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::list::ListItem;
use gpui_kit::component::setting::{
    SettingField, SettingGroup, SettingItem, SettingPage, Settings,
};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Sizable as _, ThemeMode, WindowExt as _, h_flex, kbd::Kbd,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::Backend;
use mail_core::config::AppSettings;

use crate::app::AppBackend;
use crate::ui::{SIDEBAR_WIDTH, account_avatar, icon, sidebar_surface};

/// A Google sign-in started from Settings is waiting for the browser.
#[derive(Default)]
pub struct SigningIn(pub bool);

impl Global for SigningIn {}

/// All entry points route Settings into the existing mail window.
pub fn open_settings(cx: &mut App) {
    crate::palette::with_workspace(cx, |ws, window, cx| ws.show_settings(window, cx));
}

pub struct SettingsView {
    focus: FocusHandle,
    search: Entity<InputState>,
    pub page: usize,
    _subscription: Subscription,
}

impl SettingsView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        if !cx.has_global::<SigningIn>() {
            cx.set_global(SigningIn::default());
        }
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search"));
        let subscription = cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });
        SettingsView {
            focus: cx.focus_handle(),
            search,
            page: 0,
            _subscription: subscription,
        }
    }
}

fn backend(cx: &App) -> Backend {
    cx.global::<AppBackend>().0.clone()
}

fn update_settings(cx: &mut App, f: impl FnOnce(&mut AppSettings)) {
    let b = backend(cx);
    let mut s = b.settings();
    f(&mut s);
    if let Err(err) = b.set_settings(s) {
        log::warn!("saving settings: {err:#}");
    }
    cx.refresh_windows();
}

fn pref(cx: &App, key: &str) -> Option<String> {
    backend(cx).ui_pref(key)
}

fn set_pref(cx: &mut App, key: &str, value: impl Into<String>) {
    backend(cx).set_ui_pref(key, Some(value.into()));
    // The mail window regroups its list and repaints.
    crate::palette::with_workspace(cx, |ws, _, cx| ws.reload_list(false, cx));
    cx.refresh_windows();
}

fn bool_pref(key: &'static str, default: bool) -> SettingField<bool> {
    SettingField::switch(
        move |cx: &App| pref(cx, key).map(|v| v == "true").unwrap_or(default),
        move |v: bool, cx: &mut App| set_pref(cx, key, v.to_string()),
    )
    .default_value(default)
}

fn options(pairs: &[(&str, &str)]) -> Vec<(SharedString, SharedString)> {
    pairs
        .iter()
        .map(|(v, l)| {
            (
                SharedString::from(v.to_string()),
                SharedString::from(l.to_string()),
            )
        })
        .collect()
}

fn general_page() -> SettingPage {
    SettingPage::new("General")
        .icon(icon("settings-2"))
        .default_open(true)
        .resettable(true)
        .groups(vec![
            SettingGroup::new().title("Mail").items(vec![
                SettingItem::new(
                    "Check for new mail",
                    SettingField::dropdown(
                        options(&[
                            ("0", "Manually"),
                            ("15", "Every 15 seconds"),
                            ("30", "Every 30 seconds"),
                            ("60", "Every minute"),
                            ("300", "Every 5 minutes"),
                            ("900", "Every 15 minutes"),
                        ]),
                        |cx: &App| backend(cx).settings().sync_interval_seconds.to_string().into(),
                        |v: SharedString, cx: &mut App| {
                            let secs = v.parse().unwrap_or(30);
                            update_settings(cx, |s| s.sync_interval_seconds = secs)
                        },
                    )
                    .default_value(SharedString::from("30")),
                )
                .description("Sync runs in the background at this cadence."),
                SettingItem::new(
                    "Notifications",
                    SettingField::dropdown(
                        options(&[("off", "Off"), ("inbox", "Inbox only"), ("all", "All new mail")]),
                        |cx: &App| backend(cx).settings().notifications_mode.into(),
                        |v: SharedString, cx: &mut App| update_settings(cx, |s| s.notifications_mode = v.to_string()),
                    )
                    .default_value(SharedString::from("inbox")),
                )
                .description("Notify about new mail found by background sync."),
                SettingItem::new(
                    "After archive, delete, or move",
                    SettingField::dropdown(
                        options(&[("next", "Next message"), ("previous", "Previous message"), ("none", "Don't select")]),
                        |cx: &App| pref(cx, "gmail:advance").unwrap_or_else(|| "next".into()).into(),
                        |v: SharedString, cx: &mut App| set_pref(cx, "gmail:advance", v.to_string()),
                    )
                    .default_value(SharedString::from("next")),
                )
                .description("Which message to select next in the list."),
                SettingItem::new(
                    "Show unread count on Dock icon",
                    SettingField::switch(
                        |cx: &App| backend(cx).settings().dock_badge_enabled,
                        |v: bool, cx: &mut App| update_settings(cx, |s| s.dock_badge_enabled = v),
                    )
                    .default_value(false),
                )
                .description("A badge with the number of unread messages in your inboxes."),
            ]),
            SettingGroup::new().title("Reading").items(vec![
                SettingItem::new("Group messages by day", bool_pref("otter:group-messages-by-day", true)),
                SettingItem::new("Open messages with arrow keys", bool_pref("otter:open-messages-with-arrows", false)),
                SettingItem::new(
                    "Mark as read",
                    SettingField::dropdown(
                        options(&[("0", "Immediately"), ("1000", "After 1 second"), ("2000", "After 2 seconds"), ("5000", "After 5 seconds")]),
                        |cx: &App| pref(cx, "otter:mark-read-delay").unwrap_or_else(|| "2000".into()).into(),
                        |v: SharedString, cx: &mut App| set_pref(cx, "otter:mark-read-delay", v.to_string()),
                    )
                    .default_value(SharedString::from("2000")),
                )
                .description("When a message opened with the keyboard counts as read. Clicks mark it read at once."),
            ]),
        ])
}

fn theme_field(mode: ThemeMode, key: &'static str, cx: &App) -> SettingField<SharedString> {
    let names: Vec<(SharedString, SharedString)> = crate::theme::names(mode, cx)
        .into_iter()
        .map(|n| (n.clone(), n))
        .collect();
    SettingField::scrollable_dropdown(
        names,
        move |cx: &App| {
            pref(cx, key)
                .map(SharedString::from)
                .unwrap_or_else(|| match mode {
                    ThemeMode::Dark => "Codex Dark".into(),
                    _ => "Codex Light".into(),
                })
        },
        move |v: SharedString, cx: &mut App| {
            backend(cx).set_ui_pref(key, Some(v.to_string()));
            crate::theme::apply(None, cx);
        },
    )
}

fn appearance_page(cx: &App) -> SettingPage {
    SettingPage::new("Appearance")
        .icon(icon("palette"))
        .resettable(true)
        .groups(vec![
            SettingGroup::new().title("Theme").items(vec![
                SettingItem::new(
                    "Appearance",
                    SettingField::dropdown(
                        options(&[("system", "System"), ("light", "Light"), ("dark", "Dark")]),
                        |cx: &App| {
                            pref(cx, crate::theme::SOURCE_KEY)
                                .unwrap_or_else(|| "system".into())
                                .into()
                        },
                        |v: SharedString, cx: &mut App| {
                            backend(cx).set_ui_pref(crate::theme::SOURCE_KEY, Some(v.to_string()));
                            crate::theme::apply(None, cx);
                        },
                    )
                    .default_value(SharedString::from("system")),
                )
                .description("Follow the system, or always light or dark."),
                SettingItem::new(
                    "Light theme",
                    theme_field(ThemeMode::Light, crate::theme::LIGHT_KEY, cx),
                )
                .description("Worn in light mode."),
                SettingItem::new(
                    "Dark theme",
                    theme_field(ThemeMode::Dark, crate::theme::DARK_KEY, cx),
                )
                .description("Worn in dark mode."),
            ]),
            SettingGroup::new().title("Message list").items(vec![
                SettingItem::new(
                    "Dim read messages",
                    bool_pref("otter:dim-read-messages", true),
                )
                .description("Give read conversations a quiet background."),
            ]),
        ])
}

fn mailbox_item(account: mail_core::model::Account) -> SettingItem {
    SettingItem::render(move |_options, _window, cx| {
        let theme = cx.theme().clone();
        let a = account.clone();
        let status = if a.signed_out {
            "Signed out".to_string()
        } else {
            match a.provider {
                mail_core::model::ProviderKind::Gmail => "Gmail".into(),
                mail_core::model::ProviderKind::Imap => "IMAP".into(),
                mail_core::model::ProviderKind::Demo => "Demo".into(),
            }
        };
        let (id_toggle, id_remove, id_signin) = (a.id.clone(), a.id.clone(), a.email.clone());
        h_flex()
            .w_full()
            .gap_3()
            .child(account_avatar(&a))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .truncate()
                            .text_sm()
                            .font_medium()
                            .child(a.title().to_string()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_xs()
                            .text_color(if a.signed_out {
                                theme.danger
                            } else {
                                theme.muted_foreground
                            })
                            .child(format!("{} · {status}", a.email)),
                    ),
            )
            .when(
                a.signed_out && a.provider == mail_core::model::ProviderKind::Gmail,
                |el| {
                    el.child(
                        Button::new(SharedString::from(format!("signin-{}", a.id)))
                            .label("Sign In")
                            .small()
                            .on_click(move |_, _, cx| {
                                cx.global_mut::<SigningIn>().0 = true;
                                backend(cx).add_gmail_account(Some(id_signin.clone()));
                            }),
                    )
                },
            )
            .child(
                Switch::new(SharedString::from(format!("on-{}", a.id)))
                    .checked(a.enabled)
                    .tooltip("Show this mailbox")
                    .on_change(move |on: &bool, _, cx| {
                        let b = backend(cx);
                        let mut arrangement = b.arrangement();
                        arrangement.off.retain(|x| x != &id_toggle);
                        if !*on {
                            arrangement.off.push(id_toggle.clone());
                        }
                        let _ = b.set_arrangement(arrangement);
                        cx.refresh_windows();
                    }),
            )
            .child(
                Button::new(SharedString::from(format!("remove-{}", a.id)))
                    .label("Remove")
                    .small()
                    .danger()
                    .on_click(move |_, window, cx| {
                        let id = id_remove.clone();
                        window.open_alert_dialog(cx, move |alert, _, _| {
                            let id = id.clone();
                            alert
                                .title(format!("Remove {id}?"))
                                .description(
                                    "Its mail leaves this Mac. The mailbox itself isn't touched.",
                                )
                                .confirm()
                                .ok_text("Remove")
                                .ok_variant(gpui_kit::component::button::ButtonVariant::Danger)
                                .on_ok(move |_, _, cx| {
                                    let _ = backend(cx).remove_account(&id);
                                    cx.refresh_windows();
                                    true
                                })
                        });
                    }),
            )
            .into_any_element()
    })
}

fn mailboxes_page(cx: &App) -> SettingPage {
    let accounts = backend(cx).accounts();
    let mut list = SettingGroup::new().title("Your mailboxes");
    for a in &accounts {
        let id = a.id.clone();
        let id2 = a.id.clone();
        list = list.item(mailbox_item(a.clone())).item(
            SettingItem::new(
                format!("Name for {}", a.email),
                SettingField::input(
                    move |cx: &App| {
                        backend(cx)
                            .accounts()
                            .into_iter()
                            .find(|x| x.id == id)
                            .and_then(|x| x.display_name)
                            .unwrap_or_default()
                            .into()
                    },
                    move |v: SharedString, cx: &mut App| {
                        let _ =
                            backend(cx).update_account(&id2, Some(Some(v.to_string())), None, None);
                        cx.refresh_windows();
                    },
                ),
            )
            .description("What the sidebar calls this mailbox."),
        );
    }
    if accounts.is_empty() {
        list = list.item(SettingItem::render(|_, _, cx| {
            div()
                .text_sm()
                .text_color(cx.theme().muted_foreground)
                .child("No mailboxes yet.")
                .into_any_element()
        }));
    }
    SettingPage::new("Mailboxes")
        .icon(icon("mail"))
        .groups(vec![
            list,
            SettingGroup::new().title("Add").items(vec![
                SettingItem::render(|_, _, cx| {
                    let signing_in = cx.try_global::<SigningIn>().is_some_and(|s| s.0);
                    let configured = mail_core::google::configured();
                    h_flex()
                        .w_full()
                        .gap_2()
                        .child(
                            Button::new("add-gmail")
                                .primary()
                                .icon(icon("plus"))
                                .label(if signing_in {
                                    "Waiting for Google…"
                                } else {
                                    "Add a Gmail Mailbox"
                                })
                                .loading(signing_in)
                                .disabled(!configured)
                                .on_click(|_, _, cx| {
                                    cx.global_mut::<SigningIn>().0 = true;
                                    backend(cx).add_gmail_account(None);
                                    cx.refresh_windows();
                                }),
                        )
                        .when(signing_in, |el| {
                            el.child(
                                Button::new("cancel-signin")
                                    .ghost()
                                    .label("Cancel")
                                    .on_click(|_, _, cx| {
                                        backend(cx).cancel_sign_in();
                                        cx.global_mut::<SigningIn>().0 = false;
                                        cx.refresh_windows();
                                    }),
                            )
                        })
                        .when(!configured, |el| {
                            el.child(
                                div()
                                    .text_xs()
                                    .text_color(cx.theme().muted_foreground)
                                    .child("This build has no Google client configured."),
                            )
                        })
                        .into_any_element()
                })
                .description("Sign in with Google in your browser."),
                SettingItem::new(
                    "Show All mailboxes",
                    SettingField::switch(
                        |cx: &App| backend(cx).arrangement().combined,
                        |v: bool, cx: &mut App| {
                            let b = backend(cx);
                            let mut arrangement = b.arrangement();
                            arrangement.combined = v;
                            let _ = b.set_arrangement(arrangement);
                            cx.refresh_windows();
                        },
                    )
                    .default_value(true),
                )
                .description("One list of every mailbox that's on."),
            ]),
        ])
}

fn shortcuts_page() -> SettingPage {
    let pairs: &[(&str, &[&str])] = &[
        ("Next / previous conversation", &["j", "k"]),
        ("Open", &["enter"]),
        ("Close", &["u", "escape"]),
        ("Archive", &["e"]),
        ("Move to Trash", &["shift-3"]),
        ("Move to Junk", &["shift-1"]),
        ("Flag", &["s"]),
        ("Mark as read / unread", &["shift-i", "shift-u"]),
        ("Reply / Reply all / Forward", &["r", "a", "f"]),
        ("New message", &["c"]),
        ("Send", &["cmd-enter"]),
        ("Label", &["l"]),
        ("Undo / Redo", &["z", "shift-z"]),
        ("Search", &["/", "cmd-f"]),
        (
            "Go to Inbox / Sent / Starred / Drafts / All Mail",
            &["g", "i"],
        ),
        ("Command palette", &["cmd-k"]),
        ("Toggle sidebar", &["cmd-b"]),
        ("Back / Forward", &["cmd-[", "cmd-]"]),
        ("Mailboxes", &["cmd-1"]),
        ("Sync now", &["cmd-r"]),
        ("Settings", &["cmd-,"]),
    ];
    let items: Vec<SettingItem> = pairs
        .iter()
        .map(|(what, keys)| {
            let keys: Vec<&'static str> = keys.to_vec();
            SettingItem::new(
                *what,
                SettingField::render(move |_, _, _| {
                    h_flex().gap_1().children(
                        keys.iter()
                            .filter_map(|k| Keystroke::parse(k).ok())
                            .map(Kbd::new),
                    )
                }),
            )
        })
        .collect();
    SettingPage::new("Keybindings")
        .icon(icon("keyboard"))
        .group(SettingGroup::new().title("Shortcuts").items(items))
}

fn about_page(cx: &App) -> SettingPage {
    let dir = backend(cx).paths().state_dir.display().to_string();
    SettingPage::new("About")
        .icon(icon("info"))
        .group(SettingGroup::new().items(vec![
            SettingItem::render(|_, _, cx| {
                v_flex()
                    .w_full()
                    .items_center()
                    .gap_2()
                    .py_4()
                    .child(icon("mail").size_10())
                    .child(div().text_lg().font_semibold().child("Otter Mail"))
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.theme().muted_foreground)
                            .child(format!(
                                "Version {} · native (GPUI)",
                                env!("CARGO_PKG_VERSION")
                            )),
                    )
                    .into_any_element()
            }),
            SettingItem::new(
                "Data folder",
                SettingField::render(move |_, _, _| {
                    let dir = dir.clone();
                    Button::new("open-data")
                        .outline()
                        .small()
                        .label("Show in Finder")
                        .on_click(move |_, _, _| {
                            let _ = open::that_detached(&dir);
                        })
                }),
            )
            .description(backend(cx).paths().state_dir.display().to_string()),
        ]))
}

impl Focusable for SettingsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn browser_page() -> SettingPage {
    SettingPage::new("Browser").group(SettingGroup::new().title("Links").items(vec![
            SettingItem::new(
                "Open links in the side panel",
                bool_pref("otter:browser:open-links", true),
            )
            .description("Keep web pages beside your mail."),
            SettingItem::new(
                "New tab",
                SettingField::render(|_, _, _| {
                    Button::new("open-browser-from-settings")
                        .outline()
                        .small()
                        .label("Open browser")
                        .on_click(|_, _, cx| {
                            crate::palette::with_workspace(cx, |ws, w, cx| {
                                ws.new_browser_tab(w, cx)
                            })
                        })
                }),
            ),
        ]))
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let pages = [
            (
                "General",
                "settings-2",
                "mail notifications sync reading unread dock",
                general_page(),
            ),
            (
                "Appearance",
                "palette",
                "theme light dark colors font",
                appearance_page(cx),
            ),
            (
                "Mailboxes",
                "mail",
                "accounts gmail imap name",
                mailboxes_page(cx),
            ),
            (
                "Keybindings",
                "keyboard",
                "keyboard shortcuts",
                shortcuts_page(),
            ),
            ("Browser", "globe", "links tabs address web", browser_page()),
            ("About", "info", "version data folder", about_page(cx)),
        ];
        let query = self.search.read(cx).value().to_lowercase();
        let mut sidebar = v_flex()
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .bg(sidebar_surface(cx))
            .border_r_1()
            .border_color(theme.border.opacity(0.7))
            .px_2()
            .gap_1()
            .child(
                div()
                    .px(px(10.))
                    .pt_4()
                    .pb_2()
                    .text_size(px(16.))
                    .font_semibold()
                    .child("Settings"),
            )
            .child(
                div().mb_2().child(
                    Input::new(&self.search)
                        .small()
                        .appearance(false)
                        .rounded_full()
                        .bg(theme.foreground.opacity(0.06))
                        .prefix(icon("search").size(px(16.))),
                ),
            );
        for (ix, (title, name, keywords, _)) in pages.iter().enumerate() {
            if *title == "Browser" && !crate::browser::SUPPORTED {
                continue;
            }
            if query.is_empty()
                || format!("{title} {keywords}")
                    .to_lowercase()
                    .contains(&query)
            {
                sidebar = sidebar.child(
                    ListItem::new(*title)
                        .accessibility_label(*title)
                        .h(px(32.))
                        .px(px(10.))
                        .py_0()
                        .rounded(px(8.))
                        .selected(self.page == ix)
                        .child(
                            h_flex()
                                .gap_3()
                                .child(icon(name).size(px(16.)).text_color(theme.muted_foreground))
                                .child(div().text_size(px(14.)).child(*title)),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.page = ix;
                            cx.notify();
                        })),
                );
            }
        }
        sidebar = sidebar.child(div().flex_1()).child(
            ListItem::new("settings-back")
                .accessibility_label("Back")
                .h(px(36.))
                .px(px(10.))
                .rounded(px(8.))
                .child(
                    h_flex()
                        .gap_3()
                        .child(icon("arrow-left").size(px(16.)))
                        .child("Back"),
                )
                .on_click(|_, _, cx| {
                    crate::palette::with_workspace(cx, |ws, w, cx| ws.hide_settings(w, cx))
                }),
        );
        let active = pages[self.page].3.clone().header_style(
            div()
                .pt_6()
                .pb_6()
                .px_4()
                .border_0()
                .text_size(px(24.))
                .font_medium()
                .style(),
        );
        h_flex()
            .size_full()
            .track_focus(&self.focus)
            .child(sidebar)
            .child(
                div().flex_1().min_w_0().h_full().px_6().pt_5().child(
                    div().max_w(px(792.)).w_full().h_full().mx_auto().child(
                        Settings::new(SharedString::from(format!("settings-page-{}", self.page)))
                            .sidebar_width(px(0.))
                            .sidebar_size_range(px(0.)..px(0.))
                            .sidebar_style(div().hidden().style())
                            .with_group_variant(GroupBoxVariant::Outline)
                            .small()
                            .page(active),
                    ),
                ),
            )
    }
}
