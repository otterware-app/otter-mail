import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useLatest } from "../use-latest";
import { usePanelAnimationDurationMs } from "../panel-animations";
import { movePanelTab, orderedPanelTabs, tabDragTarget } from "./panel-tabs";

type Drag = {
  id: string;
  pointerId: number;
  startX: number;
  clientX: number;
  grab: number;
  width: number;
  original: string[];
  active: boolean;
};

/** The tab follows the pointer; crossing a neighbour slides it into the vacated slot. */
export function usePanelTabDrag(onReorder: (order: string[]) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const before = useRef<Map<string, number> | null>(null);
  const animations = useRef(new Map<HTMLElement, Animation>());
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const duration = usePanelAnimationDurationMs();
  const reorder = useLatest(onReorder);

  const elements = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-panel-tab-id]") ?? []);
  const positions = () =>
    new Map(elements().map((tab) => [tab.dataset.panelTabId!, tab.getBoundingClientRect().left]));
  const animate = (tab: HTMLElement, from: number) => {
    if (!from || !duration || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    animations.current.set(
      tab,
      tab.animate([{ transform: `translateX(${from}px)` }, { transform: "translateX(0)" }], {
        duration,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }),
    );
  };

  const placeDragged = () => {
    const strip = ref.current;
    const current = drag.current;
    if (!strip || !current?.active) return null;
    const tabs = elements();
    const tab = tabs.find((tab) => tab.dataset.panelTabId === current.id);
    if (!tab || !tabs.length) return null;
    const bounds = strip.getBoundingClientRect();
    const last = tabs[tabs.length - 1];
    const pointerLeft = current.clientX - bounds.left + strip.scrollLeft - current.grab;
    const left = Math.max(
      tabs[0].offsetLeft,
      Math.min(last.offsetLeft + last.offsetWidth - current.width, pointerLeft),
    );
    tab.style.transform = `translateX(${left - tab.offsetLeft}px)`;
    // End slots must remain reachable even while the tab is kept inside the
    // strip, including when it is wider than the end tab it crosses.
    return { tabs, center: pointerLeft + current.width / 2 };
  };

  // FLIP from the current painted positions so another crossing can interrupt
  // an in-flight animation smoothly. The dragged tab itself never lags behind.
  useLayoutEffect(() => {
    const previous = before.current;
    before.current = null;
    if (previous) {
      for (const tab of elements()) {
        const id = tab.dataset.panelTabId!;
        animations.current.get(tab)?.cancel();
        if (id === drag.current?.id) continue;
        const left = previous.get(id);
        if (left !== undefined) animate(tab, left - tab.getBoundingClientRect().left);
      }
    }
    placeDragged();
  });

  const move = () => {
    const strip = ref.current;
    const current = drag.current;
    if (!strip || !current?.active) return;
    const bounds = strip.getBoundingClientRect();
    // Keep moving through an overflowing strip while held at either edge.
    if (current.clientX < bounds.left + 24) strip.scrollLeft -= 8;
    else if (current.clientX > bounds.right - 24) strip.scrollLeft += 8;
    const placed = placeDragged();
    if (!placed || before.current) return;
    const tabs = placed.tabs.map((tab) => ({
      id: tab.dataset.panelTabId!,
      left: tab.offsetLeft,
      width: tab.offsetWidth,
    }));
    const target = tabDragTarget(tabs, current.id, placed.center);
    if (!target) return;
    before.current = positions();
    reorder.current(
      movePanelTab(
        tabs.map((tab) => tab.id),
        current.id,
        target.id,
        target.after,
      ),
    );
  };

  const finish = (cancelled: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (current.active) {
      before.current = positions();
      for (const tab of elements()) {
        if (tab.dataset.panelTabId === current.id) tab.style.transform = "";
      }
      suppressClick.current = true;
      setDraggingId(null);
      if (cancelled)
        reorder.current(
          orderedPanelTabs(
            current.original,
            elements().map((tab) => tab.dataset.panelTabId!),
          ),
        );
    }
    if (ref.current?.hasPointerCapture(current.pointerId))
      ref.current.releasePointerCapture(current.pointerId);
  };
  const finishRef = useLatest(finish);
  useEffect(() => {
    const cancel = () => finishRef.current(true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      for (const animation of animations.current.values()) animation.cancel();
    };
  }, [finishRef]);

  return {
    ref,
    draggingId,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || drag.current) return;
        suppressClick.current = false;
        if (!(event.target instanceof Element) || event.target.closest("button")) return;
        const tab = event.target.closest<HTMLElement>("[data-panel-tab-id]");
        const id = tab?.dataset.panelTabId;
        if (!tab || !id) return;
        const bounds = tab.getBoundingClientRect();
        tab.focus({ preventScroll: true });
        drag.current = {
          id,
          pointerId: event.pointerId,
          startX: event.clientX,
          clientX: event.clientX,
          grab: event.clientX - bounds.left,
          width: bounds.width,
          original: elements().map((tab) => tab.dataset.panelTabId!),
          active: false,
        };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!(event.buttons & 1)) {
          finish(false);
          return;
        }
        current.clientX = event.clientX;
        if (!current.active) {
          if (Math.abs(event.clientX - current.startX) < 4) return;
          current.active = true;
          const tab = elements().find((tab) => tab.dataset.panelTabId === current.id);
          if (tab) animations.current.get(tab)?.cancel();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDraggingId(current.id);
          const tick = () => {
            if (!drag.current?.active) return;
            move();
            frame.current = requestAnimationFrame(tick);
          };
          frame.current = requestAnimationFrame(tick);
        }
        event.preventDefault();
      },
      onPointerUp(event: PointerEvent<HTMLDivElement>) {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current.clientX = event.clientX;
        move();
        finish(false);
      },
      onPointerCancel: () => finish(true),
      onLostPointerCapture: () => finish(true),
      onPointerLeave() {
        if (drag.current && !drag.current.active) finish(false);
      },
      onClickCapture(event: React.MouseEvent<HTMLDivElement>) {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDownCapture(event: React.KeyboardEvent<HTMLDivElement>) {
        if (event.key !== "Escape" || !drag.current?.active) return;
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      },
      onDragStart(event: React.DragEvent<HTMLDivElement>) {
        event.preventDefault();
      },
    },
  };
}
