import { useLatest } from "../use-latest";
import {
  forwardRef,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/utils";
import type { KeybindingCommand } from "../keybindings/commands";
import { useShortcutLabel } from "../keybindings/store";

// Last input modality. Menus and selects hand focus back to their trigger on
// close; WebKit paints that restored focus as keyboard focus (a blue ring)
// even after a mouse click, so after pointer use we skip the hand-back.
let lastInputWasKeyboard = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (lastInputWasKeyboard = true), true);
  window.addEventListener("pointerdown", () => (lastInputWasKeyboard = false), true);
}

/** `onCloseAutoFocus` for popups: restore trigger focus for keyboard users only. */
export function restoreFocusForKeyboardOnly(event: Event): void {
  if (!lastInputWasKeyboard) event.preventDefault();
}

export { cn };

/**
 * Shared control chrome: rounded, focus ring, disabled fade, instant hover feedback.
 * No pressed scale: a Mac button stays put.
 */
const CONTROL =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border font-normal outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-64 [&_svg]:pointer-events-none [&_svg]:shrink-0";

export const BUTTON_VARIANTS = {
  /** Solid call to action (send, confirm), flat in the theme's primary. */
  primary: "border-transparent bg-primary text-primary-foreground hover:bg-primary/88",
  /** Quiet pill with a faint border. */
  outline: "border-border bg-transparent text-foreground hover:bg-accent-surface",
  /** Quiet control that only shows a surface on hover. */
  ghost: "border-transparent text-foreground hover:bg-accent-surface",
  /** Ghost in the muted tone, brightening on hover (toolbar icons). */
  "ghost-muted":
    "border-transparent text-muted-foreground hover:bg-accent-surface hover:text-foreground",
  destructive: "border-transparent bg-destructive text-white hover:bg-destructive/88",
} as const;

export const BUTTON_SIZES = {
  xs: "h-6 px-[calc(--spacing(2)-1px)] text-xs [&_svg:not([class*='size-'])]:size-3.5",
  sm: "h-7 px-[calc(--spacing(2.5)-1px)] text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
  default: "h-8 px-[calc(--spacing(3)-1px)] text-sm [&_svg:not([class*='size-'])]:size-4",
  "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3.5",
  "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-4",
  icon: "size-8 [&_svg:not([class*='size-'])]:size-4",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

export function buttonClass(
  variant: ButtonVariant = "outline",
  size: ButtonSize = "default",
  className?: string,
): string {
  return cn(CONTROL, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className);
}

/** General button in the app's control style. */
export const Btn = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }
>(function Btn({ variant = "outline", size = "default", className, type, ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={buttonClass(variant, size, className)}
      {...props}
    />
  );
});

/** Ghost icon button used across the chrome (toolbars, headers, rows). */
export const IconBtn = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconBtn({ label, active, className, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        CONTROL,
        BUTTON_SIZES["icon-sm"],
        active
          ? "border-transparent bg-accent-surface text-foreground"
          : BUTTON_VARIANTS["ghost-muted"],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

// Tooltips render in the page (like Otter Code's), not in a separate native
// window: a native tooltip window resets the macOS cursor to the arrow the
// moment it opens, which made hovered buttons lose their pointer cursor.
const TOOLTIP_DELAY_MS = 500;
/** Moving between neighbouring controls within this window shows instantly. */
const TOOLTIP_GRACE_MS = 300;
const TOOLTIP_GAP = 6;
const VIEWPORT_MARGIN = 6;
let lastTooltipClosedAt = 0;

type TooltipSide = "top" | "bottom" | "right";
type TooltipPlacement = { top: number; left: number; side: TooltipSide };

/** Hover/focus hint for a control. Wraps its child without adding layout. */
export function HintTooltip({
  label,
  hint: fixedHint,
  shortcut,
  side = "top",
  children,
}: {
  label: string;
  hint?: string;
  /** Shows this command's live keybinding as the hint. */
  shortcut?: KeybindingCommand;
  /** "right" for a control in the rail down the window's edge. */
  side?: TooltipSide;
  children: ReactNode;
}) {
  const liveHint = useShortcutLabel(shortcut);
  const hint = fixedHint ?? liveHint;
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const timer = useRef<number | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const clearTimer = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const open = (target: Element | null) => {
    if (!target) return;
    clearTimer();
    const reveal = () => setAnchor(target.getBoundingClientRect());
    if (Date.now() - lastTooltipClosedAt < TOOLTIP_GRACE_MS) reveal();
    else timer.current = window.setTimeout(reveal, TOOLTIP_DELAY_MS);
  };
  const close = () => {
    clearTimer();
    setAnchor((current) => {
      if (current) lastTooltipClosedAt = Date.now();
      return null;
    });
    setPlacement(null);
  };

  const clearTimerForEffect = useLatest(clearTimer);
  useEffect(() => clearTimerForEffect.current, [clearTimerForEffect]);

  // Place against the trigger once the bubble is measured: preferred side,
  // flipped when it would leave the window, clamped horizontally.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const { width, height } = popup.getBoundingClientRect();
    if (side === "right") {
      const middle = anchor.top + anchor.height / 2 - height / 2;
      const top = Math.min(
        Math.max(VIEWPORT_MARGIN, middle),
        window.innerHeight - height - VIEWPORT_MARGIN,
      );
      setPlacement({ top, left: anchor.right + TOOLTIP_GAP, side });
      return;
    }
    const fitsTop = anchor.top - TOOLTIP_GAP - height >= VIEWPORT_MARGIN;
    const fitsBottom = anchor.bottom + TOOLTIP_GAP + height <= window.innerHeight - VIEWPORT_MARGIN;
    const resolved =
      side === "top"
        ? fitsTop || !fitsBottom
          ? "top"
          : "bottom"
        : fitsBottom || !fitsTop
          ? "bottom"
          : "top";
    const top =
      resolved === "top" ? anchor.top - TOOLTIP_GAP - height : anchor.bottom + TOOLTIP_GAP;
    const centered = anchor.left + anchor.width / 2 - width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, centered),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    setPlacement({ top, left, side: resolved });
  }, [anchor, side]);

  // Any scroll or window change invalidates the anchor rect.
  const closeForEffect = useLatest(close);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => closeForEffect.current();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [anchor, closeForEffect]);

  const triggerOf = (e: { currentTarget: HTMLElement }) => e.currentTarget.firstElementChild;

  return (
    <>
      <span
        className="contents"
        onPointerOver={(e: PointerEvent<HTMLSpanElement>) => {
          if (e.pointerType === "touch") return;
          const from = e.relatedTarget;
          if (from instanceof Node && e.currentTarget.contains(from)) return;
          open(triggerOf(e));
        }}
        onPointerOut={(e: PointerEvent<HTMLSpanElement>) => {
          const to = e.relatedTarget;
          if (to instanceof Node && e.currentTarget.contains(to)) return;
          close();
        }}
        onPointerDown={close}
        onFocus={(e: FocusEvent<HTMLSpanElement>) => {
          if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) {
            open(triggerOf(e));
          }
        }}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
        }}
      >
        {children}
      </span>
      {anchor
        ? createPortal(
            <div
              ref={popupRef}
              role="tooltip"
              style={
                placement
                  ? { top: placement.top, left: placement.left }
                  : { top: -9999, left: -9999, visibility: "hidden" }
              }
              className={cn(
                "tooltip-in pointer-events-none fixed z-[140] flex max-w-80 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border/60 bg-popover px-2 py-1 text-xs leading-snug text-popover-foreground shadow-lg/10",
                placement?.side === "bottom"
                  ? "origin-top"
                  : placement?.side === "right"
                    ? "origin-left"
                    : "origin-bottom",
              )}
            >
              <span>{label}</span>
              {hint ? <span className="text-muted-foreground">{hint}</span> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** Keyboard hint chip. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-md bg-muted px-1 font-sans text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Unread count: a quiet tabular numeral, brightening on the selected row. */
export function UnreadPill({ count, selected }: { count: number; selected?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "ml-auto shrink-0 text-xs tabular-nums",
        selected ? "text-sidebar-foreground" : "text-muted-foreground/70",
      )}
    >
      {count > 999 ? "999+" : count}
    </span>
  );
}
