import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  CircleHelpIcon,
  CircleUserRoundIcon,
  GlobeIcon,
  KeyboardIcon,
  PuzzleIcon,
  PaletteIcon,
  PlugIcon,
  Settings2Icon,
  MailIcon,
  MailCheckIcon,
  MessageSquareIcon,
  MousePointer2Icon,
  ScrollTextIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { changelogUrl } from "@otter-mail/shared/changelog";
import { openLink } from "../browser/store";
import { ScrollArea } from "~/components/ui/scroll-area";
import { gmailApi, type SettingsPane } from "../gmail/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../gmail/menu";
import { HintTooltip, IconBtn, cn } from "../gmail/ui";
import { features } from "../features";
import { useCommandHandlers } from "../keybindings/dispatch";
import {
  searchSettings,
  SETTINGS_SECTION_LABELS,
  type SettingsSearchItem,
} from "./settings-search";
import { requestProblemReport } from "../support/report-problem";

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPane, ComponentType<{ className?: string }>>
> = {
  general: Settings2Icon,
  otter: CircleUserRoundIcon,
  appearance: PaletteIcon,
  keybindings: KeyboardIcon,
  accounts: MailIcon,
  agents: MousePointer2Icon,
  browser: GlobeIcon,
  extensions: PuzzleIcon,
  integrations: PlugIcon,
};

const SETTINGS_SECTIONS = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPane[])
  .filter((id) => (id !== "browser" && id !== "extensions") || features.browser)
  .map((id) => ({
    id,
    label: SETTINGS_SECTION_LABELS[id],
    icon: SETTINGS_SECTION_ICONS[id],
  }));

/** The mail sidebar's row (Codex): 14px regular text, muted icon, rounded pill. */
const ROW =
  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-(--sidebar-row-content-inset) text-left text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-focus-ring active:bg-sidebar-row-active [&>svg]:size-4 [&>svg]:shrink-0";

const ROW_IDLE =
  "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-sidebar-foreground [&>svg]:text-sidebar-muted-foreground hover:[&>svg]:text-sidebar-foreground";

/**
 * Sidebar contents while the settings page is open: search (Otter Code's,
 * styled after ChatGPT's), the sections, then Back. While searching, the
 * results replace the sections; picking one opens its pane at that setting.
 */
export function SettingsNav({
  pane,
  onSelect,
  onBack,
}: {
  pane: SettingsPane;
  onSelect: (pane: SettingsPane, target?: string) => void;
  onBack: () => void;
}) {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const results = useMemo(() => searchSettings(query), [query]);
  const isSearching = query.trim().length > 0;
  const hasResults = results.length > 0;

  // "/" and ⌘F search settings (the Keybindings pane, mounted later, takes
  // them for its own search).
  useCommandHandlers({
    "search.focus": () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  });

  useEffect(() => {
    const result = results[activeResultIndex];
    if (!result) return;
    document
      .getElementById(`settings-search-result-${result.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, results]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setActiveResultIndex(0);
  }, []);
  const openResult = (item: SettingsSearchItem) => {
    console.log("[SettingsNav:openResult]", { id: item.id });
    clearSearch();
    onSelect(item.pane, item.targetId ?? item.id);
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && isSearching) {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResultIndex((index) => (index + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeResultIndex];
      if (result) openResult(result);
    }
  };

  return (
    <>
      <ScrollArea
        className="flex-1"
        viewportClassName="scroll-fade-y px-(--sidebar-content-inset) pb-8 pt-3"
        contentClassName="flex flex-col gap-0.5"
      >
        <h2 className="mb-1 flex h-8 items-center px-(--sidebar-row-content-inset) text-base font-semibold text-sidebar-foreground">
          Settings
        </h2>
        <div className="mb-2 flex h-9 shrink-0 items-center gap-2 rounded-full bg-foreground/[0.06] ps-3 pe-2.5 transition-colors focus-within:bg-foreground/[0.08]">
          <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveResultIndex(0);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search"
            spellCheck={false}
            aria-label="Search settings"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={isSearching && hasResults}
            aria-controls={isSearching && hasResults ? "settings-search-results" : undefined}
            aria-activedescendant={
              isSearching && results[activeResultIndex]
                ? `settings-search-result-${results[activeResultIndex].id}`
                : undefined
            }
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
          />
          {isSearching ? (
            <button
              type="button"
              aria-label="Clear settings search"
              onClick={() => {
                clearSearch();
                searchInputRef.current?.focus();
              }}
              className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full bg-sidebar-muted-foreground text-canvas outline-none hover:bg-sidebar-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <XIcon className="size-2.5" strokeWidth={3} />
            </button>
          ) : null}
        </div>
        {isSearching ? (
          hasResults ? (
            <div
              id="settings-search-results"
              role="listbox"
              aria-label="Settings search results"
              className="flex flex-col gap-0.5"
            >
              {results.map((item, index) => {
                const Icon = SETTINGS_SECTION_ICONS[item.pane];
                const active = index === activeResultIndex;
                return (
                  <button
                    key={item.id}
                    id={`settings-search-result-${item.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabIndex={-1}
                    onMouseMove={() => setActiveResultIndex(index)}
                    onClick={() => openResult(item)}
                    className={cn(
                      ROW,
                      "h-auto min-h-11 items-start py-1.5 [&>svg]:mt-0.5",
                      active
                        ? "bg-sidebar-row-hover text-sidebar-foreground [&>svg]:text-sidebar-foreground"
                        : ROW_IDLE,
                    )}
                  >
                    <Icon />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{item.title}</span>
                      <span className="block truncate text-xs text-sidebar-muted-foreground">
                        {SETTINGS_SECTION_LABELS[item.pane]}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p
              role="status"
              className="px-(--sidebar-row-content-inset) py-6 text-center text-xs text-sidebar-muted-foreground"
            >
              No settings found
            </p>
          )
        ) : (
          SETTINGS_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = section.id === pane;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  ROW,
                  active
                    ? "bg-sidebar-row-selected text-sidebar-foreground [&>svg]:text-sidebar-foreground"
                    : ROW_IDLE,
                )}
              >
                <Icon />
                <span className="truncate">{section.label}</span>
              </button>
            );
          })
        )}
      </ScrollArea>
      <div className="flex shrink-0 flex-col gap-0.5 px-(--sidebar-content-inset) pt-1 pb-(--sidebar-content-inset)">
        {features.defaultMailApp ? <DefaultMailRow /> : null}
        <div className="flex items-center gap-1">
          <button type="button" onClick={onBack} className={cn(ROW, ROW_IDLE, "min-w-0 flex-1")}>
            <ArrowLeftIcon />
            <span className="truncate">Back</span>
          </button>
          <HelpMenu />
        </div>
      </div>
    </>
  );
}

/** The ? beside Back: feedback and the changelog. */
function HelpMenu() {
  return (
    <DropdownMenu>
      <HintTooltip label="Help">
        <DropdownMenuTrigger asChild>
          <IconBtn label="Help">
            <CircleHelpIcon className="size-4" />
          </IconBtn>
        </DropdownMenuTrigger>
      </HintTooltip>
      <DropdownMenuContent side="top">
        <DropdownMenuItem icon={<MessageSquareIcon />} onSelect={requestProblemReport}>
          Send feedback
        </DropdownMenuItem>
        <DropdownMenuItem icon={<ScrollTextIcon />} onSelect={() => openLink(changelogUrl())}>
          Changelog
          <ArrowUpRightIcon className="ms-1 inline size-3.5 align-[-2px]" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Shown only while Otter Mail isn't the Mac's default mail app: asks macOS
 * (a consent dialog) and hides once granted.
 */
function DefaultMailRow() {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const refresh = async () => {
    try {
      setIsDefault((await gmailApi.getDefaultMailStatus()).isDefault);
    } catch (err) {
      console.log("[SettingsNav:defaultMailStatus] failed", { error: String(err) });
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  if (isDefault !== false) return null;
  return (
    <HintTooltip label="Use Otter Mail for email links">
      <button
        type="button"
        onClick={async () => {
          console.log("[SettingsNav:setDefaultMailApp]");
          try {
            await gmailApi.setDefaultMailApp();
          } catch (err) {
            console.log("[SettingsNav:setDefaultMailApp] failed", { error: String(err) });
          }
          void refresh();
        }}
        className={cn(ROW, ROW_IDLE)}
      >
        <MailCheckIcon />
        <span className="truncate">Set as default mail app</span>
      </button>
    </HintTooltip>
  );
}
