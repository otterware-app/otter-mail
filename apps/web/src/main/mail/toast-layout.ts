/**
 * Stack layout for the toast viewport, from Otter Code's toast.logic.ts.
 */

/**
 * Base UI toast updates omit `undefined` fields, so callers that need to remove
 * an action must pass a defined `actionProps` whose `children` are empty.
 * Treat that payload (and missing children) as "no visible action".
 */
export function hasVisibleToastAction(actionProps: unknown): boolean {
  if (actionProps == null || typeof actionProps !== "object") return false;
  if (!("children" in actionProps)) return false;
  const children = actionProps.children;
  return children != null && children !== false && children !== "";
}

/** Toasts behind the front one only peek out until the stack is hovered. */
export function shouldHideCollapsedToastContent(
  visibleToastIndex: number,
  visibleToastCount: number,
): boolean {
  if (visibleToastCount <= 1) return false;
  return visibleToastIndex > 0;
}

type ToastWithLayoutProps = {
  height?: number | null | undefined;
  transitionStatus?: "starting" | "ending" | undefined;
};

type VisibleToastLayoutItem<TToast extends object> = {
  toast: TToast;
  visibleIndex: number;
  offsetY: number;
};

export function buildVisibleToastLayout<TToast extends object>(
  visibleToasts: readonly (TToast & ToastWithLayoutProps)[],
): {
  frontmostHeight: number;
  items: VisibleToastLayoutItem<TToast & ToastWithLayoutProps>[];
} {
  // Two parallel cursors:
  //   - `full*`  advances on every toast, so an ending toast keeps the slot it
  //     occupied before dismissal and its exit transform starts from there.
  //   - `live*`  advances only on non-ending toasts, so live toasts reflow past
  //     the vacated slot in parallel with the exit animation.
  let fullIndex = 0;
  let fullOffsetY = 0;
  let liveIndex = 0;
  let liveOffsetY = 0;

  const items = visibleToasts.map((toast) => {
    const height = normalizeToastHeight(toast.height);
    if (toast.transitionStatus === "ending") {
      const item = { toast, visibleIndex: fullIndex, offsetY: fullOffsetY };
      fullOffsetY += height;
      fullIndex += 1;
      return item;
    }
    const item = { toast, visibleIndex: liveIndex, offsetY: liveOffsetY };
    fullOffsetY += height;
    fullIndex += 1;
    liveOffsetY += height;
    liveIndex += 1;
    return item;
  });

  // The stack sizes to the first toast that's staying on screen.
  const frontmostLiveToast = visibleToasts.find((toast) => toast.transitionStatus !== "ending");
  return { frontmostHeight: normalizeToastHeight(frontmostLiveToast?.height), items };
}

function normalizeToastHeight(height: number | null | undefined): number {
  return typeof height === "number" && Number.isFinite(height) && height > 0 ? height : 0;
}
