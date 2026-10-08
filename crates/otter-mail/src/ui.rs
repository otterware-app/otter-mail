//! Small helpers every pane uses: Lucide icons by name, toolbar buttons,
//! avatars, label tags, dates.

use chrono::{DateTime, Datelike, Local, TimeZone};
use gpui_kit::component::avatar::Avatar;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{Icon, Sizable as _};
use gpui_kit::*;

/// A Lucide icon from the bundled catalog (`icons/<name>.svg`).
pub fn icon(name: &str) -> Icon {
    Icon::empty().path(SharedString::from(format!("icons/{name}.svg")))
}

/// A toolbar's ghost icon button with a tooltip (and its shortcut).
pub fn tool_button(
    id: impl Into<ElementId>,
    icon_name: &str,
    tooltip: &str,
    shortcut: Option<&str>,
) -> Button {
    let tip = match shortcut {
        Some(keys) => format!("{tooltip}  {}", shortcut_text(keys)),
        None => tooltip.to_string(),
    };
    Button::new(id)
        .ghost()
        .small()
        .w(px(28.))
        .h(px(28.))
        .p_0()
        .icon(icon(icon_name).size(px(16.)))
        .accessibility_label(tooltip)
        .tooltip(tip)
}

/// "⌘K", "⇧⌘B" on the Mac; "Ctrl+K" elsewhere. Strokes are GPUI's
/// (`cmd-k`, `shift-cmd-b`, `g i`).
pub fn shortcut_text(keys: &str) -> String {
    let mac = cfg!(target_os = "macos");
    keys.split(' ')
        .map(|stroke| {
            let parts: Vec<&str> = stroke.split('-').collect();
            let key = parts.last().copied().unwrap_or_default();
            let mods = &parts[..parts.len().saturating_sub(1)];
            let has = |m: &str| mods.contains(&m);
            let mut out = String::new();
            if mac {
                for (m, s) in [("ctrl", "⌃"), ("alt", "⌥"), ("shift", "⇧")] {
                    if has(m) {
                        out.push_str(s);
                    }
                }
                if has("cmd") || has("secondary") {
                    out.push('⌘');
                }
            } else {
                if has("ctrl") || has("cmd") || has("secondary") {
                    out.push_str("Ctrl+");
                }
                if has("alt") {
                    out.push_str("Alt+");
                }
                if has("shift") {
                    out.push_str("Shift+");
                }
            }
            out.push_str(&match key {
                "enter" => "↩".to_string(),
                "escape" => "Esc".to_string(),
                "backspace" => "⌫".to_string(),
                "up" => "↑".to_string(),
                "down" => "↓".to_string(),
                k if k.chars().count() == 1 => k.to_uppercase(),
                k => k.to_string(),
            });
            out
        })
        .collect::<Vec<_>>()
        .join(" then ")
}

/// A person's avatar: their initials (the component's colors).
pub fn person_avatar(name: &str, email: &str) -> Avatar {
    let name = if name.trim().is_empty() { email } else { name };
    Avatar::new().name(name.to_string())
}

/// A mailbox's avatar: its Google picture, or its name's initials.
pub fn account_avatar(account: &mail_core::model::Account) -> Avatar {
    let avatar = Avatar::new().name(account.title().to_string());
    match account.picture.as_deref().filter(|p| p.starts_with("http")) {
        Some(url) => avatar.src(SharedString::from(url.to_string())),
        None => avatar,
    }
}

/// A label as a tag: in its Gmail color when it has one.
pub fn label_tag(name: &str, background: Option<&str>, cx: &App) -> Tag {
    use gpui_kit::component::ActiveTheme as _;
    let theme = cx.theme();
    let tag = match background.and_then(parse_hex) {
        Some(color) => {
            let amount = if theme.is_dark() { 0.45 } else { 0.3 };
            let a = color.to_rgb();
            let b = theme.foreground.to_rgb();
            let fg: Hsla = Rgba {
                r: a.r * amount + b.r * (1. - amount),
                g: a.g * amount + b.g * (1. - amount),
                b: a.b * amount + b.b * (1. - amount),
                a: 1.,
            }
            .into();
            Tag::custom(
                color.opacity(if theme.is_dark() { 0.12 } else { 0.08 }),
                fg,
                color.opacity(0.),
            )
        }
        None => Tag::custom(
            theme.background.opacity(0.),
            theme.muted_foreground,
            theme.border.opacity(0.6),
        ),
    };
    tag.xsmall()
        .rounded_full()
        .h(px(20.))
        .max_w(px(128.))
        .text_size(px(11.))
        .child(div().truncate().child(name.to_string()))
}

pub fn parse_hex(value: &str) -> Option<Hsla> {
    let hex = value.trim().trim_start_matches('#');
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
    let (r, g, b) = match hex.len() {
        6 | 8 => (channel(0)?, channel(2)?, channel(4)?),
        _ => return None,
    };
    Some(
        Rgba {
            r: r as f32 / 255.,
            g: g as f32 / 255.,
            b: b as f32 / 255.,
            a: 1.,
        }
        .into(),
    )
}

pub fn local(ms: i64) -> DateTime<Local> {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .unwrap_or_else(Local::now)
}

/// The list's date: a time today, "Yesterday", a weekday this week, "Mar 5".
pub fn list_date(ms: i64) -> String {
    let date = local(ms);
    let days = (Local::now().timestamp_millis() - ms).div_euclid(86_400_000);
    match days {
        ..=0 => date.format("%-I:%M %p").to_string(),
        1 => "Yesterday".into(),
        2..=6 => date.format("%a").to_string(),
        _ => date.format("%b %-d").to_string(),
    }
}

/// Day groups in the list: "Today", "Yesterday", "Mon, Mar 5" (with the
/// year when it isn't this year).
pub fn day_label(ms: i64) -> String {
    let now = Local::now().date_naive();
    let day = local(ms).date_naive();
    if day == now {
        "Today".into()
    } else if Some(day) == now.pred_opt() {
        "Yesterday".into()
    } else if day.year() == now.year() {
        day.format("%a, %b %-d").to_string()
    } else {
        day.format("%a, %b %-d, %Y").to_string()
    }
}

/// A message's date in the reader: a time today, else the date and time.
pub fn message_date(ms: i64) -> String {
    let date = local(ms);
    if date.date_naive() == Local::now().date_naive() {
        date.format("%-I:%M %p").to_string()
    } else if date.year() == Local::now().year() {
        date.format("%a, %b %-d, %-I:%M %p").to_string()
    } else {
        date.format("%b %-d, %Y, %-I:%M %p").to_string()
    }
}

pub fn full_date(ms: i64) -> String {
    local(ms).format("%a, %b %-d, %Y, %-I:%M %p").to_string()
}

pub fn file_size(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024. * 1024.))
    }
}

/// The desktop workspace dimensions, shared with the original renderer.
pub const TITLE_HEIGHT: f32 = 42.;
pub const RAIL_WIDTH: f32 = 52.;
pub const SIDEBAR_WIDTH: f32 = 200.;
pub const LIST_WIDTH: f32 = 340.;

/// The sidebar inside the floating canvas is between the canvas and frame.
pub fn sidebar_surface(cx: &App) -> Hsla {
    use gpui_kit::component::ActiveTheme as _;
    let a = cx.theme().background.to_rgb();
    let b = cx.theme().sidebar.to_rgb();
    Rgba {
        r: a.r * 0.5 + b.r * 0.5,
        g: a.g * 0.5 + b.g * 0.5,
        b: a.b * 0.5 + b.b * 0.5,
        a: 1.,
    }
    .into()
}
