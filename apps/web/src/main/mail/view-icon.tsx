/**
 * A view's mark in the sidebar (and wherever it's named): an icon or an emoji,
 * in a color, picked in the view's dialog; its initial until one is picked.
 * Views keep the pick as `icon` (an icon's key, or the emoji itself) and
 * `color` (shared's view-marks.ts).
 */

import { useState } from "react";
import {
  ArchiveIcon,
  AsteriskIcon,
  AtSignIcon,
  BanknoteIcon,
  BellIcon,
  BookIcon,
  BookmarkIcon,
  BriefcaseIcon,
  BuildingIcon,
  CalendarCheckIcon,
  CircleCheckIcon,
  ClipboardListIcon,
  CodeIcon,
  CoffeeIcon,
  CreditCardIcon,
  FlagIcon,
  FolderIcon,
  GiftIcon,
  GraduationCapIcon,
  HeartIcon,
  HomeIcon,
  InboxIcon,
  LayersIcon,
  LightbulbIcon,
  ListChecksIcon,
  MailIcon,
  MessageSquareIcon,
  MusicIcon,
  NewspaperIcon,
  PlaneIcon,
  QuoteIcon,
  ReceiptIcon,
  SearchIcon,
  ShoppingBagIcon,
  SparklesIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  UsersIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

import { VIEW_COLORS, type ViewIconKey } from "@otter-mail/shared/view-marks";
import { cn } from "./ui";
import type { MailView } from "./types";

/** Each icon key's drawing (shared's VIEW_ICON_KEYS, which the agents offer too). */
export const VIEW_ICONS: Record<ViewIconKey, LucideIcon> = {
  star: StarIcon,
  bookmark: BookmarkIcon,
  heart: HeartIcon,
  flag: FlagIcon,
  zap: ZapIcon,
  asterisk: AsteriskIcon,
  bell: BellIcon,
  layers: LayersIcon,
  inbox: InboxIcon,
  archive: ArchiveIcon,
  folder: FolderIcon,
  tag: TagIcon,
  mail: MailIcon,
  at: AtSignIcon,
  message: MessageSquareIcon,
  users: UsersIcon,
  check: CircleCheckIcon,
  tasks: ListChecksIcon,
  clipboard: ClipboardListIcon,
  calendar: CalendarCheckIcon,
  briefcase: BriefcaseIcon,
  building: BuildingIcon,
  receipt: ReceiptIcon,
  money: BanknoteIcon,
  card: CreditCardIcon,
  shopping: ShoppingBagIcon,
  gift: GiftIcon,
  plane: PlaneIcon,
  home: HomeIcon,
  coffee: CoffeeIcon,
  news: NewspaperIcon,
  book: BookIcon,
  school: GraduationCapIcon,
  code: CodeIcon,
  quote: QuoteIcon,
  search: SearchIcon,
  idea: LightbulbIcon,
  sparkles: SparklesIcon,
  music: MusicIcon,
  sun: SunIcon,
};

const VIEW_EMOJI = [
  "⭐️",
  "📌",
  "❤️",
  "🚩",
  "⚡️",
  "🔔",
  "📥",
  "📦",
  "🗂️",
  "🏷️",
  "✉️",
  "💬",
  "👥",
  "✅",
  "📋",
  "📅",
  "💼",
  "🏢",
  "🧾",
  "💰",
  "💳",
  "🛍️",
  "🎁",
  "✈️",
  "🏠",
  "☕️",
  "📰",
  "📚",
  "🎓",
  "💻",
  "💡",
  "✨",
  "🎵",
  "☀️",
  "🌱",
  "🐾",
  "⚽️",
  "🎨",
  "🔧",
  "🦦",
];

const COLORS = Object.values(VIEW_COLORS);

type Mark = Pick<MailView, "name" | "icon" | "color">;

/** A view's mark: its icon (in its color), its emoji, or its initial. */
export function ViewMark({ view, className }: { view: Mark; className?: string }) {
  const Icon = view.icon ? VIEW_ICONS[view.icon as ViewIconKey] : undefined;
  if (Icon) {
    return (
      <Icon
        className={cn("size-4.5", className)}
        style={view.color ? { color: view.color } : undefined}
      />
    );
  }
  if (view.icon) {
    return (
      <span aria-hidden className={cn("text-[17px] leading-none", className)}>
        {view.icon}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 items-center justify-center rounded-md border border-sidebar-muted-foreground/40 text-[11px] font-semibold uppercase leading-none",
        className,
      )}
      style={view.color ? { color: view.color, borderColor: view.color } : undefined}
    >
      {view.name.trim()[0] ?? "?"}
    </span>
  );
}

const CELL =
  "flex size-8 items-center justify-center rounded-lg outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring";

/** Emoji or icon, then (for an icon) its color; Remove goes back to the initial. */
export function ViewIconPicker({
  icon,
  color,
  onChange,
}: {
  icon: string | null;
  color: string | null;
  onChange: (pick: { icon: string | null; color: string | null }) => void;
}) {
  const [tab, setTab] = useState<"icon" | "emoji">(
    icon && !(icon in VIEW_ICONS) ? "emoji" : "icon",
  );
  return (
    <div className="rounded-xl border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-accent-surface p-0.5">
          {(["emoji", "icon"] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "h-7 rounded-md px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                tab === id ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {id === "emoji" ? "Emoji" : "Icon"}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {icon ? (
          <button
            type="button"
            onClick={() => onChange({ icon: null, color })}
            className="h-7 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-10 gap-0.5">
        {tab === "icon"
          ? Object.entries(VIEW_ICONS).map(([key, Icon]) => (
              <button
                key={key}
                type="button"
                aria-label={key}
                aria-pressed={icon === key}
                onClick={() => onChange({ icon: key, color })}
                className={cn(CELL, icon === key && "bg-accent-surface")}
              >
                <Icon className="size-4.5" style={color ? { color } : undefined} />
              </button>
            ))
          : VIEW_EMOJI.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-pressed={icon === emoji}
                onClick={() => onChange({ icon: emoji, color })}
                className={cn(CELL, "text-[17px]", icon === emoji && "bg-accent-surface")}
              >
                {emoji}
              </button>
            ))}
      </div>
      {tab === "icon" ? (
        <div className="mt-3 flex items-center gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
              onClick={() => onChange({ icon, color: color === c ? null : c })}
              className={cn(
                "size-5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                color === c && "ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover",
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
