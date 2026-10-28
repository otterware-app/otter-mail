import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2Icon, Minimize2Icon, MinusIcon, XIcon } from "lucide-react";
import { cn, HintTooltip, IconBtn } from "./ui";
import { usePanelAnimationDurationMs } from "../panel-animations";

type FloatingSize = { width: number; height: number };
type FloatingPosition = { left: number; top: number };
type FloatingArea = FloatingSize & { topInset: number };
type ResizeAxis = "width" | "height" | "both";
const SIZE_KEY = "gmail:floating-reader-size";
const EDGE_INSET = 12;
// The frame is a spring boundary: dragging can cross it, resting positions cannot.
const ELASTIC_LIMIT = 48;

function workspaceArea(container: HTMLElement): FloatingArea {
  const bounds = container.getBoundingClientRect();
  return {
    width: bounds.width,
    height: bounds.height,
    topInset:
      parseFloat(getComputedStyle(container).getPropertyValue("--workspace-topbar-height")) || 0,
  };
}

function fitPosition(
  position: FloatingPosition,
  size: FloatingSize,
  area: FloatingArea,
  snap = false,
): FloatingPosition {
  const maxLeft = Math.max(EDGE_INSET, area.width - size.width - EDGE_INSET);
  const minTop = area.topInset + EDGE_INSET;
  const maxTop = Math.max(minTop, area.height - size.height - EDGE_INSET);
  const fit = (value: number, min: number, max: number) => {
    const bounded = Math.max(min, Math.min(max, value));
    if (snap && bounded - min < 24) return min;
    if (snap && max - bounded < 24) return max;
    return bounded;
  };
  return { left: fit(position.left, EDGE_INSET, maxLeft), top: fit(position.top, minTop, maxTop) };
}

function resistPosition(
  position: FloatingPosition,
  size: FloatingSize,
  area: FloatingArea,
): FloatingPosition {
  const bounded = fitPosition(position, size, area);
  const resist = (distance: number) =>
    (Math.sign(distance) * ELASTIC_LIMIT * Math.abs(distance)) / (Math.abs(distance) + 96);
  return {
    left: bounded.left + resist(position.left - bounded.left),
    top: bounded.top + resist(position.top - bounded.top),
  };
}

function fitSize(
  size: FloatingSize,
  area = { width: window.innerWidth, height: window.innerHeight },
): FloatingSize {
  const maxWidth = Math.max(1, area.width - 24);
  const maxHeight = Math.max(1, area.height - 80);
  return {
    width: Math.min(maxWidth, Math.max(Math.min(360, maxWidth), size.width)),
    height: Math.min(maxHeight, Math.max(Math.min(280, maxHeight), size.height)),
  };
}

function loadSize(): FloatingSize | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
    return saved &&
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height) &&
      saved.width > 0 &&
      saved.height > 0
      ? fitSize(saved)
      : null;
  } catch {
    return null;
  }
}

export function FloatingReader({
  container,
  children,
  messageId,
  title,
  navigation,
  onClose,
}: {
  container: HTMLElement | null;
  children: ReactNode;
  messageId: string;
  title: string;
  navigation: ReactNode;
  onClose: () => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const [minimizedMessage, setMinimizedMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const minimized = minimizedMessage === messageId;
  const panelAnimationDurationMs = usePanelAnimationDurationMs();
  const [windowAnimating, setWindowAnimating] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadSize);
  const [position, setPosition] = useState<FloatingPosition | null>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const moveAnimation = useRef<Animation | null>(null);
  const windowAnimation = useRef<Animation | null>(null);
  const animationStart = useRef<DOMRect | null>(null);

  const stopAnimation = () => {
    const panel = panelRef.current;
    if (!moveAnimation.current || !panel || !container) return;
    const bounds = panel.getBoundingClientRect();
    const area = container.getBoundingClientRect();
    moveAnimation.current.cancel();
    moveAnimation.current = null;
    panel.style.left = `${bounds.left - area.left}px`;
    panel.style.top = `${bounds.top - area.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };

  const changeWindow = (change: () => void) => {
    const start = panelRef.current?.getBoundingClientRect() ?? null;
    stopAnimation();
    windowAnimation.current?.cancel();
    windowAnimation.current = null;
    const animate =
      start &&
      panelAnimationDurationMs > 0 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    animationStart.current = animate ? start : null;
    setWindowAnimating(Boolean(animate));
    change();
  };

  useLayoutEffect(() => {
    const start = animationStart.current;
    const panel = panelRef.current;
    if (!start || !panel || !container) return;
    animationStart.current = null;
    const end = panel.getBoundingClientRect();
    const area = container.getBoundingClientRect();
    const frame = (bounds: DOMRect) => ({
      left: `${bounds.left - area.left}px`,
      top: `${bounds.top - area.top}px`,
      right: "auto",
      bottom: "auto",
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    });
    const animation = panel.animate([frame(start), frame(end)], {
      duration: panelAnimationDurationMs,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    windowAnimation.current = animation;
    animation.onfinish = () => {
      if (windowAnimation.current !== animation) return;
      windowAnimation.current = null;
      setWindowAnimating(false);
    };
  });

  const commitSize = (next: FloatingSize) => {
    setSize(next);
    localStorage.setItem(SIZE_KEY, JSON.stringify(next));
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    if (event.button !== 0 || windowAnimation.current || !container || !panelRef.current) return;
    event.preventDefault();
    stopAnimation();
    const panel = panelRef.current;
    const start = panel.getBoundingClientRect();
    const area = panel.offsetParent?.getBoundingClientRect();
    const origin = area ? { left: start.left - area.left, top: start.top - area.top } : position;
    const resizeArea =
      area && position
        ? {
            width: Math.min(area.width, start.right - area.left + 12),
            height: Math.min(
              area.height,
              start.bottom - area.top + 80 - workspaceArea(container).topInset - EDGE_INSET,
            ),
          }
        : area;
    const startX = event.clientX;
    const startY = event.clientY;
    let latest = { width: start.width, height: start.height };
    let frame = 0;
    // Keep the pointer in this document when it crosses a message's iframe.
    const cover = document.createElement("div");
    cover.className = "no-drag fixed inset-0 z-[200] touch-none select-none";
    cover.style.cursor =
      axis === "both" ? "nwse-resize" : axis === "width" ? "ew-resize" : "ns-resize";
    document.body.append(cover);
    const apply = () => {
      frame = 0;
      panel.style.width = `${latest.width}px`;
      panel.style.height = `${latest.height}px`;
      if (position) {
        panel.style.left = `${(origin?.left ?? position.left) + start.width - latest.width}px`;
        panel.style.top = `${(origin?.top ?? position.top) + start.height - latest.height}px`;
      }
    };
    const move = (next: globalThis.PointerEvent) => {
      latest = fitSize(
        {
          width: start.width + (axis === "height" ? 0 : startX - next.clientX),
          height: start.height + (axis === "width" ? 0 : startY - next.clientY),
        },
        resizeArea,
      );
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (frame) cancelAnimationFrame(frame);
      cover.remove();
      resizeCleanup.current = null;
    };
    const finish = () => {
      cleanup();
      apply();
      if (position)
        setPosition({
          left: (origin?.left ?? position.left) + start.width - latest.width,
          top: (origin?.top ?? position.top) + start.height - latest.height,
        });
      commitSize(latest);
    };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (
      event.button !== 0 ||
      minimized ||
      expanded ||
      windowAnimation.current ||
      !container ||
      !panelRef.current
    )
      return;
    const target = event.target as Element;
    if (target.closest("button") && !target.closest("[data-floating-title]")) return;
    event.preventDefault();
    stopAnimation();
    const panel = panelRef.current;
    const start = panel.getBoundingClientRect();
    const area = container.getBoundingClientRect();
    const movementArea = workspaceArea(container);
    const origin = { left: start.left - area.left, top: start.top - area.top };
    const startX = event.clientX;
    const startY = event.clientY;
    let latest = origin;
    let desired = origin;
    let frame = 0;
    let cover: HTMLDivElement | null = null;
    const apply = () => {
      frame = 0;
      panel.style.left = `${latest.left}px`;
      panel.style.top = `${latest.top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    };
    const move = (next: globalThis.PointerEvent) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      if (!cover && Math.hypot(dx, dy) < 4) return;
      if (!cover) {
        cover = document.createElement("div");
        cover.className = "no-drag fixed inset-0 z-[200] touch-none select-none";
        cover.style.cursor = "grabbing";
        document.body.append(cover);
      }
      desired = { left: origin.left + dx, top: origin.top + dy };
      latest = resistPosition(desired, start, movementArea);
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      if (frame) cancelAnimationFrame(frame);
      cover?.remove();
      resizeCleanup.current = null;
    };
    const finish = () => {
      const moved = cover !== null;
      cleanup();
      if (!moved) return;
      const visual = latest;
      latest = fitPosition(desired, start, movementArea, true);
      apply();
      setPosition(latest);
      const dx = visual.left - latest.left;
      const dy = visual.top - latest.top;
      if (Math.hypot(dx, dy) < 0.5 || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        return;
      const animation = panel.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: 280, easing: "cubic-bezier(0.22, 1.3, 0.36, 1)" },
      );
      moveAnimation.current = animation;
      animation.onfinish = () => {
        if (moveAnimation.current !== animation) return;
        moveAnimation.current = null;
        const fitted = fitPosition(latest, panel.getBoundingClientRect(), workspaceArea(container));
        if (fitted.left !== latest.left || fitted.top !== latest.top) setPosition(fitted);
      };
    };
    resizeCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const resizeWithKeys = (event: KeyboardEvent<HTMLButtonElement>, axis: ResizeAxis) => {
    const panel = panelRef.current;
    const horizontal = axis !== "height" && ["ArrowLeft", "ArrowRight"].includes(event.key);
    const vertical = axis !== "width" && ["ArrowUp", "ArrowDown"].includes(event.key);
    if (!container || !panel || windowAnimation.current || (!horizontal && !vertical)) return;
    event.preventDefault();
    event.stopPropagation();
    stopAnimation();
    const bounds = panel.getBoundingClientRect();
    const area = panel.offsetParent?.getBoundingClientRect();
    const resizeArea =
      area && position
        ? {
            width: Math.min(area.width, bounds.right - area.left + 12),
            height: Math.min(
              area.height,
              bounds.bottom - area.top + 80 - workspaceArea(container).topInset - EDGE_INSET,
            ),
          }
        : area;
    const step = event.shiftKey ? 32 : 16;
    const next = fitSize(
      {
        width: bounds.width + (horizontal ? (event.key === "ArrowLeft" ? step : -step) : 0),
        height: bounds.height + (vertical ? (event.key === "ArrowUp" ? step : -step) : 0),
      },
      resizeArea,
    );
    if (position)
      setPosition({
        left: (area ? bounds.left - area.left : position.left) + bounds.width - next.width,
        top: (area ? bounds.top - area.top : position.top) + bounds.height - next.height,
      });
    commitSize(next);
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!container || !panel || !position || minimized || expanded) return;
    const observer = new ResizeObserver(() => {
      if (resizeCleanup.current || moveAnimation.current || windowAnimation.current) return;
      const next = fitPosition(position, panel.getBoundingClientRect(), workspaceArea(container));
      if (next.left !== position.left || next.top !== position.top) setPosition(next);
    });
    observer.observe(container);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [container, position, minimized, expanded]);

  useEffect(() => {
    if (!container) return;
    const returnFocus = document.activeElement;
    if (!panelRef.current?.contains(returnFocus)) panelRef.current?.focus({ preventScroll: true });
    return () => {
      resizeCleanup.current?.();
      moveAnimation.current?.cancel();
      windowAnimation.current?.cancel();
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected)
        returnFocus.focus({ preventScroll: true });
    };
  }, [container]);

  if (!container) return null;
  return createPortal(
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-floating-reader=""
      data-tour="reader"
      style={
        minimized || expanded
          ? undefined
          : {
              ...size,
              ...(position ? { ...position, right: "auto", bottom: "auto" } : {}),
            }
      }
      className={cn(
        "floating-reader absolute z-40 flex min-h-0 max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-xl border text-foreground outline-none",
        minimized
          ? "right-3 bottom-3 h-[calc(2.5rem+2px)] w-80"
          : expanded
            ? "inset-x-3 top-[calc(var(--workspace-topbar-height)+0.75rem)] bottom-3"
            : "right-3 bottom-3 h-[min(44rem,calc(100%-5rem))] max-h-[calc(100%-5rem)] w-[40rem]",
      )}
    >
      <div
        data-floating-titlebar=""
        onPointerDown={startMove}
        className={cn(
          "no-drag flex h-10 shrink-0 touch-none select-none items-center gap-1 border-b border-border bg-sidebar-surface px-3",
          !minimized && !expanded && !windowAnimating && "cursor-grab active:cursor-grabbing",
        )}
      >
        <button
          id={headingId}
          data-floating-title=""
          type="button"
          className={cn(
            "min-w-0 flex-1 truncate text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
            !minimized && !expanded && !windowAnimating && "cursor-grab active:cursor-grabbing",
          )}
          aria-expanded={!minimized}
          aria-controls={bodyId}
          onClick={() => {
            if (minimized) changeWindow(() => setMinimizedMessage(null));
          }}
          title={title}
        >
          {title}
        </button>
        {!minimized ? navigation : null}
        <HintTooltip label={minimized ? "Restore conversation" : "Minimize conversation"}>
          <IconBtn
            label={minimized ? "Restore conversation" : "Minimize conversation"}
            onClick={() => {
              changeWindow(() => setMinimizedMessage(minimized ? null : messageId));
            }}
          >
            <MinusIcon className="size-3.5" />
          </IconBtn>
        </HintTooltip>
        <HintTooltip label={expanded ? "Restore floating size" : "Expand conversation"}>
          <IconBtn
            label={expanded ? "Restore floating size" : "Expand conversation"}
            onClick={() => {
              changeWindow(() => {
                setMinimizedMessage(null);
                setExpanded(!expanded);
              });
            }}
          >
            {expanded ? (
              <Minimize2Icon className="size-3.5" />
            ) : (
              <Maximize2Icon className="size-3.5" />
            )}
          </IconBtn>
        </HintTooltip>
        <HintTooltip label="Close conversation" shortcut="message.close">
          <IconBtn label="Close conversation" onClick={onClose}>
            <XIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
      </div>
      {!minimized && !expanded && !windowAnimating ? (
        <>
          <button
            type="button"
            aria-label="Resize floating reader width"
            className="no-drag absolute inset-y-3 left-0 z-20 w-1.5 touch-none cursor-ew-resize outline-none hover:bg-input focus-visible:bg-focus-ring"
            onPointerDown={(event) => startResize(event, "width")}
            onKeyDown={(event) => resizeWithKeys(event, "width")}
          />
          <button
            type="button"
            aria-label="Resize floating reader height"
            className="no-drag absolute inset-x-3 top-0 z-20 h-1.5 touch-none cursor-ns-resize outline-none hover:bg-input focus-visible:bg-focus-ring"
            onPointerDown={(event) => startResize(event, "height")}
            onKeyDown={(event) => resizeWithKeys(event, "height")}
          />
          <button
            type="button"
            aria-label="Resize floating reader"
            title="Drag to resize"
            className="no-drag absolute top-0 left-0 z-20 size-3.5 touch-none cursor-nwse-resize text-muted-foreground/50 outline-none hover:text-foreground focus-visible:bg-focus-ring"
            onPointerDown={(event) => startResize(event, "both")}
            onKeyDown={(event) => resizeWithKeys(event, "both")}
          >
            <svg
              viewBox="0 0 12 12"
              className="size-3"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M2 10 10 2M2 6 6 2" />
            </svg>
          </button>
        </>
      ) : null}
      <div
        id={bodyId}
        className={cn("min-h-0 flex-1", minimized && !windowAnimating ? "hidden" : "flex flex-col")}
        inert={minimized}
      >
        {children}
      </div>
    </section>,
    container,
  );
}
