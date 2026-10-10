//! App-wide state: the backend, the main window, the menus.

use gpui_kit::component::{Root, TitleBar};
use gpui_kit::*;
use mail_core::Backend;

use crate::actions::*;
use crate::workspace::Workspace;

pub struct AppBackend(pub Backend);

impl Global for AppBackend {}

pub fn menus() -> Vec<Menu> {
    let mut menus = vec![
        Menu {
            name: "Otter Mail".into(),
            items: vec![
                MenuItem::action("About Otter Mail", About),
                MenuItem::separator(),
                MenuItem::action("Settings…", OpenSettings),
                MenuItem::separator(),
                MenuItem::action("Hide Otter Mail", Hide),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::action("Show All", ShowAll),
                MenuItem::separator(),
                MenuItem::action("Quit Otter Mail", Quit),
            ],
            disabled: false,
        },
        Menu {
            name: "File".into(),
            items: vec![
                MenuItem::action("New Message", Compose),
                MenuItem::action("Sync Now", SyncNow),
                MenuItem::separator(),
                MenuItem::action("Close Window", CloseWindow),
            ],
            disabled: false,
        },
        Menu {
            name: "Edit".into(),
            items: vec![
                MenuItem::os_action("Undo", gpui_kit::component::input::Undo, OsAction::Undo),
                MenuItem::os_action("Redo", gpui_kit::component::input::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Cut", gpui_kit::component::input::Cut, OsAction::Cut),
                MenuItem::os_action("Copy", gpui_kit::component::input::Copy, OsAction::Copy),
                MenuItem::os_action("Paste", gpui_kit::component::input::Paste, OsAction::Paste),
                MenuItem::os_action(
                    "Select All",
                    gpui_kit::component::input::SelectAll,
                    OsAction::SelectAll,
                ),
            ],
            disabled: false,
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Command Palette", CommandPalette),
                MenuItem::action("Toggle Sidebar", ToggleSidebar),
                MenuItem::separator(),
                MenuItem::action("Back", GoBack),
                MenuItem::action("Forward", GoForward),
            ],
            disabled: false,
        },
        Menu {
            name: "Message".into(),
            items: vec![
                MenuItem::action("Reply", Reply),
                MenuItem::action("Reply All", ReplyAll),
                MenuItem::action("Forward", Forward),
                MenuItem::separator(),
                MenuItem::action("Archive", Archive),
                MenuItem::action("Move to Trash", Trash),
                MenuItem::action("Flag", ToggleStar),
                MenuItem::action("Mark as Read", MarkRead),
                MenuItem::action("Mark as Unread", MarkUnread),
            ],
            disabled: false,
        },
        Menu {
            name: "Window".into(),
            items: vec![
                MenuItem::action("Minimize", Minimize),
                MenuItem::action("Zoom", Zoom),
            ],
            disabled: false,
        },
    ];
    if crate::browser::SUPPORTED {
        menus[3]
            .items
            .insert(2, MenuItem::action("Toggle Browser", ToggleBrowser));
    }
    menus
}

pub fn open_main_window(cx: &mut App) -> anyhow::Result<()> {
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1600.), px(1000.)),
            cx,
        ))),
        window_min_size: Some(size(px(1000.), px(600.))),
        titlebar: Some(TitlebarOptions {
            title: None,
            appears_transparent: true,
            traffic_light_position: Some(point(px(14.), px(14.))),
        }),
        app_id: Some("dev.otterware.mail.gpui".into()),
        ..TitleBar::window_options()
    };
    let (handle, workspace) = gpui_kit::open_window(options, cx, |window, cx| {
        window.set_window_title("Otter Mail GPUI — Native preview");
        crate::theme::apply(Some(window), cx);
        window
            .observe_window_appearance(|window, cx| crate::theme::apply(Some(window), cx))
            .detach();
        let workspace = cx.new(|cx| Workspace::new(window, cx));
        if cfg!(debug_assertions) {
            crate::devenv::watch_commands(workspace.downgrade(), window, cx);
        }
        workspace
    })?;
    cx.set_global(crate::palette::MailWindow {
        workspace: workspace.downgrade(),
        window: handle,
    });
    let _ = handle.downcast::<Root>();
    Ok(())
}

pub fn show_startup_error(error: &anyhow::Error, cx: &mut App) -> anyhow::Result<()> {
    struct PromptHost;
    impl Render for PromptHost {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full()
        }
    }
    gpui_kit::open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                None,
                size(px(480.), px(240.)),
                cx,
            ))),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("Otter Mail GPUI — Native preview");
            let answer = window.prompt(
                PromptLevel::Critical,
                "Could not open Otter Mail",
                Some(&format!(
                    "Your saved credential files have been kept.\n\n{error:#}"
                )),
                &["Quit"],
                cx,
            );
            cx.spawn(async move |cx| {
                let _ = answer.await;
                let _ = cx.update(|cx| cx.quit());
            })
            .detach();
            cx.new(|_| PromptHost)
        },
    )?;
    cx.activate(true);
    Ok(())
}
