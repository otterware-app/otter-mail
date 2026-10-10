/** Export the original app palettes, including their softened surfaces, to GPUI. */
import { writeFileSync } from "node:fs";

import { APP_THEMES, type ThemeColorRole } from "../packages/shared/src/theme-palettes.ts";
import { displayedThemeColors } from "../packages/shared/src/theme-display.ts";

const roles: Record<string, ThemeColorRole> = {
  background: "canvas",
  foreground: "text",
  border: "border",
  input: "input",
  ring: "focus",
  "accent.background": "accentSurface",
  "accent.foreground": "accentSurfaceForeground",
  "primary.background": "accent",
  "primary.foreground": "accentForeground",
  "primary.hover.background": "accent",
  "secondary.background": "secondary",
  "secondary.foreground": "secondaryForeground",
  "secondary.hover.background": "sidebarRowHover",
  "secondary.active.background": "sidebarRowActive",
  "muted.background": "muted",
  "muted.foreground": "textMuted",
  "popover.background": "surfaceOverlay",
  "popover.foreground": "text",
  "sidebar.background": "sidebar",
  "sidebar.foreground": "sidebarForeground",
  "sidebar.accent.background": "sidebarRowActive",
  "sidebar.accent.foreground": "sidebarForeground",
  "sidebar.border": "sidebarBorder",
  "title_bar.background": "sidebar",
  "title_bar.border": "sidebar",
  "tab_bar.background": "sidebar",
  "tab.active.background": "canvas",
  "tab.active.foreground": "text",
  "tab.foreground": "textMuted",
  "list.active.background": "sidebarRowActive",
  "list.active.border": "sidebarRowActive",
  "list.hover.background": "sidebarRowHover",
  "danger.background": "error",
  "danger.foreground": "errorForeground",
  "warning.background": "warning",
  "warning.foreground": "warningForeground",
  "scrollbar.background": "canvas",
  "scrollbar.thumb.background": "input",
  link: "focus",
};

function hex(color: string): string {
  if (color.startsWith("#")) return color;
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(color);
  if (!match) throw new Error(`Unsupported native theme color: ${color}`);
  const L = Number(match[1]);
  const C = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return `#${[
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((channel) => {
      const clamped = Math.min(Math.max(channel, 0), 1);
      const gamma = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(gamma * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

const themes = APP_THEMES.flatMap((theme) =>
  (["light", "dark"] as const).flatMap((mode) => {
    const palette = displayedThemeColors(theme, mode);
    if (!palette) return [];
    return [
      {
        name: `${theme.label} ${mode === "light" ? "Light" : "Dark"}`,
        mode,
        radius: 8,
        "radius.lg": 12,
        colors: Object.fromEntries(
          Object.entries(roles).map(([key, role]) => [key, hex(palette[role])]),
        ),
      },
    ];
  }),
);

writeFileSync(
  new URL("../crates/otter-mail/themes/otter.json", import.meta.url),
  `${JSON.stringify({ name: "Otter Mail", themes }, null, 2)}\n`,
);
