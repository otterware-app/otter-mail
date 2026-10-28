import { Toast } from "@base-ui/react/toast";
import { useState, type CSSProperties, type ReactNode } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  InfoIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";

import { HintTooltip, buttonClass, cn } from "./ui";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
} from "./toast-layout";

/**
 * App toasts — Otter Code's toast system (Base UI toasts in a stacked glass
 * viewport, components/ui/toast.tsx there), without its thread scoping.
 * `toast.success("Archived", { action: { label: "Undo", onClick } })` and
 * friends add one; the returned id updates or closes it.
 */

type ToastData = {
  onClose?: (() => void) | undefined;
  hideCopyButton?: boolean;
};

const toastManager = Toast.createToastManager<ToastData>();
export type ToastId = ReturnType<typeof toastManager.add>;

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: LoaderCircleIcon,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

type ToastType = keyof typeof TOAST_ICONS;

/** Visually shorten long error bodies; copying still takes the full text. */
const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") return undefined;
  return description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS ? undefined : "line-clamp-4";
}

/** Dismiss-only: circular control overlapping the card corner (iOS notification–style). */
const toastCornerDismissClass = "absolute z-20 -top-1.5 -right-1.5";
const toastCornerOrbClass = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-popover/92 text-muted-foreground shadow-sm outline-none backdrop-blur-sm",
  "hover:bg-popover hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1",
);

function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const label = copied ? "Copied error" : "Copy error";
  return (
    <HintTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent-surface hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? (
          <CheckIcon className="size-3.5 text-success" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
    </HintTooltip>
  );
}

function ToastBody({
  type,
  description,
  actionProps,
  data,
}: {
  type: string | undefined;
  description: unknown;
  actionProps: { children?: ReactNode } | undefined;
  data: ToastData | undefined;
}) {
  const Icon = type ? TOAST_ICONS[type as ToastType] : null;
  const copyErrorText =
    type === "error" && typeof description === "string" && !data?.hideCopyButton
      ? description
      : null;
  const hasAction = hasVisibleToastAction(actionProps);
  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 gap-2">
          {Icon ? (
            <div
              className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
              data-slot="toast-icon"
            >
              <Icon
                className={cn(
                  "in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning",
                  type === "loading" && "animate-spin opacity-80",
                )}
              />
            </div>
          ) : null}
          <Toast.Title className="min-w-0 wrap-break-word font-medium" data-slot="toast-title" />
        </div>
        <Toast.Description
          className={cn(
            "min-w-0 select-text wrap-break-word text-muted-foreground",
            errorDescriptionClampClass(type, description),
          )}
          data-slot="toast-description"
        />
      </div>
      {copyErrorText !== null || hasAction ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
          {hasAction ? (
            <Toast.Action
              className={buttonClass("ghost", "sm", "shrink-0 rounded-full text-sm")}
              data-slot="toast-action"
            >
              {actionProps?.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export function ToastProvider({
  children,
  position = "top-right",
}: {
  children: ReactNode;
  position?: ToastPosition;
}) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ToastData>();
  const isTop = position.startsWith("top");
  const layout = buildVisibleToastLayout(toasts);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:var(--workspace-topbar-height)] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={{ "--toast-frontmost-height": `${layout.frontmostHeight}px` } as CSSProperties}
      >
        {layout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            layout.items.length,
          );
          const hasTrailingControls =
            hasVisibleToastAction(toast.actionProps) ||
            (toast.type === "error" && typeof toast.description === "string");
          return (
            <Toast.Root
              className={cn(
                "dropdown-glass absolute z-[calc(9999-var(--toast-index))] w-full overflow-visible select-none rounded-xl text-popover-foreground shadow-lg shadow-black/10 dark:shadow-black/30 [transition:transform_.35s_cubic-bezier(.22,1,.36,1),opacity_.25s,height_.15s]",
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                // Gap fill for hover
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                // Behind + collapsed = peek height only (content hidden).
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-limited:opacity-0",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                // In and out at the corner: a short slide and a fade, not across the screen.
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(--spacing(6))_translateY(var(--toast-calc-offset-y))]",
                "data-starting-style:opacity-0",
                "data-ending-style:opacity-0",
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(--spacing(6))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <div className={toastCornerDismissClass}>
                <button
                  aria-label="Dismiss notification"
                  className={toastCornerOrbClass}
                  data-slot="toast-close"
                  onClick={() => {
                    toast.data?.onClose?.();
                    toastManager.close(toast.id);
                  }}
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2.25} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  "pointer-events-auto flex min-h-0 items-center justify-between gap-2 overflow-y-visible py-3 pl-4 text-sm transition-opacity duration-250 [overflow-x:clip] data-expanded:opacity-100",
                  hasTrailingControls ? "pr-6" : "pr-10",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastBody
                  type={toast.type}
                  description={toast.description}
                  actionProps={toast.actionProps}
                  data={toast.data}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

// ── API ──────────────────────────────────────────────────────────────────────

export type ToastOptions = {
  description?: ReactNode;
  /** Auto-dismiss after this many ms; 0 keeps it until closed. */
  timeout?: number;
  /** A button on the toast (e.g. Undo). The toast closes when it's clicked. */
  action?: { label: ReactNode; onClick: () => void };
  /** Runs when the toast is dismissed with its × button. */
  onClose?: () => void;
  /** Runs once the toast is gone, however it closed. */
  onRemove?: () => void;
};

/** The toast's button: closes the toast, then runs the action. Updates skip
    undefined keys, so "no action" is an explicit empty one. */
function actionPropsFor(id: () => ToastId, action: ToastOptions["action"]) {
  if (!action) return { children: null };
  return {
    children: action.label,
    onClick: () => {
      toastManager.close(id());
      action.onClick();
    },
  };
}

function show(type: ToastType | undefined, title: ReactNode, options: ToastOptions = {}): ToastId {
  const id: ToastId = toastManager.add({
    type,
    title,
    description: options.description,
    timeout: options.timeout,
    data: { onClose: options.onClose },
    onRemove: options.onRemove,
    actionProps: actionPropsFor(() => id, options.action),
  });
  return id;
}

export const toast = Object.assign(
  (title: ReactNode, options?: ToastOptions) => show(undefined, title, options),
  {
    success: (title: ReactNode, options?: ToastOptions) => show("success", title, options),
    error: (title: ReactNode, options?: ToastOptions) => show("error", title, options),
    info: (title: ReactNode, options?: ToastOptions) => show("info", title, options),
    warning: (title: ReactNode, options?: ToastOptions) => show("warning", title, options),
    loading: (title: ReactNode, options?: ToastOptions) =>
      show("loading", title, { timeout: 0, ...options }),
    /** Replaces a toast's content in place (e.g. "Sending…" → "Sent"). */
    update: (
      id: ToastId,
      type: ToastType | undefined,
      title: ReactNode,
      options: ToastOptions = {},
    ) =>
      toastManager.update(id, {
        type,
        title,
        description: options.description,
        timeout: options.timeout ?? 5000,
        data: { onClose: options.onClose },
        actionProps: actionPropsFor(() => id, options.action),
      }),
    close: (id?: ToastId) => toastManager.close(id),
  },
);
