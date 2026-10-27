/**
 * The app's color themes, for the agent: which are worn, what a theme's
 * colors are, and making or changing one (Settings › Appearance's library,
 * apps/web's theme/themePalette.ts, ported from Otter Code). They read and
 * write the same synced ui preferences the app does, so the app repaints as
 * soon as a tool changes them, on every device.
 */

import {
  APP_THEMES,
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeDefinition,
} from "@otter-mail/shared/themes";
import { displayedThemeColors, PAINTED_ROLES } from "@otter-mail/shared/theme-display";
import { getUiPreferences, setUiPreference } from "../../preferences.js";
import { optBool, optStr, str, type AgentTool, type ToolArgs } from "./tool.js";

/** The keys apps/web's apply-theme.ts and themePalette.ts keep them under. */
const LIBRARY = "otter:themes:v1";
const WORN: Record<ThemeAppearance, string> = {
  light: "otter:theme:light",
  dark: "otter:theme:dark",
};
/** What a fresh install wears (apply-theme.ts's INITIAL_THEME_ID). */
const INITIAL_THEME = "otter";
const MODES = ["light", "dark"] as const;

type Palette = Record<string, string>;
/** A theme of your own as the library stores it (Otter Code's shape). */
type StoredTheme = {
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: Palette;
  variants?: Partial<Record<ThemeAppearance, Palette>>;
};

async function library(): Promise<StoredTheme[]> {
  try {
    const list: unknown = JSON.parse((await getUiPreferences())[LIBRARY] ?? "[]");
    return Array.isArray(list) ? (list as StoredTheme[]) : [];
  } catch {
    return [];
  }
}

function palettes(theme: StoredTheme): Partial<Record<ThemeAppearance, Palette>> {
  return { ...theme.variants, [theme.appearance]: theme.colors };
}

function builtIn(id: string): ThemeDefinition | undefined {
  return APP_THEMES.find((t) => t.id === id);
}

/** A theme's palettes by appearance: a built-in's as the app paints them. */
async function paletteOf(id: string): Promise<Partial<Record<ThemeAppearance, Palette>>> {
  const theme = builtIn(id);
  if (theme) {
    const out: Partial<Record<ThemeAppearance, Palette>> = {};
    for (const mode of MODES) {
      const colors = displayedThemeColors(theme, mode);
      if (colors) out[mode] = { ...colors };
    }
    return out;
  }
  const own = (await library()).find((t) => t.id === id);
  if (!own) throw new Error(`No theme "${id}". Use list_themes to see them.`);
  return palettes(own);
}

async function worn(): Promise<Record<ThemeAppearance, string>> {
  const ui = await getUiPreferences();
  const known = new Set([...APP_THEMES.map((t) => t.id), ...(await library()).map((t) => t.id)]);
  const pick = (mode: ThemeAppearance) => {
    const id = ui[WORN[mode]];
    return id && known.has(id) ? id : INITIAL_THEME;
  };
  return { light: pick("light"), dark: pick("dark") };
}

/** Only the roles the app paints, for the agent to read and change. */
function painted(palette: Palette): Palette {
  return Object.fromEntries(Object.entries(palette).filter(([role]) => role in PAINTED_ROLES));
}

/** "#rrggbb" or "oklch(L C H)", checked; the colors the library and the iPhone app read. */
function color(value: unknown, where: string): string {
  const css = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^#[0-9a-f]{6}$/.test(css) || /^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\)$/.test(css))
    return css;
  throw new Error(`${where} must be a color like "#1a1b26" or "oklch(0.6 0.1 250)".`);
}

/** The colors an argument sets, by role; checked. */
function changes(args: ToolArgs, mode: ThemeAppearance): Palette | undefined {
  const value = args[mode];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error(`"${mode}" must be an object of role: color.`);
  const out: Palette = {};
  for (const [role, css] of Object.entries(value)) {
    if (!(THEME_COLOR_ROLES as readonly string[]).includes(role))
      throw new Error(
        `"${role}" isn't a theme role. Roles: ${Object.keys(PAINTED_ROLES).join(", ")}.`,
      );
    out[role] = color(css, `${mode}.${role}`);
  }
  return out;
}

/** apps/web's themeIdFromName, made unique among the themes there are. */
function newId(name: string, taken: Set<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 44) || "custom-theme";
  let id = base;
  for (let n = 2; taken.has(id) || ["system", "light", "dark"].includes(id); n++)
    id = `${base}-${n}`;
  return id;
}

function stored(
  id: string,
  label: string,
  modes: Partial<Record<ThemeAppearance, Palette>>,
): StoredTheme {
  const [first, second] = MODES.filter((m) => modes[m]);
  if (!first) throw new Error("A theme needs a light or a dark palette.");
  return {
    id,
    label,
    appearance: first,
    colors: modes[first]!,
    ...(second ? { variants: { [second]: modes[second]! } } : {}),
  };
}

const ROLES_HELP = Object.entries(PAINTED_ROLES)
  .map(([role, what]) => `${role} (${what})`)
  .join(", ");

const paletteArg = (mode: ThemeAppearance) => ({
  type: "object",
  additionalProperties: { type: "string" },
  description: `Colors to set in the ${mode} palette, role → "#rrggbb" or "oklch(L C H)". Only these change.`,
});

export const themeTools: AgentTool[] = [
  {
    name: "list_themes",
    title: "List themes",
    description:
      "The app's color themes (built-in, and the user's own), and which one each appearance (light, dark) wears now, plus the color scheme (system, light or dark).",
    input: { type: "object", properties: {} },
    readOnly: true,
    async run() {
      const own = await library();
      const ui = await getUiPreferences();
      return {
        wearing: await worn(),
        colorScheme: ui["otter:theme-source"] ?? "system",
        themes: [
          ...APP_THEMES.map((t) => ({
            id: t.id,
            name: t.label,
            builtIn: true,
            appearances: MODES.filter((m) => displayedThemeColors(t, m)),
          })),
          ...own.map((t) => ({
            id: t.id,
            name: t.label,
            builtIn: false,
            appearances: MODES.filter((m) => palettes(t)[m]),
          })),
        ],
      };
    },
  },
  {
    name: "get_theme",
    title: "Get theme",
    description: `A theme's colors for each appearance it has, by role (the roles the app paints). Roles: ${ROLES_HELP}.`,
    input: {
      type: "object",
      properties: { theme: { type: "string", description: "Its id (from list_themes)." } },
      required: ["theme"],
    },
    readOnly: true,
    async run(args) {
      const id = str(args, "theme");
      const modes = await paletteOf(id);
      return {
        id,
        builtIn: Boolean(builtIn(id)),
        ...Object.fromEntries(MODES.filter((m) => modes[m]).map((m) => [m, painted(modes[m]!)])),
      };
    },
  },
  {
    name: "save_theme",
    title: "Save theme",
    description:
      "Makes a theme of the user's own, or changes one, setting the colors given (every other color stays). " +
      'Changing a built-in (like the one worn now) makes a copy ("<name> copy" unless `name` is given) and wears it in its place, as built-ins never change. ' +
      "A new theme starts from `from` (default: the theme the dark appearance wears) and is worn at once unless `wear` is false. " +
      `Roles: ${ROLES_HELP}. Contrast matters: keep text readable on its background.`,
    input: {
      type: "object",
      properties: {
        theme: {
          type: "string",
          description: "The theme to change, by id. Leave out to make a new one.",
        },
        name: { type: "string", description: "A new theme's name, or a new name for `theme`." },
        from: { type: "string", description: "The theme a new one starts from, by id." },
        light: paletteArg("light"),
        dark: paletteArg("dark"),
        wear: { type: "boolean", description: "Wear a new theme now (default true)." },
      },
    },
    async run(args, ctx) {
      const own = await library();
      const wearing = await worn();
      const target = optStr(args, "theme");
      const name = optStr(args, "name")?.slice(0, 48);
      const edits = { light: changes(args, "light"), dark: changes(args, "dark") };
      const changed = MODES.flatMap((m) =>
        Object.entries(edits[m] ?? {}).map(([role, css]) => `${m} ${role} ${css}`),
      );
      const existing = target ? own.find((t) => t.id === target) : undefined;

      if (existing) {
        const modes = palettes(existing);
        for (const mode of MODES) {
          if (!edits[mode]) continue;
          // A palette it lacks starts from what that appearance wears now.
          modes[mode] = {
            ...(modes[mode] ?? (await paletteOf(wearing[mode]))[mode]),
            ...edits[mode],
          };
        }
        const label = name ?? existing.label;
        await ctx.confirm(
          [
            `Change the theme “${existing.label}”${name ? `, renamed “${name}”` : ""}`,
            ...changed,
          ].join("\n"),
        );
        const next = own.map((t) => (t.id === existing.id ? stored(t.id, label, modes) : t));
        await setUiPreference(LIBRARY, JSON.stringify(next));
        ctx.changed?.({
          action: "updated",
          title: label,
          target: { kind: "theme", id: existing.id },
        });
        return { id: existing.id, name: label, appearances: MODES.filter((m) => modes[m]) };
      }

      // A new theme: from `from`, or a copy of the built-in named in `theme`.
      const copyOf = target && builtIn(target) ? target : undefined;
      if (target && !copyOf) throw new Error(`No theme "${target}". Use list_themes to see them.`);
      const source = copyOf ?? optStr(args, "from") ?? wearing.dark;
      const modes = await paletteOf(source);
      for (const mode of MODES) {
        if (!edits[mode]) continue;
        modes[mode] = {
          ...(modes[mode] ?? (await paletteOf(wearing[mode]))[mode]),
          ...edits[mode],
        };
      }
      const label =
        name ??
        `${(builtIn(source)?.label ?? own.find((t) => t.id === source)?.label) || "Custom"} copy`;
      const id = newId(label, new Set([...APP_THEMES.map((t) => t.id), ...own.map((t) => t.id)]));
      const wear = copyOf
        ? MODES.filter((m) => wearing[m] === copyOf && modes[m])
        : (optBool(args, "wear") ?? true)
          ? MODES.filter((m) => modes[m])
          : [];
      await ctx.confirm(
        [
          `Make the theme “${label}” from ${builtIn(source)?.label ?? source}` +
            (wear.length ? ` and wear it (${wear.join(" and ")})` : ""),
          ...changed,
        ].join("\n"),
      );
      await setUiPreference(LIBRARY, JSON.stringify([...own, stored(id, label, modes)]));
      ctx.changed?.({ action: "created", title: label, target: { kind: "theme", id } });
      for (const mode of wear) await setUiPreference(WORN[mode], id);
      return { id, name: label, appearances: MODES.filter((m) => modes[m]), wearing: await worn() };
    },
  },
  {
    name: "use_theme",
    title: "Use theme",
    description:
      "Wears a theme: for the appearances it has, or only the one given (light or dark).",
    input: {
      type: "object",
      properties: {
        theme: { type: "string", description: "Its id (from list_themes)." },
        appearance: { type: "string", enum: ["light", "dark"], description: "Default: both." },
      },
      required: ["theme"],
    },
    async run(args, ctx) {
      const id = str(args, "theme");
      const has = await paletteOf(id);
      const only = optStr(args, "appearance");
      if (only && only !== "light" && only !== "dark")
        throw new Error('"appearance" must be light or dark.');
      const modes = MODES.filter((m) => has[m] && (!only || m === only));
      if (!modes.length) throw new Error(`"${id}" has no ${only} palette.`);
      const name = builtIn(id)?.label ?? (await library()).find((t) => t.id === id)?.label ?? id;
      await ctx.confirm(`Wear the theme “${name}” (${modes.join(" and ")})`);
      for (const mode of modes) {
        await setUiPreference(WORN[mode], id);
        ctx.changed?.({ action: "updated", title: name, target: { kind: "theme", id } });
      }
      return { wearing: await worn() };
    },
  },
];
