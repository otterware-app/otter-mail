import { useLatest } from "../use-latest";
/**
 * The Search mailbox's header, modelled on Gmail's: a search bar that runs on
 * Enter (suggestions while typing: recent searches, people, instant matches
 * from this Mac), a row of filter chips, and "Advanced search". Chips and the
 * form only edit operators in the query text — the text is what runs, through
 * Gmail's own search, so every Gmail operator works.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  ClockIcon,
  PaperclipIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import type { GmailAccount, GmailMessageSummary } from "./types";
import { capabilitiesOf } from "./capabilities";
import { senderLabel } from "./address";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Btn, HintTooltip, IconBtn, cn } from "./ui";
import { useSearchMessages, useSuggestContacts } from "./hooks";
import {
  DATE_WITHIN,
  EMPTY_ADVANCED,
  SEARCH_IN,
  TIME_PRESETS,
  advancedFromQuery,
  clearDates,
  forgetSearch,
  freeText,
  getOperator,
  hasToken,
  queryFromAdvanced,
  recentSearches,
  rememberSearch,
  setOperator,
  timeLabel,
  toggleToken,
  type AdvancedFields,
} from "./gmail-query";
import { isTypingTarget } from "./keyboard";

const FIELD =
  "h-7.5 w-full min-w-0 rounded-lg border border-input bg-canvas px-2.5 text-sm text-foreground shadow-xs/5 outline-none placeholder:text-placeholder focus-visible:border-focus-ring focus-visible:ring-[3px] focus-visible:ring-focus-ring/24 dark:bg-input/32";

const CHIP =
  "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

function chipClass(active: boolean) {
  return cn(
    CHIP,
    active
      ? "border-transparent bg-accent-surface text-foreground"
      : "border-border/60 text-muted-foreground hover:bg-accent-surface/60 hover:text-foreground",
  );
}

// ---------------------------------------------------------------------------
// Suggestions under the search bar
// ---------------------------------------------------------------------------

type Suggestion =
  | { kind: "search"; query: string }
  | { kind: "recent"; query: string }
  | { kind: "person"; name: string; email: string }
  | { kind: "message"; message: GmailMessageSummary };

function useSuggestions(draft: string, accountIds: string[], open: boolean): Suggestion[] {
  const text = draft.trim();
  const words = freeText(text);
  const contacts = useSuggestContacts(words, open && words.length > 1);
  // Instant matches from this Mac, like Gmail's top results while you type.
  const local = useSearchMessages(
    words,
    accountIds.length === 1 ? accountIds[0] : null,
    open && words.length > 1,
  );
  return useMemo(() => {
    const recent = recentSearches();
    if (!text) return recent.map((query) => ({ kind: "recent" as const, query }));
    const lower = text.toLowerCase();
    return [
      { kind: "search" as const, query: text },
      ...recent
        .filter((r) => r.toLowerCase().includes(lower) && r !== text)
        .slice(0, 3)
        .map((query) => ({ kind: "recent" as const, query })),
      ...(contacts.data ?? []).slice(0, 3).map((c) => ({ kind: "person" as const, ...c })),
      ...(local.data?.pages[0]?.messages ?? [])
        .slice(0, 4)
        .map((message) => ({ kind: "message" as const, message })),
    ];
  }, [text, contacts.data, local.data]);
}

function SuggestionRow({
  suggestion,
  highlighted,
  onPick,
  onForget,
  onHover,
}: {
  suggestion: Suggestion;
  highlighted: boolean;
  onPick: () => void;
  onForget: () => void;
  onHover: () => void;
}) {
  const base = cn(
    "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm",
    highlighted && "bg-accent-surface",
  );
  const body = (() => {
    switch (suggestion.kind) {
      case "search":
        return (
          <>
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              Search mail for <span className="font-medium">“{suggestion.query}”</span>
            </span>
          </>
        );
      case "recent":
        return (
          <>
            <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{suggestion.query}</span>
            <span
              role="button"
              tabIndex={-1}
              aria-label="Remove from recent searches"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onForget();
              }}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground/70 hover:text-foreground"
            >
              <XIcon className="size-3" />
            </span>
          </>
        );
      case "person":
        return (
          <>
            <UserIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {suggestion.name ? <span className="font-medium">{suggestion.name} </span> : null}
              <span className="text-muted-foreground">{suggestion.email}</span>
            </span>
          </>
        );
      case "message":
        return (
          <>
            <span className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{suggestion.message.subject || "(no subject)"}</span>
              <span className="text-muted-foreground">
                {" "}
                —{" "}
                {senderLabel(
                  suggestion.message.fromName,
                  suggestion.message.fromEmail,
                  suggestion.message.accountId,
                )}
              </span>
            </span>
          </>
        );
    }
  })();
  return (
    <div
      role="option"
      aria-selected={highlighted}
      className={base}
      onMouseMove={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced search (Gmail's "Show search options")
// ---------------------------------------------------------------------------

function AdvancedSearch({
  query,
  onSearch,
  onClose,
}: {
  query: string;
  onSearch: (q: string) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<AdvancedFields>(() => advancedFromQuery(query));
  const set = <K extends keyof AdvancedFields>(key: K, value: AdvancedFields[K]) =>
    setF((prev) => ({ ...prev, [key]: value }));
  const built = queryFromAdvanced(f);
  const row = (label: string, control: ReactNode) => (
    <label className="grid gap-1 text-sm @min-[30rem]/adv:grid-cols-[7rem_minmax(0,1fr)] @min-[30rem]/adv:items-center @min-[30rem]/adv:gap-3">
      <span className="text-muted-foreground">{label}</span>
      {control}
    </label>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (built) onSearch(built);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="@container/adv dropdown-glass absolute inset-x-3 top-[calc(var(--workspace-topbar-height)-2px)] z-30 flex max-h-[70vh] flex-col gap-2.5 overflow-y-auto rounded-xl p-4 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
    >
      {row(
        "From",
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          className={FIELD}
          value={f.from}
          onChange={(e) => set("from", e.target.value)}
        />,
      )}
      {row(
        "To",
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={FIELD}
          value={f.to}
          onChange={(e) => set("to", e.target.value)}
        />,
      )}
      {row(
        "Subject",
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={FIELD}
          value={f.subject}
          onChange={(e) => set("subject", e.target.value)}
        />,
      )}
      {row(
        "Has the words",
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={FIELD}
          value={f.hasWords}
          onChange={(e) => set("hasWords", e.target.value)}
        />,
      )}
      {row(
        "Doesn't have",
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={FIELD}
          value={f.doesntHave}
          onChange={(e) => set("doesntHave", e.target.value)}
        />,
      )}
      {row(
        "Size",
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Select
            value={f.sizeOp}
            onValueChange={(v) => set("sizeOp", v as AdvancedFields["sizeOp"])}
          >
            <SelectTrigger size="small" className="w-28 shrink-0" aria-label="Size comparison">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="larger">greater than</SelectItem>
              <SelectItem value="smaller">less than</SelectItem>
            </SelectContent>
          </Select>
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={cn(FIELD, "w-auto min-w-24 flex-1")}
            inputMode="decimal"
            value={f.size}
            onChange={(e) => set("size", e.target.value.replace(/[^\d.]/g, ""))}
            aria-label="Size"
          />
          <Select
            value={f.sizeUnit}
            onValueChange={(v) => set("sizeUnit", v as AdvancedFields["sizeUnit"])}
          >
            <SelectTrigger size="small" className="w-18 shrink-0" aria-label="Size unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MB">MB</SelectItem>
              <SelectItem value="KB">KB</SelectItem>
              <SelectItem value="bytes">Bytes</SelectItem>
            </SelectContent>
          </Select>
        </div>,
      )}
      {row(
        "Date within",
        <div className="flex min-w-0 flex-wrap gap-1.5">
          <Select value={String(f.withinDays)} onValueChange={(v) => set("withinDays", Number(v))}>
            <SelectTrigger size="small" className="w-28 shrink-0" aria-label="Date range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_WITHIN.map((d) => (
                <SelectItem key={d.days} value={String(d.days)}>
                  {d.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            type="date"
            className={cn(FIELD, "w-auto min-w-24 flex-1")}
            value={f.withinDate}
            onChange={(e) => set("withinDate", e.target.value)}
            aria-label="Date"
          />
        </div>,
      )}
      {row(
        "Search",
        <Select
          value={f.searchIn || "all"}
          onValueChange={(v) => set("searchIn", v === "all" ? "" : v)}
        >
          <SelectTrigger size="small" className="w-full" aria-label="Search in">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SEARCH_IN.map((s) => (
              <SelectItem key={s.label} value={s.value || "all"}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>,
      )}
      <div className="flex flex-wrap items-center gap-4 text-sm @min-[30rem]/adv:pl-[8.75rem]">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            type="checkbox"
            checked={f.hasAttachment}
            onChange={(e) => set("hasAttachment", e.target.checked)}
          />
          Has attachment
        </label>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            type="checkbox"
            checked={f.excludeChats}
            onChange={(e) => set("excludeChats", e.target.checked)}
          />
          Don't include chats
        </label>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <code className="min-w-0 truncate font-mono text-2xs text-muted-foreground" title={built}>
          {built}
        </code>
        <div className="flex shrink-0 gap-1.5">
          <Btn size="sm" variant="ghost" onClick={() => setF(EMPTY_ADVANCED)}>
            Clear
          </Btn>
          <Btn size="sm" variant="primary" type="submit" disabled={!built}>
            Search
          </Btn>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** "From ▾" / "To ▾": a person operator, typed into a small menu. */
function PersonChip({
  label,
  operator,
  query,
  onSearch,
}: {
  label: string;
  operator: "from" | "to";
  query: string;
  onSearch: (q: string) => void;
}) {
  const current = getOperator(query, operator);
  const [value, setValue] = useState(current ?? "");
  const contacts = useSuggestContacts(value, value.trim().length > 1);
  return (
    <DropdownMenu onOpenChange={(open) => open && setValue(current ?? "")}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(current !== null)}>
          {current ? `${label}: ${current}` : label}
          <span aria-hidden className="text-muted-foreground/70">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 p-2">
        <input
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          className={FIELD}
          placeholder={operator === "from" ? "Sender name or email" : "Recipient name or email"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onSearch(setOperator(query, operator, value));
          }}
        />
        {(contacts.data ?? []).slice(0, 5).map((c) => (
          <DropdownMenuItem
            key={c.email}
            onSelect={() => onSearch(setOperator(query, operator, c.email))}
          >
            <span className="min-w-0 truncate">
              {c.name ? `${c.name} · ` : ""}
              <span className="text-muted-foreground">{c.email}</span>
            </span>
          </DropdownMenuItem>
        ))}
        {current ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSearch(setOperator(query, operator, null))}>
              Clear {label.toLowerCase()}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TimeChip({ query, onSearch }: { query: string; onSearch: (q: string) => void }) {
  const current = timeLabel(query);
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const custom = () => {
    let q = clearDates(query);
    if (after) q = setOperator(q, "after", after.replace(/-/g, "/"));
    if (before) q = setOperator(q, "before", before.replace(/-/g, "/"));
    onSearch(q);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(current !== null)}>
          {current ?? "Any time"}
          <span aria-hidden className="text-muted-foreground/70">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuItem onSelect={() => onSearch(clearDates(query))}>Any time</DropdownMenuItem>
        {TIME_PRESETS.map((p) => (
          <DropdownMenuItem
            key={p.value}
            onSelect={() => onSearch(`${clearDates(query)} ${p.value}`.trim())}
          >
            {p.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="flex flex-col gap-1.5 p-2" onKeyDown={(e) => e.stopPropagation()}>
          <span className="text-xs text-muted-foreground">Custom range</span>
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            type="date"
            className={FIELD}
            value={after}
            onChange={(e) => setAfter(e.target.value)}
            aria-label="After"
          />
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            type="date"
            className={FIELD}
            value={before}
            onChange={(e) => setBefore(e.target.value)}
            aria-label="Before"
          />
          <Btn size="xs" variant="outline" disabled={!after && !before} onClick={custom}>
            Apply
          </Btn>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScopeChip({
  accounts,
  scope,
  onScope,
}: {
  accounts: GmailAccount[];
  scope: string[];
  onScope: (accountIds: string[]) => void;
}) {
  if (accounts.length < 2) return null;
  const all = scope.length === accounts.length;
  const label = all
    ? "All accounts"
    : (accounts.find((a) => a.id === scope[0])?.email ?? "Account");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={chipClass(!all)}>
          {label}
          <span aria-hidden className="text-muted-foreground/70">
            ▾
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => onScope(accounts.map((a) => a.id))}>
          All accounts
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {accounts.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => onScope([a.id])}>
            {a.email}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function SearchHeader({
  headerLeading,
  headerTrailing,
  query,
  onSearch,
  onExit,
  onOpenMessage,
  accounts,
  scope,
  onScope,
  estimate,
  offline,
  loading,
  focusRef,
  draft: keptDraft,
  base,
  onClear,
  onDraftChange,
  messageOpen,
}: {
  headerLeading?: ReactNode;
  headerTrailing?: ReactNode;
  /** The query that ran (the results on screen). */
  query: string;
  onSearch: (q: string) => void;
  /** Leave the Search mailbox (Escape once the search is empty). */
  onExit: () => void;
  onOpenMessage: (message: GmailMessageSummary) => void;
  accounts: GmailAccount[];
  scope: string[];
  onScope: (accountIds: string[]) => void;
  estimate: number | null;
  offline: boolean;
  loading: boolean;
  focusRef: RefObject<HTMLInputElement | null>;
  /** Unrun text kept from the last visit; handed back when the header unmounts. */
  draft: string;
  /** The parent view's operators (`in:inbox`): what clearing leaves behind. */
  base: string;
  /** Empties the query (back to just `base`). */
  onClear: () => void;
  onDraftChange: (draft: string) => void;
  messageOpen: boolean;
}) {
  const [draft, setDraft] = useState(keptDraft || query);
  const [suggesting, setSuggesting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [, forceRecent] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const lastQueryRef = useRef(query);
  useEffect(() => {
    if (lastQueryRef.current === query) return;
    lastQueryRef.current = query;
    setDraft(query || (base ? `${base} ` : ""));
  }, [query, base]);

  // Leaving for another mailbox keeps what was typed (the sidebar shows a dot).
  const draftRef = useLatest(draft);
  const onDraftChangeRef = useLatest(onDraftChange);
  useEffect(() => () => onDraftChangeRef.current(draftRef.current), [draftRef, onDraftChangeRef]);

  // Escape: the first clears the search, the next (already empty) returns to
  // the mailbox you came from.
  const escape = () => {
    if (query || draftRef.current.trim() !== base) {
      console.log("[SearchHeader:clear]");
      setDraft(base ? `${base} ` : "");
      setSuggesting(false);
      setAdvancedOpen(false);
      onClear();
    } else onExit();
  };
  const escapeRef = useLatest(escape);
  const messageOpenRef = useLatest(messageOpen);
  // The same with focus outside the bar, when no message is open (Escape
  // closes the reader first).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isTypingTarget(e)) return;
      if (messageOpenRef.current) return;
      if (document.querySelector('[role="menu"]')) return;
      e.preventDefault();
      escapeRef.current();
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [escapeRef, messageOpenRef]);

  const suggestions = useSuggestions(draft, scope, suggesting);
  // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  useEffect(() => setHighlight(0), [draft]);
  // Important is Gmail's sorting: offered while a mailbox searched has it.
  const sortsImportant = accounts.some((a) => scope.includes(a.id) && capabilitiesOf(a).categories);

  const run = (q: string) => {
    const text = q.trim();
    if (!text) return;
    console.log("[SearchHeader:search]", { length: text.length });
    rememberSearch(text);
    setSuggesting(false);
    setAdvancedOpen(false);
    setDraft(text);
    onSearch(text);
    focusRef.current?.blur();
  };
  const pick = (s: Suggestion) => {
    if (s.kind === "search" || s.kind === "recent") run(s.query);
    // A person replaces the typed name with a from: operator (other operators stay).
    else if (s.kind === "person")
      run(setOperator(draft.replace(freeText(draft), ""), "from", s.email));
    else {
      setSuggesting(false);
      onOpenMessage(s.message);
    }
  };

  // Clicks outside close the suggestions / the advanced form.
  useEffect(() => {
    if (!suggesting && !advancedOpen) return;
    const down = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) {
        setSuggesting(false);
        setAdvancedOpen(false);
      }
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [suggesting, advancedOpen]);

  const showSuggestions = suggesting && !advancedOpen && suggestions.length > 0;

  return (
    <div ref={boxRef} className="relative shrink-0">
      <div className="drag-region flex h-(--workspace-topbar-height) items-center gap-2 px-3">
        {headerLeading}
        <div className="no-drag relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full bg-accent-surface px-3 transition-colors focus-within:bg-secondary">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            ref={focusRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSuggesting(true);
            }}
            onFocus={() => setSuggesting(true)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && showSuggestions) {
                e.preventDefault();
                setHighlight((h) => Math.min(suggestions.length - 1, h + 1));
              } else if (e.key === "ArrowUp" && showSuggestions) {
                e.preventDefault();
                setHighlight((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (showSuggestions && suggestions[highlight]) pick(suggestions[highlight]);
                else run(draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                escape();
              }
            }}
            placeholder="Search mail"
            aria-label="Search mail"
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
          />
          {draft ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setDraft(base ? `${base} ` : "");
                focusRef.current?.focus();
              }}
              className="shrink-0 text-muted-foreground/70 hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
          <HintTooltip label="Show search options">
            <IconBtn
              label="Show search options"
              active={advancedOpen}
              className="-me-1.5 size-6"
              onClick={() => {
                setAdvancedOpen((o) => !o);
                setSuggesting(false);
              }}
            >
              <SlidersHorizontalIcon className="size-3.5" />
            </IconBtn>
          </HintTooltip>
        </div>
        {headerTrailing}
      </div>

      {showSuggestions ? (
        <div
          role="listbox"
          className="dropdown-glass absolute inset-x-3 top-[calc(var(--workspace-topbar-height)-2px)] z-30 flex max-h-96 flex-col overflow-y-auto rounded-xl p-1 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
        >
          {!draft.trim() ? (
            <div className="px-2.5 pb-1 pt-1.5 text-sm text-muted-foreground">Recent searches</div>
          ) : null}
          {suggestions.map((s, i) => (
            <SuggestionRow
              key={`${s.kind}:${s.kind === "message" ? s.message.id : s.kind === "person" ? s.email : s.query}`}
              suggestion={s}
              highlighted={i === highlight}
              onHover={() => setHighlight(i)}
              onPick={() => pick(s)}
              onForget={() => {
                if (s.kind === "recent") forgetSearch(s.query);
                forceRecent((n) => n + 1);
              }}
            />
          ))}
        </div>
      ) : null}

      {advancedOpen ? (
        <AdvancedSearch query={draft} onSearch={run} onClose={() => setAdvancedOpen(false)} />
      ) : null}

      {/* Gmail's search chips: one row inside the panel, 10px in like the list's
          rows, scrolling sideways and fading out at the edge. */}
      <div className="flex items-center gap-1.5 overflow-x-auto px-[10px] pb-1 pt-[10px] [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ScopeChip accounts={accounts} scope={scope} onScope={onScope} />
        <PersonChip label="From" operator="from" query={query} onSearch={run} />
        <TimeChip query={query} onSearch={run} />
        <button
          type="button"
          className={chipClass(hasToken(query, "has:attachment"))}
          onClick={() => run(toggleToken(query, "has:attachment"))}
        >
          <PaperclipIcon className="size-3" />
          Has attachment
        </button>
        <PersonChip label="To" operator="to" query={query} onSearch={run} />
        <button
          type="button"
          className={chipClass(hasToken(query, "is:unread"))}
          onClick={() => run(toggleToken(query, "is:unread"))}
        >
          Is unread
        </button>
        <button
          type="button"
          className={chipClass(hasToken(query, "is:starred"))}
          onClick={() => run(toggleToken(query, "is:starred"))}
        >
          Is starred
        </button>
        {sortsImportant ? (
          <button
            type="button"
            className={chipClass(hasToken(query, "is:important"))}
            onClick={() => run(toggleToken(query, "is:important"))}
          >
            Is important
          </button>
        ) : null}
        <button type="button" className={chipClass(false)} onClick={() => setAdvancedOpen(true)}>
          Advanced search
        </button>
      </div>

      {query ? (
        <div className="flex h-7 items-center gap-2 px-5 text-xs text-muted-foreground">
          {offline ? (
            <span className="text-warning">Offline — showing matches saved on this device</span>
          ) : loading ? (
            <span>Searching Gmail…</span>
          ) : estimate !== null ? (
            <span>
              {estimate === 0
                ? "No results"
                : `About ${estimate.toLocaleString()} result${estimate === 1 ? "" : "s"}`}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** What the Search mailbox says before the first query. */
export const SEARCH_HINT =
  "Searches all of Gmail. Try from:, to:, subject:, has:attachment, older_than:1y, is:unread…";
