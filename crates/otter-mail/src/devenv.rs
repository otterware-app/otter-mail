//! Development runs only: the main checkout's `.env.local` (the Google OAuth
//! client, and the demo mailboxes `OTTER_MAIL_DEMO_MAILBOXES` lists, with
//! their refresh tokens), as `pnpm dev:demo:desktop` uses them.

use mail_core::Backend;

/// Reads `.env.local` from the working directory or its parents into the
/// environment (without overriding what's set).
pub fn load_env_local() {
    let mut dir = std::env::current_dir().ok();
    while let Some(d) = dir {
        let file = d.join(".env.local");
        if let Ok(text) = std::fs::read_to_string(&file) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                let Some((key, value)) = line.split_once('=') else {
                    continue;
                };
                let key = key.trim();
                let value = value.trim().trim_matches('\'').trim_matches('"');
                if std::env::var_os(key).is_none() {
                    // SAFETY: called at startup, before any other thread runs.
                    unsafe { std::env::set_var(key, value) };
                }
            }
            log::info!("loaded {}", file.display());
            return;
        }
        dir = d.parent().map(|p| p.to_path_buf());
    }
}

/// Adds the demo Gmail mailboxes with their desktop refresh tokens, when
/// asked (`OTTER_MAIL_DEMO=1`).
pub fn add_demo_mailboxes(backend: &Backend) {
    if std::env::var("OTTER_MAIL_DEMO").as_deref() != Ok("1") {
        return;
    }
    let Ok(json) = std::env::var("OTTER_MAIL_DEMO_MAILBOXES") else {
        return;
    };
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&json) else {
        log::warn!("OTTER_MAIL_DEMO_MAILBOXES isn't JSON");
        return;
    };
    for mailbox in list {
        if mailbox["provider"] != "gmail" {
            continue;
        }
        let (Some(email), Some(token)) = (
            mailbox["email"].as_str(),
            mailbox["refreshTokens"]["desktop"].as_str(),
        ) else {
            continue;
        };
        match backend.add_gmail_with_refresh_token(email, token) {
            Ok(()) => log::info!("demo mailbox {email} ready"),
            Err(err) => log::warn!("adding {email}: {err:#}"),
        }
    }
}

/// Development runs only: commands written to `/tmp/otter-mail-dev-cmd`
/// drive the window (for screenshots and checks without a mouse):
/// `action otter::NextMessage`, `open 0`, `settings`, `palette`.
pub fn watch_commands(
    workspace: gpui_kit::WeakEntity<crate::workspace::Workspace>,
    window: &mut gpui_kit::Window,
    cx: &mut gpui_kit::App,
) {
    use gpui_kit::*;
    let path = std::path::PathBuf::from("/tmp/otter-mail-dev-cmd");
    let _ = std::fs::remove_file(&path);
    window
        .spawn(cx, async move |cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let _ = std::fs::remove_file(&path);
                for line in text.lines() {
                    let line = line.trim().to_string();
                    let workspace = workspace.clone();
                    let _ = cx.update(move |window, cx| {
                        let (cmd, arg) = line.split_once(' ').unwrap_or((line.as_str(), ""));
                        match cmd {
                            "action" => match cx.build_action(arg, None) {
                                Ok(action) => window.dispatch_action(action, cx),
                                Err(err) => log::warn!("dev: {err:?}"),
                            },
                            "open" => {
                                let ix: usize = arg.parse().unwrap_or(0);
                                if let Some(ws) = workspace.upgrade() {
                                    ws.update(cx, |ws, cx| {
                                        let r = ws
                                            .list
                                            .read(cx)
                                            .delegate()
                                            .visible_refs()
                                            .get(ix)
                                            .cloned();
                                        if let Some(r) = r {
                                            ws.open_thread(r, true, window, cx);
                                        }
                                    });
                                }
                            }
                            "settings" => crate::settings::open_settings(cx),
                            "mail" => {
                                if let Some(ws) = workspace.upgrade() {
                                    ws.update(cx, |ws, cx| ws.hide_settings(window, cx));
                                }
                            }
                            "browser" => {
                                if let Some(ws) = workspace.upgrade() {
                                    ws.update(cx, |ws, cx| {
                                        if arg.is_empty() {
                                            ws.toggle_browser(window, cx);
                                        } else {
                                            ws.open_link(arg, window, cx);
                                        }
                                    });
                                }
                            }
                            "browser-state" => {
                                if let Some(ws) = workspace.upgrade() {
                                    log::info!("{}", ws.read(cx).browser.read(cx).describe(cx));
                                }
                            }

                            "palette" => {
                                if let Some(ws) = workspace.upgrade() {
                                    ws.update(cx, |ws, cx| ws.open_palette(window, cx));
                                }
                            }
                            "compose" => {
                                if let Some(ws) = workspace.upgrade() {
                                    ws.update(cx, |ws, cx| {
                                        ws.compose(
                                            crate::composer::ComposeMode::New {
                                                account_id: None,
                                                to: vec![],
                                            },
                                            window,
                                            cx,
                                        )
                                    });
                                }
                            }
                            "theme" => {
                                let backend = cx.global::<crate::app::AppBackend>().0.clone();
                                let (key, value) =
                                    arg.split_once(' ').unwrap_or(("otter:theme-source", arg));
                                backend.set_ui_pref(key, Some(value.to_string()));
                                crate::theme::apply(Some(window), cx);
                            }
                            "size" => {
                                let (w, h) = arg.split_once('x').unwrap_or(("1600", "1000"));
                                let (w, h): (f32, f32) =
                                    (w.parse().unwrap_or(1600.), h.parse().unwrap_or(1000.));
                                window.resize(size(px(w), px(h)));
                            }
                            _ => log::warn!("dev: unknown command {line}"),
                        }
                    });
                }
            }
        })
        .detach();
}
