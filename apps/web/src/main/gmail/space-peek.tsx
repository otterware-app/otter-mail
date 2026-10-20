/**
 * Peeking at a space (ChatGPT's): with the sidebar collapsed, hovering a
 * mailbox or Chats in the rail shows its sidebar over the window after a
 * beat (at once while one shows), so a folder or chat in another space is
 * one click away. It stays while the pointer is in it, and goes a moment
 * after it leaves (not while a menu or dialog of it is open). A conversation
 * dragged onto the rail opens it too, to drop on a label.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

/** The space peeked at, and the rail's and the card's hover. */
export function useSpacePeek() {
  const [peek, setPeek] = useState<string | null>(null);
  const timer = useRef(0);
  const hover = (spaceId: string | null) => {
    window.clearTimeout(timer.current);
    if (spaceId) {
      timer.current = window.setTimeout(() => setPeek(spaceId), peek ? 0 : 120);
      return;
    }
    const close = () => {
      if (document.querySelector('[role="menu"], [role="dialog"]')) {
        timer.current = window.setTimeout(close, 300);
        return;
      }
      setPeek(null);
    };
    timer.current = window.setTimeout(close, 200);
  };
  const close = () => {
    window.clearTimeout(timer.current);
    setPeek(null);
  };
  useEffect(() => {
    const done = () => setPeek(null);
    window.addEventListener("drop", done);
    window.addEventListener("dragend", done);
    return () => {
      window.removeEventListener("drop", done);
      window.removeEventListener("dragend", done);
    };
  }, []);
  return { peek, hover, close };
}

/**
 * The card: an even gap (--peek-gap) inside the content panel, its corners
 * concentric with the panel's (the panel's radius less the gap), wearing the
 * docked sidebar's surface, raised by its shadow. The sidebar in it is laid
 * out exactly where it docks (back past the gap and the edge, at full
 * width), so going somewhere leaves every row in place and only the card goes.
 */
export function SpacePeekCard({
  width,
  onHover,
  children,
}: {
  /** The docked sidebar's width. */
  width: number;
  /** The pointer came into the card (true) or left it. */
  onHover: (inside: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{ width: `calc(${width}px - 2 * var(--peek-gap))` }}
      className="absolute bottom-[calc(0.25rem+var(--peek-gap))] left-(--peek-gap) top-[calc(var(--workspace-topbar-height)+var(--peek-gap))] web:inset-y-(--peek-gap) z-40 overflow-hidden rounded-[calc(var(--radius-xl)-var(--peek-gap))] border border-(--panel-edge) bg-canvas text-sidebar-foreground shadow-[0_18px_48px_-12px_rgb(0_0_0/30%)] transition-opacity duration-150 ease-out [--peek-gap:0.25rem] starting:opacity-0 dark:shadow-[0_18px_48px_-12px_rgb(0_0_0/70%)]"
    >
      <div aria-hidden className="absolute inset-0 bg-(--sidebar-panel-surface)" />
      <div
        style={{ width }}
        className="absolute bottom-[calc(-1*(var(--peek-gap)+1px))] left-[calc(-1*(var(--peek-gap)+1px))] top-[calc(-1*(var(--peek-gap)+1px))] flex flex-col"
      >
        {children}
      </div>
    </div>
  );
}
