import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import {
  ChevronDownIcon,
  EllipsisIcon,
  PlusIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { Dialog } from "~/components/ui/dialog";
import { Text } from "~/components/ui/text";
import { toast } from "../gmail/toast";
import { Btn, HintTooltip, IconBtn, cn, restoreFocusForKeyboardOnly } from "../gmail/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../gmail/menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../gmail/select";
import {
  DEFAULT_KEYBINDINGS,
  IN_MAIL,
  KEYBINDING_COMMANDS,
  WHEN_VARIABLES,
  commandLabel,
  labelMoveCommand,
  labelMoveName,
  type KeybindingCommand,
  type KeybindingRule,
} from "../keybindings/commands";
import {
  normalizeKey,
  normalizeWhen,
  parseShortcut,
  parseWhen,
  strokeFromEvent,
  strokeHasModifier,
  formatShortcut,
  whenIdentifiers,
} from "../keybindings/keys";
import {
  isDefaultRule,
  removeKeybinding,
  upsertKeybinding,
  useKeybindingsState,
} from "../keybindings/store";
import { useCommandHandlers } from "../keybindings/dispatch";
import { useAccounts, useAllAccountLabels } from "../gmail/hooks";
import {
  SettingsGroup,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSectionHeader,
} from "./settings-ui";
import { keybindingSearchAnchorId, searchableSetting } from "./settings-search";

/**
 * Settings › Keybindings, after Otter Code's panel: every binding as a row
 * (command, When clause, keys), click the keys to record new ones, edit the
 * When clause in a popover, and ⚠ for conflicts or unknown conditions.
 */

type Row = { id: string; rule: KeybindingRule; source: "Default" | "Custom" };

const KNOWN_VARIABLES = new Set<string>(WHEN_VARIABLES);

// ── Logic ────────────────────────────────────────────────────────────────────

/** Other rows on the same keys whose conditions can both hold (Otter Code's test). */
function conflictLabels(rows: Row[], id: string, key: string, when: string | undefined) {
  const norm = normalizeKey(key);
  const w = normalizeWhen(when);
  return rows
    .filter((r) => r.id !== id && normalizeKey(r.rule.key) === norm)
    .filter((r) => {
      const other = normalizeWhen(r.rule.when);
      return !w || !other || w === other;
    })
    .map((r) => commandLabel(r.rule.command));
}

function unknownVariables(when: string | undefined): string[] {
  const ast = when ? parseWhen(when) : null;
  return ast ? [...whenIdentifiers(ast)].filter((v) => !KNOWN_VARIABLES.has(v)) : [];
}

function warningFor(rows: Row[], id: string, key: string, when: string | undefined) {
  if (!parseShortcut(key)) return "This key can't be parsed, so the binding is ignored.";
  if (when?.trim() && !parseWhen(when))
    return "This condition can't be parsed, so the binding is ignored.";
  const conflicts = conflictLabels(rows, id, key, when);
  if (conflicts.length > 0) {
    const shown = conflicts.slice(0, 3).join(", ");
    return `Conflicts with ${shown}${conflicts.length > 3 ? ", and more" : ""}. The most recent matching binding wins when both conditions can apply.`;
  }
  const unknown = unknownVariables(when);
  if (unknown.length > 0)
    return `Otter Mail does not recognize ${unknown.join(", ")}, so it's always false.`;
  return null;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** A key string as plain glyphs: ⇧⌘K, and "then" between sequence strokes. */
/* oxlint-disable react/no-array-index-key -- Shortcut strokes have fixed positions and can repeat the same key. */
function KeyChips({ value }: { value: string }) {
  const shortcut = parseShortcut(value);
  if (!shortcut) return <span className="font-mono text-xs text-muted-foreground">{value}</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-foreground/85">
      {shortcut.map((stroke, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="text-xs text-muted-foreground/70">then</span> : null}
          <span className="tracking-[0.12em] last:tracking-normal">{formatShortcut([stroke])}</span>
        </Fragment>
      ))}
    </span>
  );
}
/* oxlint-enable react/no-array-index-key */

const SEQUENCE_WINDOW_MS = 1000;

/** The keys cell: chips at rest, a capture field while recording. */
function KeyControl({
  value,
  recording,
  onRecordingChange,
  onChange,
}: {
  value: string;
  recording: boolean;
  onRecordingChange: (recording: boolean) => void;
  onChange: (key: string) => void;
}) {
  const [partial, setPartial] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (recording) inputRef.current?.focus();
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the local recording/editing session when its binding or dialog changes.
    else setPartial(null);
  }, [recording]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (!recording) {
    return (
      <button
        type="button"
        onClick={() => onRecordingChange(true)}
        aria-label="Change shortcut"
        className="-me-2.5 inline-flex h-7 cursor-pointer items-center rounded-full px-2.5 outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {value ? (
          <KeyChips value={value} />
        ) : (
          <span className="text-[13px] text-muted-foreground">Record shortcut</span>
        )}
      </button>
    );
  }

  const finish = (key: string) => {
    if (timer.current) clearTimeout(timer.current);
    setPartial(null);
    onChange(key);
    onRecordingChange(false);
  };

  return (
    <div data-keybinding-capture="" className="relative">
      <input
        ref={inputRef}
        readOnly
        value={partial ? `${partial} …` : ""}
        placeholder="Press shortcut"
        onBlur={() => (partial ? finish(partial) : onRecordingChange(false))}
        onKeyDown={(e) => {
          if (e.key === "Tab") return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape" && !partial) {
            onRecordingChange(false);
            return;
          }
          const stroke = strokeFromEvent(e.nativeEvent);
          if (!stroke) return;
          if (partial) {
            finish(`${partial} ${stroke}`);
            return;
          }
          // A bare key may start a sequence ("g" then "i"): wait briefly.
          if (!strokeHasModifier(stroke)) {
            setPartial(stroke);
            timer.current = setTimeout(() => finish(stroke), SEQUENCE_WINDOW_MS);
            return;
          }
          finish(stroke);
        }}
        className="h-7 w-40 rounded-full border border-focus-ring/60 bg-canvas px-3 text-right font-mono text-xs text-foreground outline-none ring-[3px] ring-focus-ring/16 placeholder:font-sans placeholder:text-placeholder"
      />
    </div>
  );
}

/** "When  !editableFocus ⌄" — opens the condition editor. */
function WhenControl({ value, onChange }: { value: string; onChange: (when: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the local recording/editing session when its binding or dialog changes.
    if (open) setDraft(value);
  }, [open, value]);
  const valid = !draft.trim() || parseWhen(draft) !== null;
  const unknown = valid ? unknownVariables(draft) : [];
  // Variables join with && unless the expression ends in an operator.
  const insertVariable = (name: string) =>
    setDraft((d) => {
      const t = d.trim();
      if (!t) return name;
      if (/[!(]$/.test(t)) return `${t}${name}`;
      if (/(&&|\|\|)$/.test(t)) return `${t} ${name}`;
      return `${t} && ${name}`;
    });
  const insertOperator = (op: "!" | "&&" | "||") =>
    setDraft((d) => {
      const t = d.trim();
      if (op === "!") return t && !/[!(]$/.test(t) ? `${t} && !` : `${t}!`;
      return t ? `${t} ${op} ` : t;
    });
  const apply = () => {
    if (!valid) return;
    onChange(draft.trim() ? normalizeWhen(draft) : "");
    setOpen(false);
  };

  return (
    <span className="flex h-6 items-center gap-1.5">
      <span className="text-xs leading-none text-muted-foreground/70">When</span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-6 min-w-0 shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 text-xs outline-none hover:bg-accent-surface focus-visible:ring-2 focus-visible:ring-focus-ring",
              value ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="truncate font-mono">{value || "Always"}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onCloseAutoFocus={restoreFocusForKeyboardOnly}
            className="dropdown-glass z-[130] w-[min(30rem,calc(100vw-2rem))] space-y-3 rounded-2xl p-3.5 text-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] outline-none dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]"
          >
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">When</span>
              <div className="flex items-center gap-1">
                {(["!", "&&", "||"] as const).map((op) => (
                  <Btn
                    key={op}
                    variant="ghost-muted"
                    size="xs"
                    className="font-mono"
                    onClick={() => insertOperator(op)}
                  >
                    {op}
                  </Btn>
                ))}
              </div>
            </div>
            <input
              autoFocus
              value={draft}
              spellCheck={false}
              placeholder="Always"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  apply();
                }
              }}
              className={cn(
                "h-8 w-full rounded-lg border bg-surface-raised/60 px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-placeholder focus-visible:bg-canvas focus-visible:ring-[3px]",
                valid
                  ? "border-input focus-visible:border-focus-ring focus-visible:ring-focus-ring/24"
                  : "border-destructive focus-visible:ring-destructive/20",
              )}
            />
            {!valid ? (
              <p className="text-xs text-destructive-foreground">
                Use variables with !, &&, ||, and parentheses.
              </p>
            ) : unknown.length > 0 ? (
              <p className="text-xs text-warning-foreground">
                Unknown: {unknown.join(", ")} (always false).
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {WHEN_VARIABLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => insertVariable(name)}
                  className="inline-flex h-6 cursor-pointer items-center rounded-lg border border-border/70 px-1.5 font-mono text-2xs text-muted-foreground hover:bg-accent-surface hover:text-foreground"
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <Btn variant="ghost-muted" size="xs" onClick={() => setDraft("")}>
                Always
              </Btn>
              <div className="flex items-center gap-1.5">
                <Btn variant="ghost" size="xs" onClick={() => setOpen(false)}>
                  Cancel
                </Btn>
                <Btn variant="primary" size="xs" disabled={!valid} onClick={apply}>
                  Done
                </Btn>
              </div>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </span>
  );
}

function WarningIcon({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <HintTooltip label={message}>
      <span
        tabIndex={0}
        aria-label={message}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-warning-foreground outline-none hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <TriangleAlertIcon className="size-3.5" />
      </span>
    </HintTooltip>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-4.5 items-center rounded-sm border border-border/80 px-1 text-2xs font-medium leading-none text-muted-foreground">
      {children}
    </span>
  );
}

const save = (rule: KeybindingRule, replace?: KeybindingRule) =>
  upsertKeybinding(rule, replace).catch((error) => {
    toast.error(`Couldn't save keybinding: ${String(error)}`);
  });

// ── Rows ─────────────────────────────────────────────────────────────────────

function KeybindingRow({ row, rows, searchId }: { row: Row; rows: Row[]; searchId?: string }) {
  const { rule } = row;
  const [keyDraft, setKeyDraft] = useState(rule.key);
  const [whenDraft, setWhenDraft] = useState(rule.when ?? "");
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the local recording/editing session when its binding or dialog changes.
    setKeyDraft(rule.key);
    setWhenDraft(rule.when ?? "");
  }, [rule.key, rule.when]);
  const dirty =
    normalizeKey(keyDraft) !== normalizeKey(rule.key) ||
    normalizeWhen(whenDraft) !== normalizeWhen(rule.when);
  const defaults = DEFAULT_KEYBINDINGS.filter((d) => d.command === rule.command);
  const warning = warningFor(rows, row.id, keyDraft, whenDraft);
  const commit = () =>
    void save({ command: rule.command, key: keyDraft, when: whenDraft || undefined }, rule);

  return (
    <SettingsSearchTarget
      id={searchId}
      data-slot="settings-row"
      className="group/row flex min-h-14 items-center gap-6 px-[17px] py-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-h-5 items-center gap-2 text-sm text-foreground">
          <HintTooltip label={rule.command}>
            <span className="truncate">{splitCommandLabel(rule.command).name}</span>
          </HintTooltip>
          {row.source === "Custom" ? <Badge>Custom</Badge> : null}
        </div>
        <WhenControl value={whenDraft} onChange={setWhenDraft} />
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        <WarningIcon message={warning} />
        {row.source === "Custom" ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconBtn
                label="More"
                className="size-6 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
              >
                <EllipsisIcon className="size-3.5" />
              </IconBtn>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {defaults.length > 0 ? (
                <DropdownMenuItem
                  onSelect={() => {
                    // Put back this command's defaults in place of every custom rule.
                    const custom = rows.filter(
                      (r) => r.rule.command === rule.command && r.source === "Custom",
                    );
                    void (async () => {
                      for (const r of custom) await removeKeybinding(r.rule);
                      for (const d of defaults) await save(d);
                    })();
                  }}
                >
                  Reset to default
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem color="red" onSelect={() => void removeKeybinding(rule)}>
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {dirty ? (
          <>
            <Btn
              variant="ghost-muted"
              size="xs"
              onClick={() => {
                setKeyDraft(rule.key);
                setWhenDraft(rule.when ?? "");
              }}
            >
              Cancel
            </Btn>
            <Btn variant="primary" size="xs" onClick={commit}>
              Save
            </Btn>
          </>
        ) : null}
        <KeyControl
          value={keyDraft}
          recording={recording}
          onRecordingChange={setRecording}
          onChange={setKeyDraft}
        />
      </div>
    </SettingsSearchTarget>
  );
}

/** "Message: Mark Unread" → group "Message", name "Mark Unread" (the list's grouping). */
function splitCommandLabel(command: string): { group: string; name: string } {
  const label = commandLabel(command);
  const at = label.indexOf(": ");
  return at < 0
    ? { group: "Other", name: label }
    : { group: label.slice(0, at), name: label.slice(at + 2) };
}

const COMMAND_OPTIONS = [...KEYBINDING_COMMANDS].sort((a, b) =>
  commandLabel(a).localeCompare(commandLabel(b)),
);

/** Every user label name across the connected accounts, sorted. */
function useUserLabelNames(): string[] {
  const accountIds = (useAccounts().data ?? []).map((a) => a.id);
  const perAccount = useAllAccountLabels(accountIds);
  const names = new Set<string>();
  for (const { labels } of perAccount) {
    for (const l of labels) if (l.type === "user") names.add(l.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Records the keyboard shortcut that moves the selected conversations to one
 * label (opened from a label's menu in the sidebar). It's a regular
 * `label.move:<name>` keybinding, listed with the rest in Settings.
 */
export function LabelShortcutDialog({
  labelName,
  onClose,
}: {
  /** The label's full name; null keeps the dialog closed. */
  labelName: string | null;
  onClose: () => void;
}) {
  const { rules } = useKeybindingsState();
  const command = labelName ? labelMoveCommand(labelName) : null;
  // Older `label.toggle:` rules count too; saving rewrites them as moves.
  const existing =
    rules.find((r) => labelName !== null && labelMoveName(r.command) === labelName) ?? null;
  const [key, setKey] = useState("");
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the local recording/editing session when its binding or dialog changes.
    setKey(existing?.key ?? "");
    // A new binding starts recording right away.
    setRecording(labelName !== null && !existing);
    // Only when the dialog opens for a label.
  }, [labelName, existing]);
  const rows = useMemo<Row[]>(
    () => rules.map((rule, i) => ({ id: `${i}`, rule, source: "Custom" as const })),
    [rules],
  );
  const ownId = existing ? `${rules.indexOf(existing)}` : "__new__";
  const warning = key ? warningFor(rows, ownId, key, existing?.when ?? IN_MAIL) : null;
  const segment = labelName?.split("/").pop() ?? "";

  return (
    <Dialog
      open={labelName !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Shortcut for “${segment}”`}
      confirmLabel="Save"
      confirmDisabled={!command || parseShortcut(key) === null}
      onConfirm={() => {
        if (!command) return;
        onClose();
        void save({ command, key, when: existing?.when ?? IN_MAIL }, existing ?? undefined);
      }}
      destructiveAction={
        existing
          ? {
              label: "Remove",
              onClick: () => {
                onClose();
                void removeKeybinding(existing);
              },
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between gap-3">
        <Text variant="small" color="secondary">
          Moves the open or selected conversations here: this label is added and the mailbox's label
          and any other labels are taken off.
        </Text>
        <div className="flex shrink-0 items-center gap-1.5">
          <WarningIcon message={warning} />
          <KeyControl
            value={key}
            recording={recording}
            onRecordingChange={setRecording}
            onChange={setKey}
          />
        </div>
      </div>
    </Dialog>
  );
}

function NewKeybindingRow({ rows, onDone }: { rows: Row[]; onDone: () => void }) {
  const labelNames = useUserLabelNames();
  const [command, setCommand] = useState<KeybindingCommand | "">("");
  const [key, setKey] = useState("");
  const [when, setWhen] = useState("");
  const [recording, setRecording] = useState(false);
  const warning = key ? warningFor(rows, "__new__", key, when) : null;
  const canSave = command !== "" && parseShortcut(key) !== null;

  return (
    <SettingsRow
      title="New keybinding"
      description={<WhenControl value={when} onChange={setWhen} />}
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Select value={command} onValueChange={(v) => setCommand(v as KeybindingCommand)}>
            <SelectTrigger variant="pill" className="w-52">
              <SelectValue placeholder="Command" />
            </SelectTrigger>
            <SelectContent>
              {COMMAND_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {commandLabel(c)}
                </SelectItem>
              ))}
              {labelNames.map((name) => (
                <SelectItem key={name} value={labelMoveCommand(name)}>
                  {commandLabel(labelMoveCommand(name))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <WarningIcon message={warning} />
          <KeyControl
            value={key}
            recording={recording}
            onRecordingChange={setRecording}
            onChange={setKey}
          />
          <Btn
            variant="primary"
            size="sm"
            disabled={!canSave}
            onClick={() => {
              if (command === "") return;
              void save({ command, key, when: when || undefined }).then(onDone);
            }}
          >
            Save
          </Btn>
          <IconBtn label="Cancel" onClick={onDone}>
            <XIcon className="size-3.5" />
          </IconBtn>
        </div>
      }
    />
  );
}

// ── Pane ─────────────────────────────────────────────────────────────────────

export function KeybindingsPane() {
  const { rules } = useKeybindingsState();
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);
  // ⌘F searches the bindings while this page is open.
  useCommandHandlers({ "search.focus": () => setSearchOpen(true) });

  const rows = useMemo<Row[]>(
    () =>
      rules
        .map((rule, i) => ({
          id: `${i}:${rule.command}:${rule.key}`,
          rule,
          source: isDefaultRule(rule) ? ("Default" as const) : ("Custom" as const),
        }))
        .sort(
          (a, b) =>
            commandLabel(a.rule.command).localeCompare(commandLabel(b.rule.command)) ||
            a.rule.key.localeCompare(b.rule.key),
        ),
    [rules],
  );
  const q = query.trim().toLowerCase();
  const visible = q
    ? rows.filter((r) =>
        [r.rule.command, commandLabel(r.rule.command), r.rule.key, r.rule.when ?? "", r.source]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : rows;
  const count = visible.length + (adding ? 1 : 0);

  const header = (
    <div className="flex items-center gap-1.5">
      {searchOpen ? (
        <div className="relative w-52">
          <SearchIcon className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            placeholder="Search keybindings"
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => !query && setSearchOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
                setSearchOpen(false);
              }
            }}
            className="h-7 w-full rounded-lg border border-border/70 bg-surface-raised/60 ps-7 pe-2 text-[13px] text-foreground outline-none placeholder:text-placeholder focus-visible:border-focus-ring/60 focus-visible:bg-canvas focus-visible:ring-[3px] focus-visible:ring-focus-ring/16"
          />
        </div>
      ) : (
        <>
          <span className="text-xs text-muted-foreground">
            {count} binding{count === 1 ? "" : "s"}
          </span>
          <HintTooltip label="Search keybindings">
            <IconBtn label="Search keybindings" onClick={() => setSearchOpen(true)}>
              <SearchIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        </>
      )}
      <HintTooltip label="Add keybinding">
        <IconBtn label="Add keybinding" onClick={() => setAdding(true)}>
          <PlusIcon className="size-4" />
        </IconBtn>
      </HintTooltip>
    </div>
  );

  // Settings search lands on a command's first row.
  const firstRowIds = new Set(
    new Map(visible.toReversed().map((row) => [row.rule.command, row.id])).values(),
  );

  // Consecutive rows (sorted by label) share a group: "Message", "Go", …
  const groups: { name: string; rows: Row[] }[] = [];
  for (const row of visible) {
    const name = splitCommandLabel(row.rule.command).group;
    const last = groups[groups.length - 1];
    if (last?.name === name) last.rows.push(row);
    else groups.push({ name, rows: [row] });
  }

  return (
    <SettingsPageContainer
      searchId={searchableSetting("keybindings").id}
      title="Keybindings"
      description="To change a shortcut, click its keys and press the new ones."
      action={header}
    >
      {adding ? (
        <SettingsGroup>
          <NewKeybindingRow rows={rows} onDone={() => setAdding(false)} />
        </SettingsGroup>
      ) : null}
      <div className="space-y-7">
        {groups.map((group) => (
          <section key={group.name}>
            <SettingsSectionHeader title={group.name} muted />
            <div className="[&>*+*]:border-t [&>*+*]:border-border/40">
              {group.rows.map((row) => (
                <KeybindingRow
                  key={row.id}
                  row={row}
                  rows={rows}
                  searchId={
                    firstRowIds.has(row.id) ? keybindingSearchAnchorId(row.rule.command) : undefined
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      {visible.length === 0 && !adding ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No keybindings match your search.
        </div>
      ) : null}
    </SettingsPageContainer>
  );
}
