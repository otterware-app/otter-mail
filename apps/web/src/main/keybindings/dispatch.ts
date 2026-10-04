import { useLatest } from "../use-latest";
import { useEffect } from "react";
import { labelMoveName, type CommandHandlerKey, type KeybindingCommand } from "./commands";
import { evaluateWhen, isModifierOnly, matchesStroke, type WhenContext } from "./keys";
import { getKeybindings, type ResolvedKeybinding } from "./store";
import { isOverlayOpen } from "../gmail/keyboard";

/**
 * One window-level dispatcher resolves every keydown against the live
 * keybindings, and components register what each command does. Resolution
 * walks rules last → first (custom rules win over defaults); a handler that
 * returns `false` passes, so the next matching rule gets a chance.
 *
 * Context keys come from the event (editableFocus, dialogOpen) plus values
 * components publish with `useKeybindingContext` (settingsOpen, messageOpen).
 */

/** Return `false` when the command doesn't apply right now. `arg` is the
    label name for `label.move:<name>` rules. */
export type CommandHandler = (event: KeyboardEvent, arg?: string) => boolean | void;

const handlers = new Map<CommandHandlerKey, { run: CommandHandler }[]>();

/** Where a rule's command is handled, plus its argument (label moves). */
function handlerFor(command: KeybindingCommand): { key: CommandHandlerKey; arg?: string } {
  const labelName = labelMoveName(command);
  if (labelName !== null) return { key: "label.move", arg: labelName };
  return { key: command as CommandHandlerKey };
}

const published = new Map<string, boolean>();

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
      null
  );
}

export function keybindingContext(event?: KeyboardEvent): WhenContext {
  const context: WhenContext = {
    editableFocus: isEditable(event?.target ?? document.activeElement),
    dialogOpen: isOverlayOpen(),
  };
  for (const [key, value] of published) context[key] = value;
  return context;
}

function run(command: KeybindingCommand, event: KeyboardEvent): boolean {
  const { key, arg } = handlerFor(command);
  const list = handlers.get(key);
  if (!list?.length) return false;
  // The most recently mounted owner handles it.
  return list[list.length - 1].run(event, arg) !== false;
}

const SEQUENCE_TIMEOUT_MS = 1500;
let pending: { rules: ResolvedKeybinding[]; at: number } | null = null;

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || isModifierOnly(event) || event.isComposing) return;
  if (event.target instanceof Element && event.target.closest("[data-keybinding-capture]")) return;
  const { resolved } = getKeybindings();
  const context = keybindingContext(event);
  const handled = () => {
    event.preventDefault();
    pending = null;
  };

  // Second stroke of a sequence ("g" then "i").
  if (pending) {
    const { rules, at } = pending;
    pending = null;
    if (Date.now() - at < SEQUENCE_TIMEOUT_MS) {
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i];
        if (!matchesStroke(event, r.shortcut[1]) || !evaluateWhen(r.whenAst, context)) continue;
        if (run(r.rule.command, event)) return handled();
      }
    }
  }

  for (let i = resolved.length - 1; i >= 0; i--) {
    const r = resolved[i];
    if (r.shortcut.length !== 1) continue;
    if (!matchesStroke(event, r.shortcut[0]) || !evaluateWhen(r.whenAst, context)) continue;
    if (run(r.rule.command, event)) return handled();
  }

  // First stroke of a sequence: wait for the second.
  const starts = resolved.filter(
    (r) =>
      r.shortcut.length === 2 &&
      handlers.get(handlerFor(r.rule.command).key)?.length &&
      matchesStroke(event, r.shortcut[0]) &&
      evaluateWhen(r.whenAst, context),
  );
  if (starts.length > 0) {
    event.preventDefault();
    pending = { rules: starts, at: Date.now() };
  }
}

/** Installs the dispatcher for this window (once, in the root view). */
export function useKeybindingDispatcher(): void {
  useEffect(() => {
    getKeybindings();
    window.addEventListener("keydown", onKeyDown);
    // Menu accelerators and focused browser pages don't deliver DOM keydowns.
    const off = window.desktopBridge.on("keybindings:keydown", (params) => {
      const event = new KeyboardEvent("keydown", {
        ...(params as KeyboardEventInit),
        bubbles: true,
        cancelable: true,
      });
      (document.activeElement ?? document.body).dispatchEvent(event);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      off();
    };
  }, []);
}

/** Registers what commands do while the calling component is mounted. */
export function useCommandHandlers(map: Partial<Record<CommandHandlerKey, CommandHandler>>): void {
  const ref = useLatest(map);
  const commands = (Object.keys(map) as CommandHandlerKey[]).sort().join(",");
  useEffect(() => {
    const entries = (commands ? commands.split(",") : []).map((c) => {
      const command = c as CommandHandlerKey;
      const entry = { run: (e: KeyboardEvent, arg?: string) => ref.current[command]?.(e, arg) };
      handlers.set(command, [...(handlers.get(command) ?? []), entry]);
      return [command, entry] as const;
    });
    return () => {
      for (const [command, entry] of entries) {
        handlers.set(
          command,
          (handlers.get(command) ?? []).filter((e) => e !== entry),
        );
      }
    };
  }, [commands, ref]);
}

/** Publishes a `when` context key (e.g. messageOpen) while mounted. */
export function useKeybindingContext(name: string, value: boolean): void {
  useEffect(() => {
    published.set(name, value);
    return () => {
      published.delete(name);
    };
  }, [name, value]);
}

/** For element-local keys (e.g. ⌘↩ inside a composer): does the event trigger `command`? */
export function matchesCommand(event: KeyboardEvent, command: KeybindingCommand): boolean {
  const context = keybindingContext(event);
  return getKeybindings().resolved.some(
    (r) =>
      r.rule.command === command &&
      r.shortcut.length === 1 &&
      matchesStroke(event, r.shortcut[0]) &&
      evaluateWhen(r.whenAst, context),
  );
}
