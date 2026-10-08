//! A message's body, rendered natively (selectable text, links, images,
//! lists, quotes, simple tables), its quoted history folded behind "•••".

use gpui_kit::component::text::TextView;
use gpui_kit::prelude::*;
use gpui_kit::*;
use mail_core::model::Message;

use crate::ui::icon;
use crate::workspace::Workspace;
use gpui_kit::component::ActiveTheme as _;

/// Where a reply's quoted history starts in HTML (Gmail, Apple Mail, Outlook…).
const HTML_QUOTE_MARKERS: &[&str] = &[
    "<div class=\"gmail_quote",
    "<div class=gmail_quote",
    "<blockquote type=\"cite\"",
    "<div class=\"yahoo_quoted",
    "<div id=\"appendonsend\"",
    "<div id=\"divRplyFwdMsg\"",
    "<div class=\"moz-cite-prefix\"",
];

pub fn split_html_quote(html: &str) -> (String, Option<String>) {
    let lower = html.to_ascii_lowercase();
    let cut = HTML_QUOTE_MARKERS
        .iter()
        .filter_map(|m| lower.find(&m.to_ascii_lowercase()))
        .min();
    match cut {
        Some(at) => {
            let visible = &html[..at];
            // Keep it when hiding the quote would leave next to nothing.
            if mail_core::text::snippet(visible, 100).trim().len() < 20 {
                return (html.to_string(), None);
            }
            (visible.to_string(), Some(html[at..].to_string()))
        }
        None => (html.to_string(), None),
    }
}

pub fn split_text_quote(text: &str) -> (String, Option<String>) {
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate().skip(1) {
        let l = line.trim();
        let wrote = l.starts_with("On ") && l.ends_with("wrote:");
        let original = l
            .trim_matches('-')
            .trim()
            .eq_ignore_ascii_case("Original Message");
        let quoted_tail = l.starts_with('>')
            && lines[i..]
                .iter()
                .all(|x| x.trim().is_empty() || x.trim_start().starts_with('>'));
        if wrote || original || quoted_tail {
            let visible = lines[..i].join("\n");
            if visible.trim().len() < 20 {
                return (text.to_string(), None);
            }
            return (visible, Some(lines[i..].join("\n")));
        }
    }
    (text.to_string(), None)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Plain text as simple HTML: paragraphs, line breaks, links.
pub fn text_to_html(text: &str) -> String {
    let mut out = String::new();
    for para in text.split("\n\n") {
        let mut lines = Vec::new();
        for line in para.lines() {
            let mut l = String::new();
            for word in line.split(' ') {
                if !l.is_empty() {
                    l.push(' ');
                }
                if word.starts_with("http://") || word.starts_with("https://") {
                    let url = word.trim_end_matches(['.', ',', ')', ';']);
                    let rest = &word[url.len()..];
                    l.push_str(&format!(
                        "<a href=\"{}\">{}</a>{}",
                        escape(url),
                        escape(url),
                        escape(rest)
                    ));
                } else {
                    l.push_str(&escape(word));
                }
            }
            lines.push(l);
        }
        out.push_str("<p>");
        out.push_str(&lines.join("<br>"));
        out.push_str("</p>");
    }
    out
}

impl Workspace {
    pub fn message_body(
        &mut self,
        m: &Message,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = cx.theme().clone();
        let show_quote = self.open.as_ref().is_some_and(|o| o.quotes.contains(&m.id));
        if !m.has_body() {
            return div()
                .text_size(rems(0.875))
                .text_color(p.muted_foreground)
                .child(m.snippet.clone())
                .into_any_element();
        }
        let (html, quote) = match (&m.body_html, &m.body_text) {
            (Some(html), _) if !html.trim().is_empty() => {
                let (visible, quote) = split_html_quote(html);
                (visible, quote)
            }
            (_, Some(text)) => {
                let (visible, quote) = split_text_quote(text);
                (text_to_html(&visible), quote.map(|q| text_to_html(&q)))
            }
            _ => (String::new(), None),
        };
        let html = if show_quote {
            match &quote {
                Some(q) => format!("{html}{q}"),
                None => html,
            }
        } else {
            html
        };
        let id = m.id.clone();
        div()
            .flex()
            .flex_col()
            .text_sm()
            .child(
                TextView::html(SharedString::from(format!("body-{}", m.id)), html)
                    .selectable(true)
                    .on_link_click({
                        let workspace = cx.entity().downgrade();
                        move |url, _, window, cx| {
                            if let Some(ws) = workspace.upgrade() {
                                ws.update(cx, |ws, cx| ws.open_link(url.as_ref(), window, cx));
                            }
                        }
                    }),
            )
            .when(quote.is_some() && !show_quote, |el| {
                el.child(
                    div().mt_2().child(
                        div()
                            .id(SharedString::from(format!("quote-{id}")))
                            .h_5()
                            .px_2()
                            .w(px(36.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .bg(p.accent)
                            .text_color(p.muted_foreground)
                            .cursor_pointer()
                            .hover(|s| s.text_color(p.foreground))
                            .child(icon("ellipsis").size(px(16.)))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if let Some(open) = &mut this.open {
                                    open.quotes.insert(id.clone());
                                }
                                cx.notify();
                            })),
                    ),
                )
            })
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{split_html_quote, split_text_quote};

    #[test]
    fn quotes() {
        let (v, q) =
            split_text_quote("Thanks, that works for me and the team.\n\nOn Mon, Ada wrote:\n> hi");
        assert!(v.starts_with("Thanks"));
        assert!(q.unwrap().starts_with("On Mon"));
        let (v, q) = split_html_quote(
            "<p>Sounds great, see you on Saturday then!</p><div class=\"gmail_quote\">old</div>",
        );
        assert_eq!(v, "<p>Sounds great, see you on Saturday then!</p>");
        assert!(q.is_some());
    }
}
