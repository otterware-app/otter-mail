import { browseTodoist } from "../integrations/todoist";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArchiveXIcon,
  MessageSquareIcon,
  ArrowDownCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  MailsIcon,
  CheckIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  InboxIcon,
  LayersIcon,
  ListChecksIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  MousePointer2Icon,
  PlusIcon,
  RotateCwIcon,
  ScrollTextIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SignpostIcon,
  SquarePenIcon,
  StarIcon,
  SunIcon,
  SunMoonIcon,
  Trash2Icon,
} from "lucide-react";
import { useDebouncedValue, useSearchMessages } from "./hooks";
import { getAccountColor, getAccountDisplayName } from "./account-style";
import { senderLabel } from "./address";
import { cn } from "./ui";
import { COMBINED_ACCOUNT_ID } from "./custom-views";
import { changelogUrl } from "@otter-mail/shared/changelog";
import { openLink } from "../browser/store";
import { getThemeModes } from "../theme/themePalette";
import {
  previewTheme,
  setThemeForAppearance,
  useAppThemes,
  useThemeChoice,
} from "../theme/apply-theme";
import type { GmailAccount, GmailMessageSummary, MailView } from "./types";
import { PaneIcon } from "./top-bar";
import type { SettingsPane } from "./api";
import type { KeybindingCommand } from "../keybindings/commands";
import { shortcutLabelFor, useKeybindingsState } from "../keybindings/store";
import { requestTour, startSetup } from "../onboarding/onboarding";
import { updateNow, useUpdateState } from "../updates";
import { requestProblemReport } from "../support/report-problem";
import { useProjects } from "./projects";
import { PROJECTS_SPACE } from "./spaces";
import { ViewMark } from "./view-icon";
import { requestNewProject } from "./project-menus";
import { shortcutText } from "../keybindings/keys";

/**
 * Command palette (⌘K), modeled on Otter Code's: a frosted card anchored near
 * the top, a large search field, grouped results (icon, title, optional
 * subtitle, trailing time or shortcut), submenus (Backspace goes back), and a
 * key-hint footer. Mail search runs across every account.
 */

const MAX_MAIL_RESULTS = 12;

type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: GmailAccount[];
  views: MailView[];
  selectedAccountId: string | null;
  onOpenMessage: (message: GmailMessageSummary) => void;
  /** Runs the typed text as a Gmail search in the Search mailbox. */
  onSearchMail: (query: string) => void;
  onGoToView: (viewId: string) => void;
  /** A mailbox, or PROJECTS_SPACE. */
  onSelectAccount: (accountId: string) => void;
  onOpenProject: (projectId: string) => void;
  onCompose: () => void;
  onOpenSettings: (pane?: SettingsPane) => void;
  onNewView: () => void;
  onToggleChat: () => void;
  onToggleSidebar: () => void;
  onSync: () => void;
};

type Page = "root" | "appearance" | "theme";

type PaletteItem = {
  id: string;
  icon: ReactNode;
  title: string;
  description?: string;
  /** Searchable text beyond the title (e.g. a view's mailbox). */
  keywords?: string;
  trailing?: ReactNode;
  shortcut?: string;
  checked?: boolean;
  /** Opens a submenu instead of running. */
  submenu?: Page;
  run?: () => void;
};

type PaletteGroup = { id: string; label: string; items: PaletteItem[] };

const ICON = "size-4";

function viewIcon(view: MailView): ReactNode {
  if (view.kind === "inbox") return <InboxIcon className={ICON} />;
  if (view.kind === "starred") return <StarIcon className={ICON} />;
  if (view.kind === "sent") return <SendIcon className={ICON} />;
  if (view.kind === "drafts") return <FileIcon className={ICON} />;
  if (view.kind === "important") return <BookmarkIcon className={ICON} />;
  if (view.kind === "allmail") return <MailsIcon className={ICON} />;
  if (view.kind === "junk") return <ArchiveXIcon className={ICON} />;
  if (view.kind === "trash") return <Trash2Icon className={ICON} />;
  return <LayersIcon className={ICON} />;
}

function formatResultDate(timestamp: number): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** What a match of `matchScore` or better counts as: the text names the item. */
const STRONG = 2;

/** Words of a text, for matching the start of any of them ("dark" in "Change appearance: Dark"). */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u);

/**
 * How well an item matches what's typed: 4 its title starts with it, 3 every
 * typed word starts a word of the title, 2 the same counting its description
 * and keywords (synonyms like "upgrade" for Update), 1 the text appears
 * anywhere, even mid-word; 0 not at all. Everything matches an empty query.
 */
function matchScore(item: PaletteItem, needle: string): number {
  if (!needle) return 1;
  const title = item.title.toLowerCase();
  if (title.startsWith(needle)) return 4;
  const typed = needle.split(/\s+/);
  const startsAWord = (list: string[]) => typed.every((t) => list.some((w) => w.startsWith(t)));
  if (startsAWord(words(title))) return 3;
  const rest = `${item.description ?? ""} ${item.keywords ?? ""}`;
  if (startsAWord(words(`${title} ${rest}`))) return 2;
  return `${title} ${rest.toLowerCase()}`.includes(needle) ? 1 : 0;
}

function Dot({ color }: { color: string }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded bg-foreground/[0.08] px-1 font-sans text-xs font-medium text-foreground [&_svg]:size-3">
      {children}
    </kbd>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  accounts,
  views,
  selectedAccountId,
  onOpenMessage,
  onSearchMail,
  onGoToView,
  onSelectAccount,
  onOpenProject,
  onCompose,
  onOpenSettings,
  onNewView,
  onToggleChat,
  onToggleSidebar,
  onSync,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page>("root");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const themeChoice = useThemeChoice();
  const themes = useAppThemes();
  const update = useUpdateState();
  const [scheme, setScheme] = useState<"system" | "light" | "dark">("system");

  // Each opening starts fresh, set while rendering so the first frame
  // doesn't show the page or search from last time.
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setQuery("");
      setPage("root");
      setHighlight(0);
    }
  }

  useEffect(() => {
    if (!open) return;
    void window.desktopBridge.nativeTheme
      .getInfo()
      .then((info) => setScheme(info.themeSource))
      .catch(() => {});
  }, [open]);

  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [open, page]);

  const debouncedQuery = useDebouncedValue(query.trim(), 150);
  const searchResults = useSearchMessages(page === "root" ? debouncedQuery : "", null, open);
  const mailResults = (searchResults.data?.pages[0]?.messages ?? []).slice(0, MAX_MAIL_RESULTS);

  const close = () => onOpenChange(false);
  const projects = useProjects().data;

  // Shortcut labels follow the live keybindings (Settings › Keybindings).
  const { resolved: keybindings } = useKeybindingsState();
  const groups: PaletteGroup[] = useMemo(() => {
    const sc = (command: KeybindingCommand) => shortcutLabelFor(keybindings, command) ?? undefined;
    const jump = (digit: number) => sc(`mailbox.jump.${digit}` as KeybindingCommand);
    const needle = query.trim().toLowerCase();
    // Best first within each group (a stable sort keeps the list's own order on ties).
    const filter = (list: PaletteGroup[]) =>
      list
        .map((g) => ({
          ...g,
          items: g.items
            .map((item) => ({ item, score: matchScore(item, needle) }))
            .filter((m) => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((m) => m.item),
        }))
        .filter((g) => g.items.length > 0);

    if (page === "appearance") {
      const options = [
        { id: "system", title: "System", icon: <MonitorIcon className={ICON} /> },
        { id: "light", title: "Light", icon: <SunIcon className={ICON} /> },
        { id: "dark", title: "Dark", icon: <MoonIcon className={ICON} /> },
      ] as const;
      return filter([
        {
          id: "appearance",
          label: "Change appearance",
          items: options.map((o) => ({
            id: `appearance:${o.id}`,
            icon: o.icon,
            title: o.title,
            checked: scheme === o.id,
            run: () => void window.desktopBridge.nativeTheme.setThemeSource(o.id),
          })),
        },
      ]);
    }

    if (page === "theme") {
      return filter([
        {
          id: "theme",
          label: "Change theme",
          // A theme of your own may have one palette only: it takes that side.
          items: themes.map((t) => ({
            id: `theme:${t.id}`,
            icon: <PaletteIcon className={ICON} />,
            title: t.label,
            checked: getThemeModes(t).every((mode) => themeChoice[mode] === t.id),
            run: () => {
              for (const mode of getThemeModes(t)) setThemeForAppearance(mode, t.id);
            },
          })),
        },
      ]);
    }

    const actions: PaletteItem[] = [
      {
        id: "todoist",
        icon: <CheckIcon className={ICON} />,
        title: "Browse Todoist tasks",
        keywords: "tasks projects complete todo",
        run: browseTodoist,
      },
      {
        id: "compose",
        icon: <SquarePenIcon className={ICON} />,
        title: "New message",
        shortcut: sc("compose.new"),
        run: onCompose,
      },
      { id: "sync", icon: <RotateCwIcon className={ICON} />, title: "Sync now", run: onSync },
      {
        id: "chat",
        icon: <MousePointer2Icon className={ICON} />,
        title: "Toggle agent panel",
        keywords: "chat agent assistant ai claude codex hermes openclaw",
        shortcut: sc("agent.toggle"),
        run: onToggleChat,
      },
      {
        id: "sidebar",
        icon: <PaneIcon side="left" open className={ICON} />,
        title: "Toggle sidebar",
        shortcut: sc("sidebar.toggle"),
        run: onToggleSidebar,
      },
      {
        id: "appearance",
        icon: <SunMoonIcon className={ICON} />,
        title: "Change appearance",
        keywords: "dark light system mode",
        submenu: "appearance",
      },
      {
        id: "theme",
        icon: <PaletteIcon className={ICON} />,
        title: "Change theme",
        keywords: "colors palette",
        submenu: "theme",
      },
      {
        id: "new-view",
        icon: <PlusIcon className={ICON} />,
        title: "New view",
        keywords: "view filter",
        run: onNewView,
      },
      {
        id: "new-project",
        icon: <FolderPlusIcon className={ICON} />,
        title: "New project",
        run: () => requestNewProject({ open: true }),
      },
      {
        id: "settings",
        icon: <SettingsIcon className={ICON} />,
        title: "Settings",
        shortcut: shortcutText("mod+,"),
        run: () => onOpenSettings(),
      },
      {
        id: "report-problem",
        icon: <MessageSquareIcon className={ICON} />,
        title: "Send feedback",
        keywords: "feedback feature request bug issue support diagnostics github",
        run: requestProblemReport,
      },
      {
        id: "changelog",
        icon: <ScrollTextIcon className={ICON} />,
        title: "Changelog",
        keywords: "what's new release notes new version",
        run: () => openLink(changelogUrl()),
      },
      ...(update && update.status !== "disabled"
        ? [
            {
              id: "update",
              icon: <ArrowDownCircleIcon className={ICON} />,
              title:
                update.status === "downloaded"
                  ? `Restart to update to ${update.availableVersion}`
                  : "Update Otter Mail",
              description: `Version ${update.currentVersion}`,
              keywords: "upgrade install restart new version check for updates",
              run: updateNow,
            },
          ]
        : []),
      {
        id: "tour",
        icon: <SignpostIcon className={ICON} />,
        title: "Take the tour",
        keywords: "help guide onboarding getting started",
        run: requestTour,
      },
      {
        id: "setup",
        icon: <ListChecksIcon className={ICON} />,
        title: "Run setup again",
        keywords: "welcome onboarding getting started",
        run: () => startSetup(),
      },
    ];

    const mailboxes: PaletteItem[] = [
      ...(accounts.length > 1
        ? [
            {
              id: `mailbox:${COMBINED_ACCOUNT_ID}`,
              icon: <LayersIcon className={ICON} />,
              title: "All mailboxes",
              shortcut: jump(1),
              checked: selectedAccountId === COMBINED_ACCOUNT_ID,
              run: () => onSelectAccount(COMBINED_ACCOUNT_ID),
            },
          ]
        : []),
      ...accounts.map((account, i) => ({
        id: `mailbox:${account.id}`,
        icon: <Dot color={getAccountColor(account)} />,
        title: getAccountDisplayName(account),
        description: account.email,
        shortcut: jump(accounts.length > 1 ? i + 2 : 1),
        checked: selectedAccountId === account.id,
        run: () => onSelectAccount(account.id),
      })),
    ];

    // Views are spaces; All mailboxes' folders only when 2+ accounts are
    // connected (matches the sidebar).
    const viewItems: PaletteItem[] = [
      ...views
        .filter((v) => v.kind === "custom")
        .map((view) => ({
          id: `view:${view.id}`,
          icon: <ViewMark view={view} className="size-4 text-[13px]" />,
          title: view.name,
          keywords: "view space",
          checked: selectedAccountId === view.id,
          run: () => onSelectAccount(view.id),
        })),
      ...(accounts.length > 1
        ? views
            .filter((v) => v.kind !== "custom")
            .map((view) => ({
              id: `view:${view.id}`,
              icon: viewIcon(view),
              title: view.name,
              keywords: "go to view",
              run: () => onGoToView(view.id),
            }))
        : []),
    ];

    const projectItems: PaletteItem[] = [
      {
        id: "projects",
        icon: <FolderClosedIcon className={ICON} />,
        title: "All projects",
        checked: selectedAccountId === PROJECTS_SPACE,
        run: () => onSelectAccount(PROJECTS_SPACE),
      },
      ...(projects ?? [])
        .filter((p) => p.status === "active")
        .map((project) => ({
          id: `project:${project.id}`,
          icon: <FolderIcon className={ICON} />,
          title: project.name,
          keywords: "project",
          run: () => onOpenProject(project.id),
        })),
    ];

    const staticGroups = filter([
      { id: "actions", label: "Actions", items: actions },
      { id: "mailboxes", label: "Mailboxes", items: mailboxes },
      { id: "views", label: "Views", items: viewItems },
      { id: "projects", label: "Projects", items: projectItems },
    ]);

    const mail: PaletteItem[] = needle
      ? mailResults.map((message) => {
          const account = accounts.find((a) => a.id === message.accountId);
          return {
            id: `message:${message.accountId}:${message.id}`,
            icon: account ? (
              <Dot color={getAccountColor(account)} />
            ) : (
              <InboxIcon className={ICON} />
            ),
            title: senderLabel(message.fromName, message.fromEmail, message.accountId),
            description: message.subject || "(no subject)",
            trailing: formatResultDate(message.date),
            run: () => onOpenMessage(message),
          };
        })
      : [];

    const mailGroup = mail.length > 0 ? [{ id: "mail", label: "Mail", items: mail }] : [];
    if (!needle) return staticGroups;

    // Handing the text to the Search mailbox (Gmail's own search, every
    // operator), like pressing Enter in Gmail's search bar.
    const searchGroup = {
      id: "search",
      label: "Search",
      items: [
        {
          id: "search-mail",
          icon: <SearchIcon className={ICON} />,
          title: `Search mail for “${query.trim()}”`,
          run: () => onSearchMail(query.trim()),
        },
      ],
    };
    // Commands, mailboxes and views the text clearly names come first (Enter
    // runs the best), then the search, one ↓ away, and the mail it finds.
    // Text that reads as a search (an operator, an address, a quote) or names
    // nothing searches first. Mail, arriving later, lands below both, so the
    // rows above it never move.
    const best = (g: PaletteGroup) => matchScore(g.items[0]!, needle);
    const strong = staticGroups.filter((g) => best(g) >= STRONG).sort((a, b) => best(b) - best(a));
    const weak = staticGroups.filter((g) => best(g) < STRONG);
    const searchFirst = /[:@"]/.test(needle) || strong.length === 0;
    return searchFirst
      ? [searchGroup, ...strong, ...mailGroup, ...weak]
      : [...strong, searchGroup, ...mailGroup, ...weak];
  }, [
    keybindings,
    themes,
    page,
    query,
    scheme,
    themeChoice,
    update,
    accounts,
    views,
    selectedAccountId,
    mailResults,
    onCompose,
    onSync,
    onToggleChat,
    onToggleSidebar,
    onNewView,
    onOpenSettings,
    onSelectAccount,
    onOpenProject,
    projects,
    onGoToView,
    onOpenMessage,
    onSearchMail,
  ]);

  const flat = groups.flatMap((g) => g.items);
  const clamped = Math.min(highlight, Math.max(flat.length - 1, 0));

  // A fresh list starts at its top; the theme list starts on the current
  // theme. Set while rendering: a frame on another row would preview it.
  const listKey = `${page}\u0000${query}`;
  const [highlightFor, setHighlightFor] = useState(listKey);
  if (highlightFor !== listKey) {
    setHighlightFor(listKey);
    setHighlight(
      page === "theme" && query === ""
        ? Math.max(
            0,
            flat.findIndex((i) => i.checked),
          )
        : 0,
    );
  }

  // Changing theme: the highlighted one shows (here only, nothing saved)
  // until Enter or a click picks it; leaving or closing puts yours back.
  const previewId =
    open && page === "theme" ? (flat[clamped]?.id.replace(/^theme:/, "") ?? null) : null;
  useEffect(() => {
    if (!previewId) return;
    previewTheme(previewId);
    return () => previewTheme(null);
  }, [previewId]);

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [clamped]);

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.submenu) {
      console.log("[CommandPalette:submenu]", { page: item.submenu });
      setQuery("");
      setPage(item.submenu);
      return;
    }
    console.log("[CommandPalette:run]", { id: item.id });
    close();
    item.run?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (flat.length ? (Math.min(h, flat.length - 1) + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        flat.length ? (Math.min(h, flat.length - 1) - 1 + flat.length) % flat.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(flat[clamped]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Backspace" && query === "" && page !== "root") {
      e.preventDefault();
      setPage("root");
    }
  };

  if (!open) return null;

  const searching = page === "root" && debouncedQuery !== "" && searchResults.isLoading;
  const placeholder =
    page === "appearance"
      ? "Change appearance…"
      : page === "theme"
        ? "Change theme…"
        : "Search mail or type a command…";
  let index = -1;

  return createPortal(
    <div className="no-drag fixed inset-0 z-[100]" role="presentation">
      {/* Backdrop: clear, like Linear's; a click outside closes. */}
      <div className="absolute inset-0" onPointerDown={close} aria-hidden />
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center px-4 pt-[10vh]">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          className={cn(
            "pointer-events-auto relative flex max-h-105 w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-foreground/10 text-foreground shadow-[0_24px_64px_-24px_rgb(0_0_0/45%)] transition-[background-color] dark:shadow-[0_24px_64px_-24px_rgb(0_0_0/80%)]",
            // Changing theme: a see-through window, so the preview shows behind it.
            page === "theme" ? "bg-popover/70 backdrop-blur-md" : "bg-popover",
          )}
        >
          {/* Search field */}
          <div className="relative flex h-12 shrink-0 items-center gap-2.5 px-4">
            <SearchIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
            <input
              ref={inputRef}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label="Search commands and mail"
              className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-placeholder"
            />
          </div>

          {/* Results */}
          <div
            ref={listRef}
            className="min-h-0 flex-1 scroll-py-1.5 overflow-y-auto border-t border-border/50 p-1.5"
          >
            {flat.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {searching ? "Searching…" : "No matching commands or mail."}
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.id} className="[&+&]:mt-1.5" role="group" aria-label={group.label}>
                  <div className="px-2.5 pt-2 pb-1 text-[13px] text-muted-foreground">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    index += 1;
                    const i = index;
                    const active = i === clamped;
                    return (
                      <div
                        key={item.id}
                        role="option"
                        aria-selected={active}
                        data-index={i}
                        onMouseMove={() => setHighlight(i)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => execute(item)}
                        className={cn(
                          "flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm outline-none [&_svg:not([class*='text-'])]:text-muted-foreground",
                          active && "bg-foreground/[0.07] text-foreground",
                        )}
                      >
                        {item.icon}
                        {item.description ? (
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-sm text-foreground">{item.title}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {item.description}
                            </span>
                          </span>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                            {item.title}
                          </span>
                        )}
                        {item.checked ? (
                          <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                        ) : null}
                        {item.trailing ? (
                          <span className="min-w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground/70">
                            {item.trailing}
                          </span>
                        ) : null}
                        {item.shortcut ? (
                          <kbd className="ms-auto shrink-0 font-sans text-xs font-medium tracking-widest text-secondary-label">
                            {item.shortcut}
                          </kbd>
                        ) : null}
                        {item.submenu ? (
                          <ChevronRightIcon className="-me-0.5 ms-auto size-4 shrink-0 text-muted-foreground/70" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {/* Key hints */}
          <div className="flex shrink-0 items-center gap-3 border-t border-border/50 px-4 py-2.5 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span className="ms-1">Navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Enter</Kbd>
              <span className="ms-1">{flat[clamped]?.submenu ? "Open" : "Select"}</span>
            </span>
            {page !== "root" ? (
              <span className="flex items-center gap-1">
                <Kbd>Backspace</Kbd>
                <span className="ms-1">Back</span>
              </span>
            ) : null}
            <span className="flex items-center gap-1">
              <Kbd>Esc</Kbd>
              <span className="ms-1">Close</span>
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
