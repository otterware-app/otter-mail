import { useLatest } from "../use-latest";
import { setSyncedPreference } from "../synced-preferences";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { toast } from "../gmail/toast";
import type { NativeThemeInfo } from "@otter-mail/contracts";
import {
  CopyIcon,
  EllipsisIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { cn, HintTooltip } from "../gmail/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../gmail/menu";
import {
  appearance,
  INITIAL_THEME_ID,
  setThemeForAppearance,
  themeColors,
  useAppThemes,
  useThemeChoice,
} from "../theme/apply-theme";
import {
  APP_THEMES,
  getThemeColorsForAppearance,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "@otter-mail/shared/themes";
import { getThemeModes, removeCustomTheme, serializeThemeFile } from "../theme/themePalette";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Dialog } from "~/components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { ThemeImportDialog } from "./theme/ThemeImportDialog";
import { useThemeEditorStore } from "./theme/themeEditorStore";
import {
  DEFAULT_PANEL_ANIMATION_DURATION_MS,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_PANEL_ANIMATION_DURATION_MS,
  setPanelAnimationDurationMs,
  usePanelAnimationDurationMs,
} from "../panel-animations";
import { PanelAnimationsPreview } from "./panel-animations-preview";
import {
  CONTRAST,
  GLASS_OPACITY,
  DEFAULT_READING_WIDTH,
  DEFAULT_MESSAGE_LIST_STYLE,
  DEFAULT_MAIL_LAYOUT,
  INTERFACE_FONT_SIZE,
  GROUP_MESSAGES_BY_DAY,
  DIM_READ_MESSAGES,
  OPEN_MESSAGES_WITH_ARROWS,
  MARK_READ_DELAY,
  MESSAGE_LIST_STYLES,
  MAIL_LAYOUTS,
  READING_WIDTHS,
  setInterfaceSetting,
  setInterfaceToggle,
  setReadingWidth,
  setMessageListStyle,
  setMailLayout,
  useInterfaceSetting,
  useInterfaceToggle,
  useReadingWidth,
  useMessageListStyle,
  useMailLayout,
  type InterfaceSetting,
  type ReadingWidth,
  type MessageListStyle,
  type MailLayout,
} from "../theme/interface-settings";
import {
  RowSelect,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settings-ui";
import { searchableSetting } from "./settings-search";
import { AppIconPicker } from "./app-icon-picker";

export type ColorScheme = "system" | "light" | "dark";

// ---------------------------------------------------------------------------
// Color scheme cards: a miniature window painted with the chosen theme.
// ---------------------------------------------------------------------------

/** A tiny mail window (sidebar, list lines, bubble, composer) in one palette. */
function MiniWindow({ colors }: { colors: ThemeColors }) {
  const line = (width: string, extra?: CSSProperties) => (
    <span
      className="block h-1.5 rounded-full"
      style={{ width, backgroundColor: colors.textMuted, opacity: 0.6, ...extra }}
    />
  );
  return (
    <span className="flex size-full" style={{ backgroundColor: colors.canvas }}>
      <span
        className="flex w-[26%] flex-col gap-1.5 px-2 pt-2.5"
        style={{
          backgroundColor: colors.sidebar,
          borderRight: `1px solid ${colors.sidebarBorder}`,
        }}
      >
        <span
          className="block h-2 rounded-full"
          style={{
            backgroundColor: colors.sidebarRowSelected,
            border: `1px solid ${colors.input}`,
          }}
        />
        {line("80%")}
        {line("65%")}
        {line("72%")}
      </span>
      <span className="relative flex flex-1 flex-col gap-1.5 px-3 pt-3">
        <span className="flex justify-end">
          <span
            className="block h-3 w-[38%] rounded-full"
            style={{ backgroundColor: colors.messageSurface }}
          />
        </span>
        {line("62%")}
        {line("48%")}
        <span
          className="absolute inset-x-3 bottom-2.5 flex h-4 items-center justify-end rounded-full px-1"
          style={{ backgroundColor: colors.surfaceRaised, border: `1px solid ${colors.input}` }}
        >
          <span
            className="block size-2.5 rounded-full"
            style={{ backgroundColor: colors.messageAction }}
          />
        </span>
      </span>
    </span>
  );
}

export function SchemeCard({
  scheme,
  selected,
  light,
  dark,
  onSelect,
  compact = false,
}: {
  scheme: ColorScheme;
  selected: boolean;
  light: ThemeColors;
  dark: ThemeColors;
  onSelect: () => void;
  /** A short window over its name, as tall as the theme cards below it (Settings). */
  compact?: boolean;
}) {
  const label = scheme === "system" ? "System" : scheme === "light" ? "Light" : "Dark";
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-xl border bg-card p-2 pb-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        compact && "items-stretch gap-1.5 p-1.5 pb-2",
        selected
          ? "border-focus-ring text-foreground ring-1 ring-focus-ring"
          : "border-border/60 text-muted-foreground hover:border-input hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "relative block w-full overflow-hidden rounded-lg border border-border/60",
          compact ? "h-16" : "aspect-[16/10]",
        )}
      >
        {scheme === "system" ? (
          <>
            <span className="absolute inset-0">
              <MiniWindow colors={light} />
            </span>
            <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
              <MiniWindow colors={dark} />
            </span>
          </>
        ) : (
          <MiniWindow colors={scheme === "light" ? light : dark} />
        )}
      </span>
      <span
        className={cn(
          compact && "flex min-h-6 items-center px-2.5",
          selected && !compact && "font-medium",
        )}
      >
        {label}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Theme cards: the theme's own light and dark windows, side by side.
// ---------------------------------------------------------------------------

/** One side of a theme card's window: click it to wear the theme there alone. */
function ThemeHalf({
  theme,
  mode,
  side,
  picked,
  onPick,
}: {
  theme: ThemeDefinition;
  mode: ThemeAppearance;
  /** Which part of the window shows: light is its left, dark its right (as System's tile). */
  side: "start" | "end" | "full";
  picked: boolean;
  onPick: () => void;
}) {
  return (
    <HintTooltip label={mode === "light" ? "Use for light mode" : "Use for dark mode"}>
      <button
        type="button"
        aria-label={`Use ${theme.label} for ${mode} mode`}
        aria-pressed={picked}
        onClick={(e) => {
          e.stopPropagation();
          onPick();
        }}
        className={cn(
          "group/half relative min-w-0 flex-1 cursor-pointer overflow-hidden outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus-ring",
          side !== "end" && "rounded-s-[7px]",
          side !== "start" && "rounded-e-[7px]",
        )}
      >
        <span
          className={cn(
            "absolute inset-y-0 block",
            side === "full" ? "inset-x-0" : "w-[200%]",
            side === "end" && "right-0",
          )}
        >
          <MiniWindow colors={themeColors(theme.id, mode)} />
        </span>
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit]",
            picked
              ? "shadow-[inset_0_0_0_2px_var(--ring)]"
              : "group-hover/half:shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--ring)_45%,transparent)]",
          )}
        />
      </button>
    </HintTooltip>
  );
}

export function ThemeCard({
  theme,
  pickedModes,
  onPick,
  actions,
}: {
  theme: ThemeDefinition;
  pickedModes: ThemeAppearance[];
  onPick: (modes: ThemeAppearance[]) => void;
  /** Buttons by the label, shown on hover (Otter Code's Duplicate, Edit, Export, Remove). */
  actions?: ReactNode;
}) {
  const active = pickedModes.length > 0;
  // A theme of your own may have one palette only, as in Otter Code.
  const modes = (["light", "dark"] as const).filter((mode) =>
    getThemeColorsForAppearance(theme, mode),
  );
  const label =
    modes.length > 1
      ? `Use ${theme.label} for light and dark mode`
      : `Use ${theme.label} for ${modes[0]} mode`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onPick([...modes])}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick([...modes]);
        }
      }}
      className={cn(
        "group/theme flex cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-1.5 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        active ? "border-foreground/25" : "border-border/60 hover:border-input",
      )}
    >
      <span className="flex h-16 overflow-hidden rounded-lg border border-border/60">
        {modes.map((mode) => (
          <ThemeHalf
            key={mode}
            theme={theme}
            mode={mode}
            side={modes.length === 1 ? "full" : mode === "light" ? "start" : "end"}
            picked={pickedModes.includes(mode)}
            onPick={() => onPick([mode])}
          />
        ))}
      </span>
      <div className="flex min-h-6 items-center gap-2 px-2.5">
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{theme.label}</span>
        {actions ? (
          <span
            className="-me-1.5 flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/theme:opacity-100 group-hover/theme:opacity-100 has-[[data-state=open]]:opacity-100"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actions}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One of a card's actions, as Otter Code's library cards have them. */
function ThemeAction({
  label,
  tooltip,
  onClick,
  destructive,
  children,
}: {
  label: string;
  tooltip: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            variant={destructive ? "ghost-destructive" : "ghost"}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Themes four to a row (seven built-ins leave a short row, not a lone card). */
function ThemeGrid({ children }: { children: ReactNode }) {
  return (
    <div className="@container">
      <div className="grid grid-cols-2 gap-2 @min-[28rem]:grid-cols-3 @min-[40rem]:grid-cols-4">
        {children}
      </div>
    </div>
  );
}

/** The built-in or your own themes, under a small heading. */
function ThemeGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="px-[17px] text-xs text-muted-foreground">{title}</h4>
      <ThemeGrid>{children}</ThemeGrid>
    </div>
  );
}

// Otter Code's (ThemeSettings.tsx).
function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can abort the download in some browsers; give the
  // browser time to open the stream first.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * The Themes grid, as Otter Code's theme library: every theme can be
 * duplicated into the editor (settings/theme, Otter Code's), your own can be
 * edited, exported as a file and removed, and themes come in from files
 * (Otter Code's and VS Code's).
 */
function ThemeLibrary() {
  const choice = useThemeChoice();
  const themes = useAppThemes();
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [removing, setRemoving] = useState<ThemeDefinition | null>(null);

  // Wears a theme wherever it has a palette: a one-palette theme takes its own side only.
  const wear = (theme: ThemeDefinition) => {
    for (const mode of getThemeModes(theme)) setThemeForAppearance(mode, theme.id);
  };

  const duplicate = (theme: ThemeDefinition) =>
    openThemeEditor({
      editingThemeId: null,
      seedThemeId: theme.id,
      seedName: `${theme.label} copy`,
      initialAppearance: appearance(),
    });

  // Built-ins are never changed: duplicating one is how you make it yours.
  const card = (theme: ThemeDefinition, custom: boolean) => (
    <ThemeCard
      key={theme.id}
      theme={theme}
      pickedModes={(["light", "dark"] as const).filter((m) => choice[m] === theme.id)}
      onPick={(modes) => {
        for (const mode of modes) setThemeForAppearance(mode, theme.id);
      }}
      actions={
        // One button a card: your own themes' actions sit behind it.
        custom ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label={`More for ${theme.label}`} size="icon-xs" variant="ghost">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={<PenLineIcon />}
                onSelect={() =>
                  openThemeEditor({
                    editingThemeId: theme.id,
                    seedThemeId: null,
                    seedName: null,
                    initialAppearance: appearance(),
                  })
                }
              >
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem icon={<CopyIcon />} onSelect={() => duplicate(theme)}>
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<UploadIcon />}
                onSelect={() => downloadThemeFile(`${theme.id}.json`, serializeThemeFile(theme))}
              >
                Export theme file
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<Trash2Icon />}
                color="red"
                onSelect={() => setRemoving(theme)}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <ThemeAction
            label={`Duplicate ${theme.label}`}
            tooltip="Duplicate theme"
            onClick={() => duplicate(theme)}
          >
            <CopyIcon />
          </ThemeAction>
        )
      }
    />
  );
  const builtIn = themes.filter((theme) => APP_THEMES.includes(theme));
  const custom = themes.filter((theme) => !APP_THEMES.includes(theme));

  return (
    <SettingsSection
      {...searchableSetting("themes")}
      variant="plain"
      headerAction={
        <div className="flex items-center gap-2">
          {choice.light !== INITIAL_THEME_ID || choice.dark !== INITIAL_THEME_ID ? (
            <SettingResetButton
              label="themes"
              onClick={() => {
                setThemeForAppearance("light", INITIAL_THEME_ID);
                setThemeForAppearance("dark", INITIAL_THEME_ID);
              }}
            />
          ) : null}
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              // Starts from what's on screen, as in Otter Code.
              openThemeEditor({
                editingThemeId: null,
                seedThemeId: choice[appearance()],
                seedName: null,
                initialAppearance: appearance(),
              })
            }
          >
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button size="xs" variant="outline" onClick={() => setIsImportOpen(true)}>
            <PlusIcon />
            Add theme
          </Button>
        </div>
      }
    >
      <TooltipProvider>
        {/* Headings only once there are themes of your own to tell apart. */}
        {custom.length > 0 ? (
          <div className="space-y-4">
            <ThemeGroup title="Built-in">{builtIn.map((theme) => card(theme, false))}</ThemeGroup>
            <ThemeGroup title="Yours">{custom.map((theme) => card(theme, true))}</ThemeGroup>
          </div>
        ) : (
          <ThemeGrid>{builtIn.map((theme) => card(theme, false))}</ThemeGrid>
        )}
      </TooltipProvider>
      <ThemeImportDialog
        open={isImportOpen}
        onOpenChange={setIsImportOpen}
        onImported={(imported) => {
          wear(imported);
          const modes = getThemeModes(imported);
          toast.success(`${imported.label} added`, {
            description:
              modes.length === 1 ? `It’s now your ${modes[0]} theme.` : "It’s now active.",
          });
          return true;
        }}
        onImportedMany={(imported, { updated }) => {
          const verb = updated ? "updated" : "added";
          toast.success(
            imported.length === 1
              ? `${imported[0]!.label} ${verb}`
              : `${imported.length} themes ${verb}`,
            { description: imported.map((theme) => theme.label).join(", ") },
          );
        }}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove “${removing?.label}”?`}
        description="It’s removed on all your devices. You can bring it back anytime by importing its JSON file."
        confirmLabel="Remove theme"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!removing) return;
          // Whatever wore it goes back to the theme a fresh install wears.
          for (const mode of ["light", "dark"] as const) {
            if (choice[mode] === removing.id) setThemeForAppearance(mode, INITIAL_THEME_ID);
          }
          try {
            removeCustomTheme(removing.id);
          } catch {
            toast.error("Couldn’t remove theme", { description: "Try again." });
          }
        }}
      />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Sliders (Otter Code's settings sliders)
// ---------------------------------------------------------------------------

/** A range input with its value beside it. */
function SettingSlider({
  id,
  label,
  value,
  valueLabel,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3">
      <output
        className="min-w-16 rounded-lg bg-muted px-2 py-1 text-center font-mono text-xs tabular-nums text-foreground"
        htmlFor={id}
      >
        {valueLabel}
      </output>
      <input
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        id={id}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        style={style}
        type="range"
        value={value}
      />
    </div>
  );
}

/** Contrast or glass opacity: a percentage slider, reset beside the title. */
function PercentSettingRow({
  setting,
  searchId,
  label,
  description,
}: {
  setting: InterfaceSetting;
  searchId: "contrast" | "glass-opacity";
  label: string;
  description: string;
}) {
  const value = useInterfaceSetting(setting);
  return (
    <SettingsRow
      {...searchableSetting(searchId)}
      description={description}
      control={
        // As wide as Panel animations' slider, so the three line up.
        <div className="w-full sm:w-52">
          <SettingSlider
            id={`${searchId}-slider`}
            label={label}
            value={value}
            valueLabel={`${value}%`}
            min={setting.min}
            max={setting.max}
            step={setting.step}
            onChange={(next) => setInterfaceSetting(setting, next)}
          />
        </div>
      }
      resetAction={
        value !== setting.defaultValue ? (
          <SettingResetButton
            label={label.toLowerCase()}
            onClick={() => setInterfaceSetting(setting, setting.defaultValue)}
          />
        ) : null
      }
    />
  );
}

const FONT_SIZE_OPTIONS = Array.from(
  { length: INTERFACE_FONT_SIZE.max - INTERFACE_FONT_SIZE.min + 1 },
  (_, i) => String(INTERFACE_FONT_SIZE.min + i),
).map((size) => ({ value: size, label: `${size} px` }));

/** Font size, in Appearance and setup's Look step (`id`: Settings' search target). */
export function FontSizeRow({ id }: { id?: string }) {
  const fontSize = useInterfaceSetting(INTERFACE_FONT_SIZE);
  return (
    <SettingsRow
      id={id}
      title="Font size"
      description="Text and controls across the app, messages included."
      control={
        <RowSelect
          ariaLabel="Font size"
          value={String(fontSize)}
          onValueChange={(size) => setInterfaceSetting(INTERFACE_FONT_SIZE, Number(size))}
          options={FONT_SIZE_OPTIONS}
        />
      }
      resetAction={
        fontSize !== INTERFACE_FONT_SIZE.defaultValue ? (
          <SettingResetButton
            label="font size"
            onClick={() =>
              setInterfaceSetting(INTERFACE_FONT_SIZE, INTERFACE_FONT_SIZE.defaultValue)
            }
          />
        ) : null
      }
    />
  );
}

/** Reading width, in Appearance and setup's Look step. */
export function ReadingWidthRow({ id }: { id?: string }) {
  const readingWidth = useReadingWidth();
  return (
    <SettingsRow
      id={id}
      title="Reading width"
      description="How wide emails and threads can grow on large screens."
      control={
        <RowSelect
          ariaLabel="Reading width"
          value={readingWidth}
          onValueChange={(width) => setReadingWidth(width as ReadingWidth)}
          options={Object.entries(READING_WIDTHS).map(([value, { label }]) => ({ value, label }))}
        />
      }
      resetAction={
        readingWidth !== DEFAULT_READING_WIDTH ? (
          <SettingResetButton
            label="reading width"
            onClick={() => setReadingWidth(DEFAULT_READING_WIDTH)}
          />
        ) : null
      }
    />
  );
}

function MailLayoutPicker() {
  const selectedLayout = useMailLayout();
  return (
    <SettingsSection
      {...searchableSetting("mail-layout")}
      description="Choose how you browse and read your mail."
      variant="plain"
      headerAction={
        selectedLayout !== DEFAULT_MAIL_LAYOUT ? (
          <SettingResetButton
            label="mail layout"
            onClick={() => setMailLayout(DEFAULT_MAIL_LAYOUT)}
          />
        ) : null
      }
    >
      <div className="@container">
        <div className="grid grid-cols-1 gap-2 @min-[24rem]:grid-cols-3">
          {Object.entries(MAIL_LAYOUTS).map(([value, { label, description }]) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={selectedLayout === value}
              aria-describedby={`mail-layout-${value}-description`}
              onClick={() => setMailLayout(value as MailLayout)}
              className={cn(
                "flex cursor-pointer flex-col rounded-xl border bg-card p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                selectedLayout === value
                  ? "border-focus-ring ring-1 ring-focus-ring"
                  : "border-border/60 hover:border-input",
              )}
            >
              <span
                aria-hidden="true"
                className="relative flex h-32 w-full overflow-hidden rounded-lg border border-border/60 bg-canvas"
              >
                <span className="flex w-1/5 shrink-0 flex-col gap-2 border-r border-border/70 bg-sidebar-surface p-2 pt-4">
                  <span className="h-2 rounded-sm bg-sidebar-row-active" />
                  <span className="h-1 w-4/5 rounded-full bg-muted-foreground/25" />
                  <span className="h-1 w-3/5 rounded-full bg-muted-foreground/25" />
                  <span className="h-1 w-4/5 rounded-full bg-muted-foreground/25" />
                </span>
                <span
                  className={cn(
                    "flex flex-col",
                    value === "split" ? "w-1/3 border-r border-border/70" : "flex-1",
                  )}
                >
                  <span className="flex h-6 shrink-0 items-center border-b border-border/60 px-2">
                    <span className="h-1 w-8 rounded-full bg-muted-foreground/40" />
                  </span>
                  {[0, 1, 2, 3].map((row) => (
                    <span
                      key={row}
                      className={cn(
                        "flex gap-1.5 border-b border-border/40 px-2 py-2",
                        value === "split" ? "flex-col" : "items-center",
                        row === 0 && value === "split" && "bg-sidebar-row-active",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1 rounded-full bg-foreground/40",
                          value === "split" ? "w-3/5" : "w-1/5",
                        )}
                      />
                      <span
                        className={cn(
                          "h-1 rounded-full bg-muted-foreground/25",
                          value === "split" ? "w-4/5" : "flex-1",
                        )}
                      />
                      {value !== "split" ? (
                        <span className="h-1 w-3 rounded-full bg-muted-foreground/25" />
                      ) : null}
                    </span>
                  ))}
                </span>
                {value === "split" ? (
                  <span className="flex min-w-0 flex-1 flex-col gap-2 p-2 pt-4">
                    <span className="h-1.5 w-4/5 rounded-full bg-foreground/50" />
                    <span className="mt-2 h-1 w-3/5 rounded-full bg-muted-foreground/30" />
                    <span className="h-1 w-full rounded-full bg-muted-foreground/20" />
                    <span className="h-1 w-4/5 rounded-full bg-muted-foreground/20" />
                    <span className="h-1 w-full rounded-full bg-muted-foreground/20" />
                  </span>
                ) : null}
                {value === "floating" ? (
                  <span className="absolute inset-0 flex items-end justify-end p-1.5">
                    <span className="flex h-20 w-2/3 flex-col overflow-hidden rounded-md border border-border bg-canvas shadow-lg">
                      <span className="flex h-6 shrink-0 items-center justify-between border-b border-border/60 px-2">
                        <span className="h-1 w-2/5 rounded-full bg-foreground/50" />
                        <span className="text-[10px] leading-none text-muted-foreground">×</span>
                      </span>
                      <span className="flex flex-col gap-1.5 p-2">
                        <span className="h-1 w-2/5 rounded-full bg-foreground/40" />
                        <span className="mt-1 h-1 w-full rounded-full bg-muted-foreground/25" />
                        <span className="h-1 w-4/5 rounded-full bg-muted-foreground/25" />
                        <span className="h-1 w-3/5 rounded-full bg-muted-foreground/25" />
                      </span>
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="mt-2 px-2.5 text-sm font-medium text-foreground">{label}</span>
              <span
                id={`mail-layout-${value}-description`}
                className="mt-1 mb-1 px-2.5 text-xs leading-relaxed text-muted-foreground"
              >
                {description}
              </span>
            </button>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}

function MessageListStylePicker() {
  const selectedStyle = useMessageListStyle();
  return (
    <SettingsSection
      {...searchableSetting("message-list-style")}
      description="Choose how conversations are separated in the message list."
      variant="plain"
      headerAction={
        selectedStyle !== DEFAULT_MESSAGE_LIST_STYLE ? (
          <SettingResetButton
            label="message list style"
            onClick={() => setMessageListStyle(DEFAULT_MESSAGE_LIST_STYLE)}
          />
        ) : null
      }
    >
      <div className="@container">
        <div className="grid grid-cols-1 gap-2 @min-[24rem]:grid-cols-2">
          {Object.entries(MESSAGE_LIST_STYLES).map(([value, { label, description }]) => {
            const selected = selectedStyle === value;
            return (
              <button
                key={value}
                type="button"
                aria-label={label}
                aria-pressed={selected}
                aria-describedby={`message-list-style-${value}-description`}
                onClick={() => setMessageListStyle(value as MessageListStyle)}
                className={cn(
                  "flex cursor-pointer flex-col rounded-xl border bg-card p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  selected
                    ? "border-focus-ring ring-1 ring-focus-ring"
                    : "border-border/60 hover:border-input",
                )}
              >
                <span
                  aria-hidden="true"
                  data-message-list-style={value}
                  className="block h-40 w-full overflow-hidden rounded-lg border border-border/60 bg-sidebar-surface"
                >
                  <span
                    className={cn("block", value === "classic" && "pt-2")}
                    style={{ zoom: 0.75 }}
                  >
                    {[
                      {
                        sender: "Alex Morgan",
                        subject: "Weekend plans",
                        snippet: "How about Saturday?",
                      },
                      {
                        sender: "Jamie Lee",
                        subject: "A little update",
                        snippet: "Here's what I've been working on.",
                      },
                    ].map(({ sender, subject, snippet }) => (
                      <span key={sender} className="message-list-group block">
                        <span className="message-list-row block px-3">
                          <span className="message-list-row-content flex min-w-0 flex-col">
                            <span className="truncate text-sm font-medium leading-snug text-foreground">
                              {sender}
                            </span>
                            <span className="truncate text-[13px] leading-snug text-foreground/90">
                              {subject}
                            </span>
                            <span className="message-list-snippet truncate text-[13px] leading-snug text-muted-foreground/75">
                              {snippet}
                            </span>
                          </span>
                        </span>
                      </span>
                    ))}
                  </span>
                </span>
                <span className="mt-2 px-2.5 text-sm font-medium text-foreground">{label}</span>
                <span
                  id={`message-list-style-${value}-description`}
                  className="mt-1 mb-1 px-2.5 text-xs leading-relaxed text-muted-foreground"
                >
                  {description}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

/** The app's color scheme (System, Light, Dark), and a setter that syncs it with the account. */
export function useColorScheme(): [ColorScheme, (next: ColorScheme) => Promise<void>] {
  const [themeInfo, setThemeInfo] = useState<NativeThemeInfo | null>(null);

  const refreshThemeInfo = async () => {
    try {
      setThemeInfo(await window.desktopBridge.nativeTheme.getInfo());
    } catch (error) {
      toast.error(`Failed to get theme info: ${error}`);
    }
  };
  const refreshThemeInfoForEffect = useLatest(refreshThemeInfo);
  useEffect(() => {
    void refreshThemeInfoForEffect.current();
  }, [refreshThemeInfoForEffect]);

  const scheme: ColorScheme = themeInfo?.themeSource ?? "system";
  const setScheme = async (next: ColorScheme) => {
    console.log("[Settings:setColorScheme]", { scheme: next });
    try {
      await window.desktopBridge.nativeTheme.setThemeSource(next);
      setSyncedPreference("otter:theme-source", next);
      await refreshThemeInfo();
    } catch (error) {
      toast.error(`Failed to set color scheme: ${error}`);
    }
  };
  return [scheme, setScheme];
}

export function AppearancePane() {
  const choice = useThemeChoice();
  const [scheme, setScheme] = useColorScheme();
  const groupMessagesByDay = useInterfaceToggle(GROUP_MESSAGES_BY_DAY);
  const dimReadMessages = useInterfaceToggle(DIM_READ_MESSAGES);
  const openMessagesWithArrows = useInterfaceToggle(OPEN_MESSAGES_WITH_ARROWS);
  const markReadDelay = useInterfaceSetting(MARK_READ_DELAY);

  const panelAnimationDurationMs = usePanelAnimationDurationMs();

  const light = themeColors(choice.light, "light");
  const dark = themeColors(choice.dark, "dark");

  return (
    <SettingsPageContainer title="Appearance">
      {/* The scheme and the themes it wears, together (Otter Code's). */}
      <div className="space-y-6">
        <SettingsSection
          {...searchableSetting("color-scheme")}
          variant="plain"
          headerAction={
            scheme !== "system" ? (
              <SettingResetButton label="color scheme" onClick={() => void setScheme("system")} />
            ) : null
          }
        >
          <div className="grid grid-cols-3 gap-2">
            {(["system", "light", "dark"] as const).map((s) => (
              <SchemeCard
                key={s}
                compact
                scheme={s}
                selected={scheme === s}
                light={light}
                dark={dark}
                onSelect={() => void setScheme(s)}
              />
            ))}
          </div>
        </SettingsSection>

        <ThemeLibrary />
        <AppIconPicker />
      </div>

      <MailLayoutPicker />
      <MessageListStylePicker />

      <SettingsSection title="Message list" description="These options apply to every mail layout.">
        <SettingsRow
          {...searchableSetting("group-messages-by-day")}
          resetAction={
            groupMessagesByDay !== GROUP_MESSAGES_BY_DAY.defaultValue ? (
              <SettingResetButton
                label="group messages by day"
                onClick={() =>
                  setInterfaceToggle(GROUP_MESSAGES_BY_DAY, GROUP_MESSAGES_BY_DAY.defaultValue)
                }
              />
            ) : null
          }
          description="Separate messages by day. Click a day heading to collapse or expand it."
          control={
            <Switch
              aria-label="Group messages by day"
              checked={groupMessagesByDay}
              onCheckedChange={(value) => setInterfaceToggle(GROUP_MESSAGES_BY_DAY, value)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("dim-read-messages")}
          resetAction={
            dimReadMessages !== DIM_READ_MESSAGES.defaultValue ? (
              <SettingResetButton
                label="dim read messages"
                onClick={() =>
                  setInterfaceToggle(DIM_READ_MESSAGES, DIM_READ_MESSAGES.defaultValue)
                }
              />
            ) : null
          }
          description="Give read messages a muted background so unread mail stands out."
          control={
            <Switch
              aria-label="Dim read messages"
              checked={dimReadMessages}
              onCheckedChange={(value) => setInterfaceToggle(DIM_READ_MESSAGES, value)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Reading">
        <SettingsRow
          {...searchableSetting("open-messages-with-arrows")}
          resetAction={
            openMessagesWithArrows !== OPEN_MESSAGES_WITH_ARROWS.defaultValue ? (
              <SettingResetButton
                label="open messages with arrow keys"
                onClick={() =>
                  setInterfaceToggle(
                    OPEN_MESSAGES_WITH_ARROWS,
                    OPEN_MESSAGES_WITH_ARROWS.defaultValue,
                  )
                }
              />
            ) : null
          }
          description="When no email is open, arrows and J/K open messages as you browse. Turn off to highlight rows, then press Enter or click to open."
          control={
            <Switch
              aria-label="Open messages with arrow keys"
              checked={openMessagesWithArrows}
              onCheckedChange={(value) => setInterfaceToggle(OPEN_MESSAGES_WITH_ARROWS, value)}
            />
          }
        />
        <SettingsRow
          {...searchableSetting("mark-read-delay")}
          description="How long to wait before marking an email read when browsing with the keyboard. Clicking or pressing Enter marks it read immediately."
          control={
            <div className="w-full sm:w-52">
              <SettingSlider
                id="mark-read-delay-slider"
                label="Mark as read delay"
                value={markReadDelay}
                valueLabel={`${markReadDelay / 1000} s`}
                min={MARK_READ_DELAY.min}
                max={MARK_READ_DELAY.max}
                step={MARK_READ_DELAY.step}
                onChange={(value) => setInterfaceSetting(MARK_READ_DELAY, value)}
              />
            </div>
          }
          resetAction={
            markReadDelay !== MARK_READ_DELAY.defaultValue ? (
              <SettingResetButton
                label="mark as read delay"
                onClick={() => setInterfaceSetting(MARK_READ_DELAY, MARK_READ_DELAY.defaultValue)}
              />
            ) : null
          }
        />
      </SettingsSection>

      <SettingsSection title="Interface">
        <PercentSettingRow
          setting={CONTRAST}
          searchId="contrast"
          label="Contrast"
          description="Adjust the contrast of text and borders across the app."
        />
        <PercentSettingRow
          setting={GLASS_OPACITY}
          searchId="glass-opacity"
          label="Glass opacity"
          description="Higher values make menus, popovers and dialogs more solid."
        />
        <FontSizeRow id={searchableSetting("font-size").id} />
        <ReadingWidthRow id={searchableSetting("reading-width").id} />
      </SettingsSection>

      <SettingsSection title="Motion">
        <SettingsRow
          {...searchableSetting("panel-animations")}
          description="Set how fast panels open and close."
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={panelAnimationDurationMs} />
              <SettingSlider
                id="panel-animation-duration"
                label="Panel animation duration"
                value={panelAnimationDurationMs}
                valueLabel={`${panelAnimationDurationMs} ms`}
                min={MIN_PANEL_ANIMATION_DURATION_MS}
                max={MAX_PANEL_ANIMATION_DURATION_MS}
                step={25}
                onChange={setPanelAnimationDurationMs}
              />
            </div>
          }
          resetAction={
            panelAnimationDurationMs !== DEFAULT_PANEL_ANIMATION_DURATION_MS ? (
              <SettingResetButton
                label="panel animations"
                onClick={() => setPanelAnimationDurationMs(DEFAULT_PANEL_ANIMATION_DURATION_MS)}
              />
            ) : null
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
