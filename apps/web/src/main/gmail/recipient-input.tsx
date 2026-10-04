import { withOccurrenceKeys } from "./list-keys";
import {
  forwardRef,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { XIcon } from "lucide-react";
import { useDebouncedValue, useSuggestContacts } from "./hooks";
import { splitAddressList, parseAddressEntry, formatAddressEntry } from "./address";
import { SenderAvatar } from "./sender-avatar";
import { cn } from "./ui";
import { toast } from "./toast";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./menu";

/**
 * Recipients field: finished addresses render as chips, the one being typed
 * stays text, with contact autocomplete (local mail cache). The value is the
 * plain comma-separated list ("Name <a@x>, b@y, partial") so composers keep
 * treating it as a string.
 *
 * Keys: ↑/↓ + Enter/Tab pick a suggestion; with no suggestions, "," Enter or
 * Tab commit the typed address; Backspace in an empty field removes the last
 * chip; Escape dismisses suggestions (marked with data-ac-open so composer
 * Escape handlers stand down).
 */
export const RecipientInput = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    ariaLabel: string;
  }
>(function RecipientInput({ value, onChange, placeholder, ariaLabel }, ref) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set while a chip is being turned back into text, so focusing doesn't re-chip it.
  const editingRef = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  const lastComma = value.lastIndexOf(",");
  const entries = splitAddressList(lastComma >= 0 ? value.slice(0, lastComma) : "");
  const token = value.slice(lastComma + 1).trimStart();
  // Unfocused, every address is a chip (prefilled replies have no trailing
  // comma); focused, the last unfinished one stays editable text.
  const chips = focused ? entries : splitAddressList(value);
  const typing = focused ? token : "";

  /** Rebuilds the value from committed entries plus the text being typed. */
  const write = (next: string[], typing: string) =>
    onChange(next.length > 0 ? `${next.join(", ")}, ${typing}` : typing);

  const query = useDebouncedValue(token.trim(), 120);
  const suggestQuery = useSuggestContacts(query, focused && query.length > 0);

  const existing = new Set(entries.map((entry) => parseAddressEntry(entry).email.toLowerCase()));
  const suggestions = (suggestQuery.data ?? [])
    .filter((s) => !existing.has(s.email.toLowerCase()))
    .slice(0, 6);

  const open = focused && !dismissed && token.trim().length > 0 && suggestions.length > 0;

  const accept = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    write([...entries, formatAddressEntry(suggestion.name, suggestion.email)], "");
    setActiveIdx(0);
    setDismissed(false);
  };

  /** Turns the typed text into a chip (if there is any). */
  const commitToken = () => {
    const typed = token.trim();
    if (!typed) return false;
    write([...entries, ...splitAddressList(typed)], "");
    return true;
  };

  const removeAt = (index: number) =>
    write(
      chips.filter((_, i) => i !== index),
      typing,
    );

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // Modified keys (⌘↩ send) belong to the composer.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        accept(activeIdx);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if ((e.key === "Enter" || e.key === "Tab") && token.trim()) {
      // Tab still moves focus on after committing.
      if (e.key === "Enter") e.preventDefault();
      commitToken();
      return;
    }
    if (e.key === "Backspace" && token.length === 0 && chips.length > 0) {
      e.preventDefault();
      removeAt(chips.length - 1);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(`Copied ${text}`),
      () => toast.error("Couldn't copy the address"),
    );
  };

  /** Turns a chip back into editable text (the field's typed text). */
  const editAt = (index: number) => {
    const others = chips.filter((_, i) => i !== index);
    editingRef.current = true;
    write(others, chips[index]);
    inputRef.current?.focus();
  };

  // Pasting a list ("a@x, b@y") commits everything but a trailing fragment.
  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.includes(",") && !text.includes(";")) return;
    e.preventDefault();
    write([...entries, ...splitAddressList(`${token}${text}`.replace(/;/g, ","))], "");
  };

  return (
    <span
      className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1 py-0.5"
      data-ac-open={open ? "true" : "false"}
    >
      {withOccurrenceKeys(chips, (entry) => entry).map(({ item: entry, index: i, key }) => {
        const { name, email } = parseAddressEntry(entry);
        const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
        return (
          <ContextMenu key={key}>
            <ContextMenuTrigger asChild>
              <span
                tabIndex={0}
                title={name ? `${name} <${email}>` : email}
                // Focusable chip: ⌘C copies the address, Delete removes it,
                // Enter / double-click puts it back into the field to edit.
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
                    e.preventDefault();
                    copy(email);
                  } else if (e.key === "Backspace" || e.key === "Delete") {
                    e.preventDefault();
                    removeAt(i);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    editAt(i);
                  }
                }}
                // Edit › Copy (⌘C via the app menu) fires a copy event, not a key.
                onCopy={(e) => {
                  e.preventDefault();
                  e.clipboardData.setData("text/plain", email);
                  toast.success(`Copied ${email}`);
                }}
                onDoubleClick={() => editAt(i)}
                className={cn(
                  "inline-flex h-6.5 max-w-64 cursor-default items-center gap-1 rounded-full border pl-2.5 pr-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus:bg-accent-surface",
                  valid
                    ? "border-transparent bg-accent-surface text-foreground"
                    : "border-destructive/50 bg-destructive/10 text-destructive-foreground",
                )}
              >
                <span className="min-w-0 truncate">{name || email}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Remove ${email}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => removeAt(i)}
                  className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                >
                  <XIcon className="size-3" />
                </button>
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => copy(email)}>Copy address</ContextMenuItem>
              {name ? (
                <ContextMenuItem onSelect={() => copy(formatAddressEntry(name, email))}>
                  Copy name and address
                </ContextMenuItem>
              ) : null}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => editAt(i)}>Edit</ContextMenuItem>
              <ContextMenuItem color="red" onSelect={() => removeAt(i)}>
                Remove
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <input
        ref={(el) => {
          inputRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        value={typing}
        onChange={(e) => {
          const next = e.target.value;
          // A typed comma commits the address before it.
          if (next.endsWith(",") || next.endsWith(";")) {
            write([...entries, ...splitAddressList(next.replace(/;/g, ","))], "");
          } else {
            write(entries, next);
          }
          setDismissed(false);
          setActiveIdx(0);
        }}
        onFocus={() => {
          setFocused(true);
          // A prefilled list keeps its last address as a chip too.
          if (editingRef.current) editingRef.current = false;
          else if (token.trim()) write([...entries, ...splitAddressList(token)], "");
        }}
        onBlur={() => {
          setFocused(false);
          commitToken();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={chips.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
      />
      {open ? (
        <div className="dropdown-glass absolute left-0 top-full z-50 mt-1.5 max-h-64 w-full min-w-64 overflow-y-auto rounded-xl p-1.5 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
          {suggestions.map((suggestion, i) => (
            <button
              key={suggestion.email}
              type="button"
              // preventDefault keeps the input focused through the click.
              onMouseDown={(e) => {
                e.preventDefault();
                accept(i);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                i === activeIdx && "bg-accent-surface",
              )}
            >
              <SenderAvatar name={suggestion.name} email={suggestion.email} size="sm" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {suggestion.name || suggestion.email}
                </span>
                {suggestion.name ? (
                  <span className="truncate text-xs text-muted-foreground">{suggestion.email}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
});
