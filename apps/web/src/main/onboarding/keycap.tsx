import type { KeybindingCommand } from "../keybindings/commands";
import { strokeTokens } from "../keybindings/keys";
import { useKeybindingsState } from "../keybindings/store";
import { cn } from "../gmail/ui";

/** One key, drawn as a keycap. */
export function Keycap({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-foreground/15 bg-foreground/[0.06] px-1.5 font-sans text-xs font-medium text-foreground shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--foreground)_14%,transparent)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * A command's live shortcut as keycaps (`⌘` `K`, `G` then `I`), so a rebound
 * key shows as the user has it. Nothing when the command is unbound.
 */
/* oxlint-disable react/no-array-index-key -- Shortcut strokes have fixed positions and can repeat the same key. */
export function ShortcutKeys({
  command,
  className,
}: {
  command: KeybindingCommand;
  className?: string;
}) {
  const { resolved } = useKeybindingsState();
  const binding = resolved.find((r) => r.rule.command === command);
  if (!binding) return null;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {binding.shortcut.map((stroke, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 ? <span className="text-xs text-muted-foreground">then</span> : null}
          {strokeTokens(stroke).map((token) => (
            <Keycap key={token}>{token}</Keycap>
          ))}
        </span>
      ))}
    </span>
  );
}
/* oxlint-enable react/no-array-index-key */
