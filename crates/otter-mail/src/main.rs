//! Otter Mail, the native desktop app (GPUI).
//!
//! `otter-mail` opens the user's mail; `otter-mail --demo` opens the made-up
//! mailboxes in memory (no Google account, no network).

mod actions;
mod app;
mod body;
mod browser;
mod composer;
mod devenv;
mod label_picker;
mod layout;
mod message_list;
mod palette;
mod reader;
mod settings;
mod sidebar;
mod theme;
mod ui;
mod workspace;

use mail_core::Backend;

use crate::actions::*;
use crate::app::AppBackend;

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,naga=warn,wgpu=warn"),
    )
    .init();
    let demo = std::env::args().any(|a| a == "--demo");
    if cfg!(debug_assertions) {
        devenv::load_env_local();
    }
    let backend = if demo {
        Backend::demo()
    } else {
        let paths = mail_core::paths::Paths::resolve();
        log::info!("data in {}", paths.state_dir.display());
        Backend::open(paths)
    };

    let application = gpui_kit::application().with_assets(gpui_kit::assets::AllAssets);
    // Reopening from the Dock brings the window back.
    application.on_reopen(|cx| {
        if cx.has_global::<AppBackend>() && cx.windows().is_empty() {
            let _ = app::open_main_window(cx);
        }
    });
    application.run(move |cx| {
        gpui_kit::init(cx);
        let backend = match backend {
            Ok(backend) => backend,
            Err(err) => {
                log::error!("couldn't open the mail cache: {err:#}");
                if let Err(err) = app::show_startup_error(&err, cx) {
                    log::error!("couldn't show the startup error: {err:#}");
                    cx.quit();
                }
                return;
            }
        };
        if !demo && cfg!(debug_assertions) {
            devenv::add_demo_mailboxes(&backend);
        }
        backend.start();
        cx.set_global(AppBackend(backend));
        theme::init(cx);
        palette::init(cx);
        cx.bind_keys(actions::key_bindings());
        cx.bind_keys(composer::key_bindings());
        cx.set_menus(app::menus());
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.on_action(|_: &About, _cx| {
            let _ = open::that_detached("https://otterware.app/mail/");
        });
        cx.on_action(|_: &CloseWindow, cx| {
            palette::with_workspace(cx, |ws, window, cx| {
                if ws.browser_open && ws.browser.read(cx).contains_focus(window, cx) {
                    ws.browser
                        .update(cx, |browser, cx| browser.close_active_tab(window, cx));
                } else {
                    window.remove_window();
                }
            });
        });
        cx.on_action(|_: &Minimize, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.minimize_window());
            }
        });
        cx.on_action(|_: &Zoom, cx| {
            if let Some(window) = cx.active_window() {
                let _ = window.update(cx, |_, window, _| window.zoom_window());
            }
        });
        if let Err(err) = app::open_main_window(cx) {
            log::error!("couldn't open the window: {err:#}");
            cx.quit();
        }
        cx.activate(true);
    });
}
