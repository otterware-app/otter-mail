import { createElement, useSyncExternalStore } from "react";
import {
  DEFAULT_KEYBINDINGS,
  isKeybindingCommand,
  labelMoveCommand,
  labelMoveName,
  type KeybindingCommand,
  type KeybindingRule,
} from "./commands";
import {
  formatShortcut,
  normalizeKey,
  normalizeWhen,
  parseShortcut,
  parseWhen,
  type Shortcut,
  type WhenNode,
} from "./keys";

/**
 * The live keybindings (Otter Code's merge model): the user's rules (Settings
 * → Keybindings, stored by the backend and synced with the Otter account)
 * replace every default of a command they mention; other commands keep their
 * defaults. Later rules win at dispatch. Every window loads them and re-reads
 * them on the `keybindings:updated` broadcast.
 */

export type ResolvedKeybinding = {
  rule: KeybindingRule;
  shortcut: Shortcut;
  whenAst?: WhenNode;
};

type FileResult = {
  rules: { key: string; command: string; when?: string }[] | null;
};

type State = {
  /** Effective rules in order (defaults not overridden, then the file's). */
  rules: KeybindingRule[];
  resolved: ResolvedKeybinding[];
  loaded: boolean;
};

const ipc = <T>(channel: string, params?: unknown) =>
  window.desktopBridge.invoke<T>(channel, params);

function resolve(rules: KeybindingRule[]): ResolvedKeybinding[] {
  const out: ResolvedKeybinding[] = [];
  for (const rule of rules) {
    const shortcut = parseShortcut(rule.key);
    if (!shortcut) continue;
    if (rule.when) {
      const whenAst = parseWhen(rule.when);
      if (!whenAst) continue;
      out.push({ rule, shortcut, whenAst });
    } else {
      out.push({ rule, shortcut });
    }
  }
  return out;
}

export function mergeWithDefaults(custom: KeybindingRule[]): KeybindingRule[] {
  const overridden = new Set(custom.map((r) => r.command));
  return [...DEFAULT_KEYBINDINGS.filter((r) => !overridden.has(r.command)), ...custom];
}

function stateFor(file: FileResult | null): State {
  const custom: KeybindingRule[] = [];
  for (const entry of file?.rules ?? []) {
    // A command this version doesn't have (renamed, or from a newer one) is skipped.
    if (!isKeybindingCommand(entry.command)) continue;
    const rule: KeybindingRule = { key: entry.key, command: entry.command };
    if (entry.when) rule.when = entry.when;
    custom.push(rule);
  }
  const rules = mergeWithDefaults(custom);
  return { rules, resolved: resolve(rules), loaded: file !== null };
}

let state: State = stateFor(null);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(): Promise<void> {
  try {
    state = stateFor(await ipc<FileResult>("keybindings:read"));
    emit();
  } catch (error) {
    console.log("[Keybindings:load] failed", { error: String(error) });
  }
}

let started = false;
function ensureStarted(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void load();
  window.desktopBridge.on("keybindings:updated", () => void load());
}

export function getKeybindings(): State {
  ensureStarted();
  return state;
}

function subscribe(listener: () => void): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useKeybindingsState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

// ── Editing (settings) ───────────────────────────────────────────────────────

const sameRule = (a: KeybindingRule, b: KeybindingRule) =>
  a.command === b.command &&
  normalizeKey(a.key) === normalizeKey(b.key) &&
  normalizeWhen(a.when) === normalizeWhen(b.when);

async function write(rules: KeybindingRule[]): Promise<void> {
  // Optimistic: the settings list updates now; the broadcast re-read confirms.
  state = { ...stateFor({ rules }), loaded: true };
  emit();
  await ipc("keybindings:write", { rules });
}

/** Adds `rule` (or swaps it in for `replace`), keeping everything else. */
export async function upsertKeybinding(
  rule: KeybindingRule,
  replace?: KeybindingRule,
): Promise<void> {
  console.log("[Keybindings:upsert]", { command: rule.command, key: rule.key, when: rule.when });
  const clean: KeybindingRule = { key: rule.key.trim(), command: rule.command };
  if (rule.when?.trim()) clean.when = rule.when.trim();
  const kept = state.rules.filter((r) => !sameRule(r, clean) && !(replace && sameRule(r, replace)));
  await write([...kept, clean]);
}

export async function removeKeybinding(rule: KeybindingRule): Promise<void> {
  console.log("[Keybindings:remove]", { command: rule.command, key: rule.key });
  await write(state.rules.filter((r) => !sameRule(r, rule)));
}

/** Keeps label shortcuts on a renamed (or re-nested) label and the labels under it. */
export async function renameLabelKeybindings(from: string, to: string): Promise<void> {
  let changed = false;
  const rules = state.rules.map((rule) => {
    const name = labelMoveName(rule.command);
    if (name === null || (name !== from && !name.startsWith(`${from}/`))) return rule;
    changed = true;
    return { ...rule, command: labelMoveCommand(to + name.slice(from.length)) };
  });
  if (!changed) return;
  console.log("[Keybindings:renameLabel]", { from, to });
  await write(rules);
}

export function isDefaultRule(rule: KeybindingRule): boolean {
  return DEFAULT_KEYBINDINGS.some((d) => sameRule(d, rule));
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** The label of a command's first effective binding (`⌘K`, `G then I`), or null. */
export function shortcutLabelFor(
  resolved: ResolvedKeybinding[],
  command: KeybindingCommand,
): string | null {
  const hit = resolved.find((r) => r.rule.command === command);
  return hit ? formatShortcut(hit.shortcut) : null;
}

/** Live shortcut label for a command, for tooltips, menus, and the palette. */
export function useShortcutLabel(command: KeybindingCommand | undefined): string | undefined {
  const { resolved } = useKeybindingsState();
  return command ? (shortcutLabelFor(resolved, command) ?? undefined) : undefined;
}

/** Inline shortcut text (e.g. "⌘↩ send"); nothing when the command is unbound. */
export function ShortcutText({
  command,
  suffix,
  className,
}: {
  command: KeybindingCommand;
  suffix?: string;
  className?: string;
}) {
  const label = useShortcutLabel(command);
  if (!label) return null;
  return createElement("span", { className }, suffix ? `${label} ${suffix}` : label);
}
