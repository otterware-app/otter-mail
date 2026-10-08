//! Commands and their default keys (the Electron app's keybindings), and the
//! handlers the mail window runs them with.

use gpui_kit::*;
use mail_core::model::Scope;
use mail_core::model::*;

use crate::composer::ComposeMode;
use crate::workspace::Workspace;

actions!(
    otter,
    [
        NextMessage,
        PreviousMessage,
        ExtendDown,
        ExtendUp,
        CloseMessage,
        Archive,
        Trash,
        Junk,
        ToggleStar,
        MarkRead,
        MarkUnread,
        Reply,
        ReplyAll,
        Forward,
        Compose,
        Undo,
        Redo,
        ToggleSidebar,
        ToggleBrowser,
        NewBrowserTab,
        FocusBrowserAddress,
        CommandPalette,
        FocusSearch,
        GoInbox,
        GoSent,
        GoStarred,
        GoDrafts,
        GoAllMail,
        GoBack,
        GoForward,
        SyncNow,
        OpenSettings,
        LabelMessage,
        Mailbox1,
        Mailbox2,
        Mailbox3,
        Mailbox4,
        Mailbox5,
        Mailbox6,
        Mailbox7,
        Mailbox8,
        Mailbox9,
        Quit,
        CloseWindow,
        Minimize,
        Zoom,
        Hide,
        HideOthers,
        ShowAll,
        About,
    ]
);

const MAIL: &str = "Workspace";

pub fn key_bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("j", NextMessage, Some(MAIL)),
        KeyBinding::new("k", PreviousMessage, Some(MAIL)),
        KeyBinding::new("down", NextMessage, Some(MAIL)),
        KeyBinding::new("up", PreviousMessage, Some(MAIL)),
        KeyBinding::new("shift-down", ExtendDown, Some(MAIL)),
        KeyBinding::new("shift-up", ExtendUp, Some(MAIL)),
        KeyBinding::new("u", CloseMessage, Some(MAIL)),
        KeyBinding::new("escape", CloseMessage, Some(MAIL)),
        KeyBinding::new("escape", CloseMessage, Some("Settings && !Input")),
        KeyBinding::new("e", Archive, Some(MAIL)),
        KeyBinding::new("#", Trash, Some(MAIL)),
        KeyBinding::new("shift-3", Trash, Some(MAIL)),
        KeyBinding::new("backspace", Trash, Some(MAIL)),
        KeyBinding::new("delete", Trash, Some(MAIL)),
        KeyBinding::new("!", Junk, Some(MAIL)),
        KeyBinding::new("shift-1", Junk, Some(MAIL)),
        KeyBinding::new("s", ToggleStar, Some(MAIL)),
        KeyBinding::new("shift-i", MarkRead, Some(MAIL)),
        KeyBinding::new("shift-u", MarkUnread, Some(MAIL)),
        KeyBinding::new("r", Reply, Some(MAIL)),
        KeyBinding::new("a", ReplyAll, Some(MAIL)),
        KeyBinding::new("f", Forward, Some(MAIL)),
        KeyBinding::new("c", Compose, Some(MAIL)),
        KeyBinding::new("z", Undo, Some(MAIL)),
        KeyBinding::new("shift-z", Redo, Some(MAIL)),
        KeyBinding::new("l", LabelMessage, Some(MAIL)),
        KeyBinding::new("v", LabelMessage, Some(MAIL)),
        KeyBinding::new("/", FocusSearch, Some(MAIL)),
        KeyBinding::new("g i", GoInbox, Some(MAIL)),
        KeyBinding::new("g t", GoSent, Some(MAIL)),
        KeyBinding::new("g s", GoStarred, Some(MAIL)),
        KeyBinding::new("g d", GoDrafts, Some(MAIL)),
        KeyBinding::new("g a", GoAllMail, Some(MAIL)),
        KeyBinding::new("secondary-k", CommandPalette, None),
        KeyBinding::new("secondary-b", ToggleSidebar, Some(MAIL)),
        KeyBinding::new("secondary-shift-b", ToggleBrowser, None),
        KeyBinding::new("secondary-l", FocusBrowserAddress, None),
        KeyBinding::new("secondary-t", NewBrowserTab, Some("Browser")),
        KeyBinding::new("secondary-f", FocusSearch, Some(MAIL)),
        KeyBinding::new("secondary-z", Undo, Some(MAIL)),
        KeyBinding::new("secondary-shift-z", Redo, Some(MAIL)),
        KeyBinding::new("secondary-[", GoBack, Some(MAIL)),
        KeyBinding::new("secondary-]", GoForward, Some(MAIL)),
        KeyBinding::new("secondary-r", SyncNow, None),
        KeyBinding::new("secondary-,", OpenSettings, None),
        KeyBinding::new("secondary-1", Mailbox1, Some(MAIL)),
        KeyBinding::new("secondary-2", Mailbox2, Some(MAIL)),
        KeyBinding::new("secondary-3", Mailbox3, Some(MAIL)),
        KeyBinding::new("secondary-4", Mailbox4, Some(MAIL)),
        KeyBinding::new("secondary-5", Mailbox5, Some(MAIL)),
        KeyBinding::new("secondary-6", Mailbox6, Some(MAIL)),
        KeyBinding::new("secondary-7", Mailbox7, Some(MAIL)),
        KeyBinding::new("secondary-8", Mailbox8, Some(MAIL)),
        KeyBinding::new("secondary-9", Mailbox9, Some(MAIL)),
        KeyBinding::new("secondary-q", Quit, None),
        KeyBinding::new("secondary-w", CloseWindow, None),
        KeyBinding::new("secondary-m", Minimize, None),
        KeyBinding::new("secondary-h", Hide, None),
        KeyBinding::new("secondary-alt-h", HideOthers, None),
    ]
}

/// The toast after an action ("Archived", with Undo), when it gets one.
pub fn describe(action: &ThreadAction, n: usize) -> Option<String> {
    let what = |verb: &str| {
        if n == 1 {
            verb.to_string()
        } else {
            format!("{verb} {n} conversations")
        }
    };
    Some(match action {
        ThreadAction::Archive => what("Archived"),
        ThreadAction::Trash => what("Moved to Trash"),
        ThreadAction::Spam => what("Moved to Junk"),
        ThreadAction::NotSpam | ThreadAction::MoveToInbox => what("Moved to Inbox"),
        ThreadAction::Untrash => what("Restored"),
        ThreadAction::MoveToLabel(_) => what("Moved"),
        ThreadAction::DeleteForever => what("Deleted forever"),
        _ => return None,
    })
}

/// ⌘1… go to All mailboxes (when shown), then each mailbox in order.
fn jump(this: &mut Workspace, index: usize, window: &mut Window, cx: &mut Context<Workspace>) {
    let enabled: Vec<String> = this
        .accounts
        .iter()
        .filter(|a| a.enabled)
        .map(|a| a.id.clone())
        .collect();
    let mut spaces = Vec::new();
    if enabled.len() > 1 && this.backend.arrangement().combined {
        spaces.push(Scope::All);
    }
    spaces.extend(enabled.into_iter().map(Scope::Account));
    if let Some(scope) = spaces.get(index) {
        this.go(
            scope.clone(),
            Folder::System(SystemFolder::Inbox),
            window,
            cx,
        );
    }
}

/// Wires every command to the mail window's root.
pub fn bind(el: Stateful<Div>, cx: &mut Context<Workspace>) -> Stateful<Div> {
    macro_rules! on {
        ($el:expr, $action:ty, $body:expr) => {
            $el.on_action(
                cx.listener(move |this: &mut Workspace, _: &$action, window, cx| {
                    #[allow(clippy::redundant_closure_call)]
                    ($body)(this, window, cx)
                }),
            )
        };
    }
    type W<'a, 'b> = &'a mut Context<'b, Workspace>;
    let el = on!(el, NextMessage, |this: &mut Workspace, w, cx| this
        .move_selection(1, false, w, cx));
    let el = on!(el, PreviousMessage, |this: &mut Workspace, w, cx| this
        .move_selection(-1, false, w, cx));
    let el = on!(el, ExtendDown, |this: &mut Workspace, w, cx| this
        .move_selection(1, true, w, cx));
    let el = on!(el, ExtendUp, |this: &mut Workspace, w, cx| this
        .move_selection(-1, true, w, cx));
    let el =
        on!(el, CloseMessage, |this: &mut Workspace,
                               w: &mut Window,
                               cx: W| {
            if this.settings_view.is_some() {
                this.hide_settings(w, cx);
            } else if this.checked_count(cx) > 0 {
                this.clear_checked(cx);
            } else if this.open.is_some() {
                this.close_thread(cx);
            } else if matches!(this.folder, Folder::Search(_)) {
                this.go(
                    this.scope.clone(),
                    Folder::System(SystemFolder::Inbox),
                    w,
                    cx,
                );
            }
        });
    let el = on!(el, Archive, |this: &mut Workspace, w, cx| this
        .toggle_archive(w, cx));
    let el = on!(el, Trash, |this: &mut Workspace, w, cx| this.trash(w, cx));
    let el = on!(el, Junk, |this: &mut Workspace, w, cx| {
        let action = if matches!(this.folder, Folder::System(SystemFolder::Spam)) {
            ThreadAction::NotSpam
        } else {
            ThreadAction::Spam
        };
        this.act(action, w, cx)
    });
    let el = on!(el, ToggleStar, |this: &mut Workspace, w, cx| this
        .toggle_star(w, cx));
    let el = on!(el, MarkRead, |this: &mut Workspace, w, cx| this.act(
        ThreadAction::MarkRead,
        w,
        cx
    ));
    let el = on!(el, MarkUnread, |this: &mut Workspace, w, cx| this.act(
        ThreadAction::MarkUnread,
        w,
        cx
    ));
    let el = on!(el, Reply, |this: &mut Workspace, w, cx| this.compose(
        ComposeMode::Reply { all: false },
        w,
        cx
    ));
    let el = on!(el, ReplyAll, |this: &mut Workspace, w, cx| this.compose(
        ComposeMode::Reply { all: true },
        w,
        cx
    ));
    let el = on!(el, Forward, |this: &mut Workspace, w, cx| this.compose(
        ComposeMode::Forward,
        w,
        cx
    ));
    let el = on!(el, Compose, |this: &mut Workspace, w, cx| this.compose(
        ComposeMode::New {
            account_id: None,
            to: vec![]
        },
        w,
        cx
    ));
    let el = on!(el, Undo, |this: &mut Workspace, w, cx| this.undo(w, cx));
    let el = on!(el, Redo, |this: &mut Workspace, w, cx| this.redo(w, cx));
    let el = on!(el, ToggleBrowser, |this: &mut Workspace, w, cx| this
        .toggle_browser(w, cx));
    let el = on!(el, ToggleSidebar, |this: &mut Workspace, _w, cx| this
        .toggle_sidebar(cx));
    let el = on!(el, CommandPalette, |this: &mut Workspace, w, cx| this
        .open_palette(w, cx));
    let el = on!(el, FocusSearch, |this: &mut Workspace, w, cx| this
        .focus_search(w, cx));
    let el = on!(el, GoInbox, |this: &mut Workspace, w, cx| this.go(
        this.scope.clone(),
        Folder::System(SystemFolder::Inbox),
        w,
        cx
    ));
    let el = on!(el, GoSent, |this: &mut Workspace, w, cx| this.go(
        this.scope.clone(),
        Folder::System(SystemFolder::Sent),
        w,
        cx
    ));
    let el = on!(el, GoStarred, |this: &mut Workspace, w, cx| this.go(
        this.scope.clone(),
        Folder::System(SystemFolder::Starred),
        w,
        cx
    ));
    let el = on!(el, GoDrafts, |this: &mut Workspace, w, cx| this.go(
        this.scope.clone(),
        Folder::System(SystemFolder::Drafts),
        w,
        cx
    ));
    let el = on!(el, GoAllMail, |this: &mut Workspace, w, cx| this.go(
        this.scope.clone(),
        Folder::System(SystemFolder::All),
        w,
        cx
    ));
    let el = on!(el, GoBack, |this: &mut Workspace, w, cx| this
        .go_back(false, w, cx));
    let el = on!(el, GoForward, |this: &mut Workspace, w, cx| this
        .go_back(true, w, cx));
    let el = on!(el, SyncNow, |this: &mut Workspace, _w, _cx| this
        .backend
        .sync_all(true));
    let el = on!(el, LabelMessage, |this: &mut Workspace, w, cx| this
        .open_label_picker(w, cx));
    let el = on!(el, Mailbox1, |this: &mut Workspace, w, cx| jump(
        this, 0, w, cx
    ));
    let el = on!(el, Mailbox2, |this: &mut Workspace, w, cx| jump(
        this, 1, w, cx
    ));
    let el = on!(el, Mailbox3, |this: &mut Workspace, w, cx| jump(
        this, 2, w, cx
    ));
    let el = on!(el, Mailbox4, |this: &mut Workspace, w, cx| jump(
        this, 3, w, cx
    ));
    let el = on!(el, Mailbox5, |this: &mut Workspace, w, cx| jump(
        this, 4, w, cx
    ));
    let el = on!(el, Mailbox6, |this: &mut Workspace, w, cx| jump(
        this, 5, w, cx
    ));
    let el = on!(el, Mailbox7, |this: &mut Workspace, w, cx| jump(
        this, 6, w, cx
    ));
    let el = on!(el, Mailbox8, |this: &mut Workspace, w, cx| jump(
        this, 7, w, cx
    ));
    on!(el, Mailbox9, |this: &mut Workspace, w, cx| jump(
        this, 8, w, cx
    ))
}
