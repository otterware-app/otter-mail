//! Otter Mail's original palette, with the gpui-kit theme collection. As before, one theme is picked
//! for light mode and one for dark, and the app follows the system or a
//! fixed mode (`otter:theme-source`).

use gpui_kit::component::{Theme, ThemeConfig, ThemeMode, ThemeRegistry};
use gpui_kit::*;

const BUNDLED: &[&str] = &[
    include_str!("../themes/otter.json"),
    include_str!("../themes/adventure.json"),
    include_str!("../themes/alduin.json"),
    include_str!("../themes/asciinema.json"),
    include_str!("../themes/aurora.json"),
    include_str!("../themes/ayu.json"),
    include_str!("../themes/catppuccin.json"),
    include_str!("../themes/everforest.json"),
    include_str!("../themes/fahrenheit.json"),
    include_str!("../themes/flexoki.json"),
    include_str!("../themes/gruvbox.json"),
    include_str!("../themes/harper.json"),
    include_str!("../themes/hybrid.json"),
    include_str!("../themes/jellybeans.json"),
    include_str!("../themes/kibble.json"),
    include_str!("../themes/macos-classic.json"),
    include_str!("../themes/mellifluous.json"),
    include_str!("../themes/molokai.json"),
    include_str!("../themes/solarized.json"),
    include_str!("../themes/spaceduck.json"),
    include_str!("../themes/tokyonight.json"),
    include_str!("../themes/twilight.json"),
];

pub const LIGHT_KEY: &str = "otter:theme:light";
pub const DARK_KEY: &str = "otter:theme:dark";
pub const SOURCE_KEY: &str = "otter:theme-source";

pub fn init(cx: &mut App) {
    let registry = ThemeRegistry::global_mut(cx);
    for json in BUNDLED {
        if let Err(err) = registry.load_themes_from_str(json) {
            log::warn!("couldn't load a bundled theme: {err:#}");
        }
    }
}

/// Every theme for a mode, by name.
pub fn names(mode: ThemeMode, cx: &App) -> Vec<SharedString> {
    ThemeRegistry::global(cx)
        .sorted_themes()
        .into_iter()
        .filter(|t| t.mode == mode)
        .map(|t| t.name.clone())
        .collect()
}

fn config(name: Option<String>, mode: ThemeMode, cx: &App) -> std::rc::Rc<ThemeConfig> {
    let registry = ThemeRegistry::global(cx);
    let default = if mode.is_dark() {
        "Codex Dark"
    } else {
        "Codex Light"
    };
    let name = name
        .map(|n| match n.as_str() {
            "codex" | "Otter Light" | "Otter Dark" => {
                format!("Codex {}", if mode.is_dark() { "Dark" } else { "Light" })
            }
            "ocean" => format!("Ocean {}", if mode.is_dark() { "Dark" } else { "Light" }),
            _ => n,
        })
        .filter(|n| n != "Default Light" && n != "Default Dark")
        .unwrap_or_else(|| default.into());
    registry
        .themes()
        .get(&SharedString::from(name))
        .cloned()
        .filter(|t| t.mode == mode)
        .unwrap_or_else(|| match mode {
            ThemeMode::Dark => registry.default_dark_theme().clone(),
            _ => registry.default_light_theme().clone(),
        })
}

/// Paints the picked themes and the current mode on every window.
pub fn apply(window: Option<&mut Window>, cx: &mut App) {
    let backend = cx.global::<crate::app::AppBackend>().0.clone();
    let light = config(backend.ui_pref(LIGHT_KEY), ThemeMode::Light, cx);
    let dark = config(backend.ui_pref(DARK_KEY), ThemeMode::Dark, cx);
    Theme::update(cx, |theme| {
        theme.light_theme = light;
        theme.dark_theme = dark;
    });
    match backend.ui_pref(SOURCE_KEY).as_deref() {
        Some("light") => Theme::change(ThemeMode::Light, window, cx),
        Some("dark") => Theme::change(ThemeMode::Dark, window, cx),
        _ => Theme::sync_system_appearance(window, cx),
    }
    Theme::update(cx, |theme| {
        theme.font_size = px(16.);
        theme.radius = px(8.);
        theme.radius_lg = px(12.);
        theme.list.active_highlight = true;
    });
    cx.refresh_windows();
}
