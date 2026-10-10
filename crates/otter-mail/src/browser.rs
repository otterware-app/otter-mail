//! The right-side browser. Each tab owns a native WebKit view; the tab strip
//! and address bar are GPUI, styled like the original desktop panel.

use futures::{StreamExt as _, channel::mpsc};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use gpui_wry::WebView;
use raw_window_handle::HasWindowHandle as _;

use crate::ui::{TITLE_HEIGHT, icon, tool_button};

pub const SUPPORTED: bool = cfg!(target_os = "macos");

struct Tab {
    id: usize,
    title: String,
    url: String,
    loading: bool,
    view: Option<Entity<WebView>>,
    error: Option<String>,
}

enum Event {
    Loading(usize, bool, String),
    Title(usize, String),
    Open(String),
}

pub struct BrowserPanel {
    tabs: Vec<Tab>,
    active: usize,
    next_id: usize,
    address: Entity<InputState>,
    address_focused: bool,
    focus: FocusHandle,
    visible: bool,
    events: mpsc::UnboundedSender<Event>,
    context: wry::WebContext,
    _subscription: Subscription,
    _task: Task<()>,
}

/// Match the original address bar: URLs, bare host names, or a Google search.
pub fn address_to_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if !value.starts_with("localhost:") {
        if let Ok(url) = url::Url::parse(value) {
            return matches!(url.scheme(), "http" | "https").then(|| url.to_string());
        }
    }
    if !value.contains(char::is_whitespace)
        && (value.contains('.') || value.starts_with("localhost"))
    {
        let scheme = if value.starts_with("localhost") || value.starts_with("127.0.0.1") {
            "http"
        } else {
            "https"
        };
        return url::Url::parse(&format!("{scheme}://{value}"))
            .ok()
            .map(|url| url.to_string());
    }
    let mut url = url::Url::parse("https://www.google.com/search").ok()?;
    url.query_pairs_mut().append_pair("q", value);
    Some(url.to_string())
}

fn host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "New tab".into())
}

impl BrowserPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let address = cx.new(|cx| InputState::new(window, cx).placeholder("Search or enter a URL"));
        let subscription =
            cx.subscribe_in(
                &address,
                window,
                |this, input, event, window, cx| match event {
                    InputEvent::PressEnter { .. } => {
                        let value = input.read(cx).value().to_string();
                        if let Some(url) = address_to_url(&value) {
                            this.navigate(url, window, cx);
                            this.focus.focus(window, cx);
                        }
                    }
                    InputEvent::Focus => {
                        this.address_focused = true;
                        cx.notify();
                    }
                    InputEvent::Blur => {
                        this.address_focused = false;
                        cx.notify();
                    }
                    _ => {}
                },
            );
        let (events, mut rx) = mpsc::unbounded();
        let task = cx.spawn_in(window, async move |this, cx| {
            while let Some(event) = rx.next().await {
                if this
                    .update_in(cx, |this, window, cx| this.on_event(event, window, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let backend = &cx.global::<crate::app::AppBackend>().0;
        let directory = backend.paths().state_dir.join("browser");
        Self {
            tabs: vec![Tab {
                id: 0,
                title: "New tab".into(),
                url: String::new(),
                loading: false,
                view: None,
                error: None,
            }],
            active: 0,
            next_id: 1,
            address,
            address_focused: false,
            focus: cx.focus_handle(),
            visible: false,
            events,
            context: wry::WebContext::new(Some(directory)),
            _subscription: subscription,
            _task: task,
        }
    }

    fn on_event(&mut self, event: Event, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            Event::Open(url) if url.starts_with("mailto:") => {
                crate::palette::with_workspace(cx, move |ws, window, cx| {
                    ws.open_link(&url, window, cx)
                });
            }
            Event::Open(url) => self.open(url, window, cx),
            Event::Title(id, title) => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == id) {
                    tab.title = title;
                }
            }
            Event::Loading(id, loading, url) => {
                if let Some(tab) = self.tabs.iter_mut().find(|t| t.id == id) {
                    tab.loading = loading;
                    tab.url = url.clone();
                }
                if self.tabs[self.active].id == id && !self.address_focused {
                    self.address
                        .update(cx, |s, cx| s.set_value(url, window, cx));
                }
            }
        }
        cx.notify();
    }

    pub fn set_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.visible == visible {
            return;
        }
        self.visible = visible;
        self.sync_visibility(cx);
        cx.notify();
    }

    fn sync_visibility(&mut self, cx: &mut Context<Self>) {
        for (ix, tab) in self.tabs.iter().enumerate() {
            if let Some(view) = &tab.view {
                let visible = self.visible && ix == self.active;
                view.update(cx, |view, cx| {
                    if visible != view.visible() {
                        if visible {
                            view.show();
                        } else {
                            view.hide();
                        }
                        cx.notify();
                    }
                });
            }
        }
    }

    pub fn new_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.tabs.push(Tab {
            id: self.next_id,
            title: "New tab".into(),
            url: String::new(),
            loading: false,
            view: None,
            error: None,
        });
        self.next_id += 1;
        self.select(self.tabs.len() - 1, window, cx);
        self.focus_address(window, cx);
    }

    pub fn focus_address(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.address.update(cx, |s, cx| s.focus(window, cx));
        window.dispatch_action(Box::new(gpui_kit::component::input::SelectAll), cx);
    }

    pub fn open(&mut self, url: String, window: &mut Window, cx: &mut Context<Self>) {
        if !self.tabs[self.active].url.is_empty() {
            self.new_tab(window, cx);
        }
        self.navigate(url, window, cx);
    }

    fn select(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        self.active = ix;
        let url = self.tabs[ix].url.clone();
        self.address
            .update(cx, |s, cx| s.set_value(url, window, cx));
        self.sync_visibility(cx);
        self.focus.focus(window, cx);
        cx.notify();
    }

    pub fn close_tab(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(view) = &self.tabs[ix].view {
            view.update(cx, |view, _| view.hide());
        }
        self.tabs.remove(ix);
        if self.tabs.is_empty() {
            self.new_tab(window, cx);
        } else {
            let active = if ix < self.active {
                self.active - 1
            } else {
                self.active.min(self.tabs.len() - 1)
            };
            self.select(active, window, cx);
        }
    }

    pub fn navigate(&mut self, url: String, window: &mut Window, cx: &mut Context<Self>) {
        let tab = &mut self.tabs[self.active];
        tab.url = url.clone();
        tab.title = host(&url);
        tab.error = None;
        tab.loading = true;
        self.address
            .update(cx, |s, cx| s.set_value(url.clone(), window, cx));
        let result = if let Some(view) = &tab.view {
            view.read(cx)
                .raw()
                .load_url(&url)
                .map_err(anyhow::Error::from)
        } else {
            let id = tab.id;
            let loading = self.events.clone();
            let title = self.events.clone();
            let popup = self.events.clone();
            let external = self.events.clone();
            (|| -> anyhow::Result<()> {
                let handle = window.window_handle()?;
                let native = wry::WebViewBuilder::new_with_web_context(&mut self.context)
                    .with_url(&url)
                    .with_user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")
                    .with_visible(false)
                    .with_incognito(cx.global::<crate::app::AppBackend>().0.is_demo())
                    .with_on_page_load_handler(move |phase, url| {
                        let _ = loading.unbounded_send(Event::Loading(id, matches!(phase, wry::PageLoadEvent::Started), url));
                    })
                    .with_document_title_changed_handler(move |value| {
                        let _ = title.unbounded_send(Event::Title(id, value));
                    })
                    .with_new_window_req_handler(move |url, _| {
                        if address_to_url(&url).is_some() { let _ = popup.unbounded_send(Event::Open(url)); }
                        wry::NewWindowResponse::Deny
                    })
                    .with_navigation_handler(move |url| {
                        let scheme = url::Url::parse(&url).ok().map(|u| u.scheme().to_string());
                        match scheme.as_deref() {
                            Some("http" | "https" | "about") => true,
                            Some("mailto") => {
                                let _ = external.unbounded_send(Event::Open(url));
                                false
                            }
                            _ => false,
                        }
                    })
                    .build_as_child(&handle)?;
                tab.view = Some(cx.new(|cx| {
                    let mut view = WebView::new(native, window, cx);
                    view.hide();
                    view
                }));
                Ok(())
            })()
        };
        if let Err(error) = result {
            tab.loading = false;
            tab.error = Some(format!("Couldn't open this page: {error}"));
        }
        self.sync_visibility(cx);
        cx.notify();
    }

    fn history(&self, forward: bool, cx: &App) {
        if let Some(view) = &self.tabs[self.active].view {
            let script = if forward {
                "history.forward()"
            } else {
                "history.back()"
            };
            let _ = view.read(cx).raw().evaluate_script(script);
        }
    }

    pub fn active_url(&self) -> &str {
        &self.tabs[self.active].url
    }

    pub fn contains_focus(&self, window: &Window, cx: &App) -> bool {
        self.focus.contains_focused(window, cx)
    }

    pub fn close_active_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_tab(self.active, window, cx);
    }

    pub fn describe(&self, cx: &App) -> String {
        let tab = &self.tabs[self.active];
        format!(
            "{} tabs; {} — {}; bounds {:?}; visible {}",
            self.tabs.len(),
            tab.title,
            tab.url,
            tab.view.as_ref().map(|v| v.read(cx).bounds()),
            self.visible
        )
    }
}

impl BrowserPanel {
    pub fn render_tabs(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let tabs = self
            .tabs
            .iter()
            .enumerate()
            .map(|(ix, tab)| {
                h_flex()
                    .id(("browser-tab", tab.id))
                    .h(px(30.))
                    .max_w(px(180.))
                    .min_w(px(72.))
                    .px_2()
                    .gap_2()
                    .rounded(px(8.))
                    .text_size(px(12.))
                    .cursor_pointer()
                    .when(ix == self.active, |el| {
                        el.bg(theme.foreground.opacity(0.08))
                    })
                    .text_color(if ix == self.active {
                        theme.foreground
                    } else {
                        theme.muted_foreground
                    })
                    .child(
                        div()
                            .size(px(14.))
                            .flex_none()
                            .when(tab.loading, |el| {
                                el.child(
                                    gpui_kit::component::spinner::Spinner::new().with_size(px(14.)),
                                )
                            })
                            .when(!tab.loading, |el| el.child(icon("globe").size(px(14.)))),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(tab.title.clone()))
                    .child(
                        tool_button(("close-browser-tab", tab.id), "x", "Close tab", None)
                            .xsmall()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                cx.stop_propagation();
                                this.close_tab(ix, window, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, window, cx| this.select(ix, window, cx)))
            })
            .collect::<Vec<_>>();
        h_flex()
            .occlude()
            .h(px(TITLE_HEIGHT))
            .w_full()
            .min_w_0()
            .flex_none()
            .px_2()
            .gap_1()
            .overflow_hidden()
            .children(tabs)
            .child(
                tool_button("new-browser-tab", "plus", "New tab", Some("cmd-t"))
                    .on_click(cx.listener(|this, _, window, cx| this.new_tab(window, cx))),
            )
            .into_any_element()
    }
}

impl Render for BrowserPanel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let has_page = self.tabs[self.active].view.is_some();
        let address = if self.address_focused || !has_page {
            div()
                .flex_1()
                .min_w_0()
                .child(
                    Input::new(&self.address)
                        .small()
                        .rounded_full()
                        .appearance(false)
                        .bg(theme.foreground.opacity(0.06)),
                )
                .into_any_element()
        } else {
            div()
                .id("browser-address-display")
                .flex_1()
                .min_w_0()
                .h(px(30.))
                .rounded_full()
                .bg(theme.foreground.opacity(0.06))
                .cursor_text()
                .flex()
                .items_center()
                .justify_center()
                .px_3()
                .child(
                    div()
                        .truncate()
                        .text_size(px(13.))
                        .child(host(self.active_url())),
                )
                .on_click(cx.listener(|this, _, w, cx| this.focus_address(w, cx)))
                .into_any_element()
        };
        v_flex()
            .id("browser-panel")
            .key_context("Browser")
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .child(
                v_flex()
                    .flex_1()
                    .min_h_0()
                    .rounded_tl(px(12.))
                    .overflow_hidden()
                    .bg(theme.background)
                    .child(
                        h_flex()
                            .h(px(46.))
                            .flex_none()
                            .px_2()
                            .gap_1()
                            .child(
                                h_flex()
                                    .h(px(30.))
                                    .rounded_full()
                                    .bg(theme.foreground.opacity(0.06))
                                    .px_1()
                                    .child(
                                        tool_button("browser-back", "arrow-left", "Back", None)
                                            .disabled(!has_page)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.history(false, cx)
                                            })),
                                    )
                                    .child(
                                        tool_button(
                                            "browser-forward",
                                            "arrow-right",
                                            "Forward",
                                            None,
                                        )
                                        .disabled(!has_page)
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.history(true, cx)),
                                        ),
                                    )
                                    .child(
                                        tool_button("browser-reload", "rotate-cw", "Reload", None)
                                            .disabled(!has_page)
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                if let Some(v) = &this.tabs[this.active].view {
                                                    let _ = v.read(cx).raw().reload();
                                                }
                                            })),
                                    ),
                            )
                            .child(address)
                            .child(
                                tool_button(
                                    "browser-external",
                                    "arrow-up-right",
                                    "Open in default browser",
                                    None,
                                )
                                .disabled(!has_page)
                                .on_click(cx.listener(
                                    |this, _, _, _| {
                                        let _ = open::that_detached(this.active_url());
                                    },
                                )),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .when_some(self.tabs[self.active].view.clone(), |el, view| {
                                el.child(view)
                            })
                            .when(!has_page, |el| {
                                el.child(
                                    v_flex()
                                        .size_full()
                                        .items_center()
                                        .justify_center()
                                        .gap_4()
                                        .child(
                                            icon("globe")
                                                .size(px(40.))
                                                .text_color(theme.muted_foreground),
                                        )
                                        .child(div().text_size(px(20.)).child("New tab"))
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .text_color(theme.muted_foreground)
                                                .child("Search or enter a URL above."),
                                        )
                                        .children(
                                            [
                                                ("Google", "https://www.google.com/"),
                                                ("YouTube", "https://www.youtube.com/"),
                                                ("Otter Drive", "https://drive.otterware.app/"),
                                            ]
                                            .into_iter()
                                            .map(
                                                |(title, url)| {
                                                    gpui_kit::component::button::Button::new(title)
                                                        .small()
                                                        .label(title)
                                                        .on_click(cx.listener(
                                                            move |this, _, window, cx| {
                                                                this.navigate(
                                                                    url.into(),
                                                                    window,
                                                                    cx,
                                                                )
                                                            },
                                                        ))
                                                },
                                            ),
                                        ),
                                )
                            }),
                    )
                    .when_some(self.tabs[self.active].error.clone(), |el, error| {
                        el.child(div().p_4().text_color(theme.danger).child(error))
                    }),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::address_to_url;

    #[test]
    fn addresses_and_searches() {
        assert_eq!(
            address_to_url("example.com").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(
            address_to_url("localhost:8080").as_deref(),
            Some("http://localhost:8080/")
        );
        assert_eq!(
            address_to_url("sea otters & kelp").as_deref(),
            Some("https://www.google.com/search?q=sea+otters+%26+kelp")
        );
        assert!(address_to_url("javascript:alert(1)").is_none());
        assert!(address_to_url("file:///etc/passwd").is_none());
        assert!(address_to_url(" ").is_none());
    }
}
