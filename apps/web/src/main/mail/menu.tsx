import type { ComponentProps, ReactNode } from "react";
import { ContextMenu as ContextPrimitive, DropdownMenu as Menu } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { cn, restoreFocusForKeyboardOnly } from "./ui";

/**
 * Otter Code-style dropdown menus (renderer-drawn, Radix underneath).
 * Styling follows Codex's floating cards: the popover surface, 14px radius,
 * 32px rows with a rounded soft highlight.
 */

const POPUP =
  "dropdown-glass z-[130] max-h-(--radix-dropdown-menu-content-available-height) min-w-44 overflow-y-auto rounded-xl p-1.5 text-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]";

const ROW =
  "relative flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-1 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-64 data-[highlighted]:bg-foreground/[0.07] data-[highlighted]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

/** Menus are non-modal. A modal Radix menu sets `pointer-events: none` on
 *  <body>; when one of its items opens a Dialog, the two layers can race over
 *  restoring that value on close — leaving the whole window unclickable
 *  (e.g. Delete Forever from a Trash row). Outside clicks still dismiss the
 *  menu. */
export function DropdownMenu(props: ComponentProps<typeof Menu.Root>) {
  return <Menu.Root modal={false} {...props} />;
}

export function DropdownMenuTrigger(props: ComponentProps<typeof Menu.Trigger>) {
  return <Menu.Trigger {...props} />;
}

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "start",
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        onCloseAutoFocus={restoreFocusForKeyboardOnly}
        className={cn(POPUP, className)}
        {...props}
      />
    </Menu.Portal>
  );
}

export function DropdownMenuItem({
  className,
  icon,
  accelerator,
  color,
  children,
  ...props
}: ComponentProps<typeof Menu.Item> & {
  icon?: ReactNode;
  /** Shortcut shown right-aligned. */
  accelerator?: string;
  color?: "red";
}) {
  return (
    <Menu.Item
      className={cn(
        ROW,
        color === "red" &&
          "text-destructive-foreground [&_svg:not([class*='text-'])]:text-destructive-foreground",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {accelerator ? (
        <kbd className="ms-auto font-sans text-xs tracking-widest text-muted-foreground">
          {accelerator}
        </kbd>
      ) : null}
    </Menu.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.CheckboxItem>) {
  return (
    <Menu.CheckboxItem className={cn(ROW, "ps-8", className)} {...props}>
      <span className="absolute start-2.5 flex size-4 items-center justify-center">
        <Menu.ItemIndicator>
          <CheckIcon className="size-3.5 text-foreground" />
        </Menu.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <Menu.Separator className={cn("mx-2.5 my-1 h-px bg-border/70", className)} />;
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn("px-2.5 pt-1.5 pb-1 text-[13px] text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * Submenu with a text trigger (`label`), like the native menu's API, or with
 * a `trigger` of its own (a row's ⋯ button).
 */
export function DropdownMenuSub({
  label,
  trigger,
  inset,
  children,
}: {
  label: string;
  trigger?: ReactNode;
  /** Indent past the check column, when siblings are checkbox items. */
  inset?: boolean;
  children: ReactNode;
}) {
  return (
    <Menu.Sub>
      {trigger ? (
        <Menu.SubTrigger asChild aria-label={label}>
          {trigger}
        </Menu.SubTrigger>
      ) : (
        <Menu.SubTrigger
          className={cn(ROW, inset && "ps-8", "data-[state=open]:bg-foreground/[0.07]")}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronRightIcon className="ms-auto size-3.5 text-muted-foreground" />
        </Menu.SubTrigger>
      )}
      <Menu.Portal>
        <Menu.SubContent sideOffset={4} alignOffset={-4} collisionPadding={8} className={POPUP}>
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

/*
 * Right-click menus with the same look. String icon names (SF Symbols, from
 * the old native menu API) are ignored; React icons render like dropdown
 * items.
 */

/** Non-modal for the same reason as {@link DropdownMenu}. */
export function ContextMenu(props: ComponentProps<typeof ContextPrimitive.Root>) {
  return <ContextPrimitive.Root modal={false} {...props} />;
}

/** Without `asChild` the trigger adds no box (display: contents), like the native one. */
export function ContextMenuTrigger({
  asChild,
  className,
  ...props
}: ComponentProps<typeof ContextPrimitive.Trigger>) {
  return (
    <ContextPrimitive.Trigger
      asChild={asChild}
      className={asChild ? className : cn("contents", className)}
      {...props}
    />
  );
}

export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof ContextPrimitive.Content>) {
  return (
    <ContextPrimitive.Portal>
      <ContextPrimitive.Content
        collisionPadding={8}
        onCloseAutoFocus={restoreFocusForKeyboardOnly}
        className={cn(POPUP, "max-h-(--radix-context-menu-content-available-height)", className)}
        {...props}
      />
    </ContextPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  icon,
  accelerator,
  color,
  children,
  ...props
}: ComponentProps<typeof ContextPrimitive.Item> & {
  icon?: ReactNode;
  accelerator?: string;
  color?: "red";
}) {
  return (
    <ContextPrimitive.Item
      className={cn(
        ROW,
        color === "red" &&
          "text-destructive-foreground [&_svg:not([class*='text-'])]:text-destructive-foreground",
        className,
      )}
      {...props}
    >
      {typeof icon === "string" ? null : icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {accelerator ? (
        <kbd className="ms-auto font-sans text-xs tracking-widest text-muted-foreground">
          {accelerator}
        </kbd>
      ) : null}
    </ContextPrimitive.Item>
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof ContextPrimitive.CheckboxItem>) {
  return (
    <ContextPrimitive.CheckboxItem className={cn(ROW, "ps-8", className)} {...props}>
      <span className="absolute start-2.5 flex size-4 items-center justify-center">
        <ContextPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5 text-foreground" />
        </ContextPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </ContextPrimitive.CheckboxItem>
  );
}

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <ContextPrimitive.Separator className={cn("mx-2.5 my-1 h-px bg-border/70", className)} />;
}

export function ContextMenuSub({
  label,
  inset,
  children,
}: {
  label: string;
  icon?: string;
  /** Indent past the check column, when siblings are checkbox items. */
  inset?: boolean;
  children: ReactNode;
}) {
  return (
    <ContextPrimitive.Sub>
      <ContextPrimitive.SubTrigger
        className={cn(ROW, inset && "ps-8", "data-[state=open]:bg-foreground/[0.07]")}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRightIcon className="ms-auto size-3.5 text-muted-foreground" />
      </ContextPrimitive.SubTrigger>
      <ContextPrimitive.Portal>
        <ContextPrimitive.SubContent
          sideOffset={4}
          alignOffset={-4}
          collisionPadding={8}
          className={cn(POPUP, "max-h-(--radix-context-menu-content-available-height)")}
        >
          {children}
        </ContextPrimitive.SubContent>
      </ContextPrimitive.Portal>
    </ContextPrimitive.Sub>
  );
}
