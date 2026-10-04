import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Undo2Icon } from "lucide-react";
import { ScrollArea } from "~/components/ui/scroll-area";
import { cn, HintTooltip } from "../gmail/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../gmail/select";

/*
 * Settings layout (after ChatGPT's): one centered column. The page title, page
 * description, section titles and descriptions share the card's left edge;
 * inside a card every row's text starts 16px in and every control ends 16px
 * from the right.
 */

// ---------------------------------------------------------------------------
// Search targets (Otter Code's): a settings-search result opens its pane with
// a target id; the row or section with that id scrolls into view and pulses
// once it mounts, then the target is cleared.
// ---------------------------------------------------------------------------

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  onTargetHandled: noop,
});

export function SettingsSearchTargetProvider({
  targetId,
  onTargetHandled,
  children,
}: {
  targetId: string | null;
  onTargetHandled: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ targetId, onTargetHandled }), [onTargetHandled, targetId]);
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // A section taller than half the window shows from its top, not its middle.
  target.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: target.offsetHeight > window.innerHeight / 2 ? "start" : "center",
  });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** Ref for the element with `id`: scrolls to it when it's the search target. */
export function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  return useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target);
        onTargetHandled();
      }
    },
    [isSearchTarget, onTargetHandled],
  );
}

/** A plain div that's a search target when it has an id. */
export function SettingsSearchTarget({ children, ...props }: ComponentProps<"div">) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(props.id);
  return (
    <div {...props} ref={targetRef} tabIndex={props.id ? -1 : props.tabIndex}>
      {children}
    </div>
  );
}

/** Shared settings card surface, with separators between rows. */
export function SettingsGroup({
  variant = "grouped",
  divided = true,
  className,
  ...props
}: ComponentProps<"div"> & { variant?: "grouped" | "plain"; divided?: boolean }) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(props.id);
  return (
    <div
      {...props}
      ref={targetRef}
      tabIndex={props.id ? -1 : props.tabIndex}
      data-slot={variant === "grouped" ? "settings-group" : undefined}
      className={cn(
        "relative overflow-visible text-foreground",
        variant === "grouped" ? "rounded-xl border border-border/60 bg-card" : "space-y-1",
        variant === "grouped" && divided && "[&>*+*]:border-t [&>*+*]:border-border/40",
        // Row hovers and selections follow the card's corners.
        variant === "grouped" &&
          "[&>*:first-child]:rounded-t-[11px] [&>*:last-child]:rounded-b-[11px]",
        className,
      )}
    />
  );
}

/** A section's title (and optional description) above its card, flush with the card's edge. */
export function SettingsSectionHeader({
  title,
  description,
  icon,
  action,
  muted,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  /** Quiet group label (the keybindings list) instead of a section title. */
  muted?: boolean;
}) {
  return (
    // Text outside the cards lines up with the text inside them (Linear):
    // the cards' 1px border + 16px padding.
    <div
      className={cn(
        "flex min-h-7 items-center justify-between gap-4 px-[17px]",
        muted ? "mb-1" : "mb-3",
      )}
    >
      <div className="min-w-0">
        <h2
          data-slot="settings-section-title"
          className={cn(
            "flex items-center gap-2 text-sm",
            muted ? "text-muted-foreground" : "font-medium text-foreground",
          )}
        >
          {icon}
          {title}
        </h2>
        {description ? (
          <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

/** A titled group of rows. "plain" leaves the children uncarded (grids, lists). */
export function SettingsSection({
  title,
  description,
  icon,
  headerAction,
  variant = "grouped",
  children,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  headerAction?: ReactNode;
  variant?: "grouped" | "plain";
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(props.id);
  return (
    <section
      {...props}
      ref={targetRef}
      tabIndex={props.id ? -1 : props.tabIndex}
      className={className}
    >
      <SettingsSectionHeader
        title={title}
        description={description}
        icon={icon}
        action={headerAction}
      />
      {variant === "grouped" ? <SettingsGroup>{children}</SettingsGroup> : children}
    </section>
  );
}

/**
 * One setting: title + description on the left, the control on the right.
 * Children render below the row (expanded editors, lists).
 */
export function SettingsRow({
  title,
  description,
  status,
  control,
  resetAction,
  children,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  control?: ReactNode;
  /** Shown beside the title while the setting differs from its default. */
  resetAction?: ReactNode;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(props.id);
  return (
    <div
      {...props}
      ref={targetRef}
      tabIndex={props.id ? -1 : props.tabIndex}
      data-slot="settings-row"
      className={cn("@container/settings-row px-4", children ? "pt-2.5 pb-1" : "py-2.5", className)}
    >
      <div className="flex min-h-9 flex-col gap-3 @min-[30rem]/settings-row:flex-row @min-[30rem]/settings-row:items-center @min-[30rem]/settings-row:gap-8">
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-normal text-foreground">{title}</h3>
            {resetAction ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {resetAction}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 max-w-[30rem] text-[13px] leading-[18px] text-muted-foreground">
              {description}
            </p>
          ) : null}
          {status ? <div className="mt-1 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div
            data-slot="settings-row-control"
            className="flex min-w-0 shrink-0 items-center gap-2 @min-[30rem]/settings-row:justify-end"
          >
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Compact select in the control slot of a row. */
export function RowSelect({
  value,
  onValueChange,
  options,
  placeholder,
  ariaLabel,
  className,
  disabled,
}: {
  value: string | undefined;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    // "" keeps the Select controlled (showing the placeholder) while the value loads.
    <Select value={value ?? ""} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger variant="pill" aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder ?? "Loading…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Small undo button that puts one setting back to its default. */
export function SettingResetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <HintTooltip label="Reset to default">
      <button
        type="button"
        aria-label={`Reset ${label} to default`}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <Undo2Icon className="size-3" />
      </button>
    </HintTooltip>
  );
}

/**
 * Scrollable page: the pane's title (and a one-line description) over its
 * sections, in the settings column.
 */
export function SettingsPageContainer({
  title,
  description,
  action,
  searchId,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  /** Beside the title, right-aligned with the cards' edge. */
  action?: ReactNode;
  /** Settings-search anchor for the pane as a whole: its header. */
  searchId?: string;
}) {
  const headerRef = useSettingsSearchTarget<HTMLElement>(searchId);
  return (
    <ScrollArea className="flex-1" data-settings-page-scroll="">
      <div
        {...props}
        className={cn("mx-auto w-full max-w-[47rem] space-y-10 px-6 pb-20 pt-14", className)}
      >
        {title ? (
          <header
            id={searchId}
            ref={headerRef}
            tabIndex={searchId ? -1 : undefined}
            className="flex items-end justify-between gap-4 px-[17px] outline-none"
          >
            <div className="min-w-0">
              <h1
                data-slot="settings-page-title"
                className="text-[26px] font-medium leading-8 tracking-[-0.01em] text-foreground"
              >
                {title}
              </h1>
              {description ? (
                <p
                  data-slot="settings-page-description"
                  className="mt-1.5 text-sm text-muted-foreground"
                >
                  {description}
                </p>
              ) : null}
            </div>
            {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
          </header>
        ) : null}
        {children}
      </div>
    </ScrollArea>
  );
}

/** Text input in the app's control style (small size). */
export const TextInput = forwardRef<HTMLInputElement, ComponentProps<"input">>(function TextInput(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      {...props}
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-border/70 bg-surface-raised/60 px-[calc(--spacing(2.75)-1px)] text-sm text-foreground outline-none transition-[box-shadow,border-color,background-color] placeholder:text-placeholder focus-visible:border-focus-ring/60 focus-visible:bg-canvas focus-visible:ring-[3px] focus-visible:ring-focus-ring/16 disabled:opacity-64",
        className,
      )}
    />
  );
});

/** Text input that commits on blur / Enter (settings write once, not per keystroke). */
export function DraftInput({
  value,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof TextInput>, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [draftFor, setDraftFor] = useState(value);
  if (draftFor !== value) {
    setDraftFor(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <TextInput
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}

/** "5m ago". */
export function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
