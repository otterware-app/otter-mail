import { useLatest } from "../use-latest";
import { useEffect, useState } from "react";
import { CheckIcon, StarIcon } from "lucide-react";
import type { KeybindingCommand } from "../keybindings/commands";
import { isModifierOnly, matchesStroke } from "../keybindings/keys";
import { getKeybindings } from "../keybindings/store";
import { isTypingTarget } from "../gmail/keyboard";
import { cn } from "../gmail/ui";
import { ShortcutKeys } from "./keycap";

/**
 * The setup's keyboard practice: a pretend inbox that answers the real
 * bindings (rebound keys included), beside the keys to try. Nothing here
 * touches mail.
 */

type Drill = { command: KeybindingCommand; label: string; caption: string };

const DRILLS: Drill[] = [
  { command: "list.next", label: "Next", caption: "Moved down" },
  { command: "list.previous", label: "Previous", caption: "Moved up" },
  { command: "message.archive", label: "Archive", caption: "Archived" },
  { command: "message.trash", label: "Trash", caption: "Moved to Trash" },
  { command: "message.star", label: "Star", caption: "Starred" },
  { command: "mail.undo", label: "Undo", caption: "Undone" },
  { command: "compose.new", label: "New message", caption: "Opens a new message" },
  { command: "search.focus", label: "Search", caption: "Jumps to search" },
  {
    command: "commandPalette.toggle",
    label: "Command palette",
    caption: "Opens the command palette",
  },
  { command: "agent.toggle", label: "Agent", caption: "Opens the agent beside your mail" },
];

type Row = { id: number; from: string; subject: string; starred: boolean };

const ROWS: Row[] = [
  { id: 1, from: "Maya Chen", subject: "Dinner Saturday?", starred: false },
  { id: 2, from: "The Sunday Otter", subject: "Issue #112: Rivers and rafts", starred: false },
  {
    id: 3,
    from: "TAP Air Portugal",
    subject: "Your flight to Lisbon is confirmed",
    starred: false,
  },
  { id: 4, from: "Jonas Müller", subject: "Invitation: Garden planning", starred: false },
  { id: 5, from: "Trailhead Outfitters", subject: "48 hours only: 30% off", starred: false },
];

type Undo = { kind: "remove"; row: Row; at: number } | { kind: "star"; id: number };

/** Which drill a keydown triggers, by any of the command's single-key bindings. */
function drillFor(event: KeyboardEvent): Drill | null {
  const { resolved } = getKeybindings();
  return (
    DRILLS.find((d) =>
      resolved.some(
        (r) =>
          r.rule.command === d.command &&
          r.shortcut.length === 1 &&
          matchesStroke(event, r.shortcut[0]),
      ),
    ) ?? null
  );
}

export function KeyTrainer({ onProgress }: { onProgress?: (done: number) => void }) {
  const [rows, setRows] = useState(ROWS);
  const [index, setIndex] = useState(0);
  const [undos, setUndos] = useState<Undo[]>([]);
  const [done, setDone] = useState<ReadonlySet<KeybindingCommand>>(new Set());
  const [caption, setCaption] = useState<{ text: string; seq: number } | null>(null);

  const state = useLatest({ rows, index, undos });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModifierOnly(event) || isTypingTarget(event)) return;
      const drill = drillFor(event);
      if (!drill) return;
      event.preventDefault();
      const { rows, index, undos } = state.current;
      const current = rows[index];
      let text = drill.caption;
      switch (drill.command) {
        case "list.next":
          setIndex(Math.min(rows.length - 1, index + 1));
          break;
        case "list.previous":
          setIndex(Math.max(0, index - 1));
          break;
        case "message.archive":
        case "message.trash":
          if (!current) return;
          setRows(rows.filter((r) => r.id !== current.id));
          setIndex(Math.min(index, rows.length - 2));
          setUndos([...undos, { kind: "remove", row: current, at: index }]);
          text = `${drill.caption} · press Z to undo`;
          break;
        case "message.star":
          if (!current) return;
          setRows(rows.map((r) => (r.id === current.id ? { ...r, starred: !r.starred } : r)));
          setUndos([...undos, { kind: "star", id: current.id }]);
          if (current.starred) text = "Unstarred";
          break;
        case "mail.undo": {
          const last = undos.at(-1);
          if (!last) {
            text = "Nothing to undo yet: archive something first";
            break;
          }
          setUndos(undos.slice(0, -1));
          if (last.kind === "remove") {
            setRows([...rows.slice(0, last.at), last.row, ...rows.slice(last.at)]);
            setIndex(last.at);
          } else {
            setRows(rows.map((r) => (r.id === last.id ? { ...r, starred: !r.starred } : r)));
          }
          break;
        }
      }
      setCaption((c) => ({ text, seq: (c?.seq ?? 0) + 1 }));
      setDone((prev) => (prev.has(drill.command) ? prev : new Set(prev).add(drill.command)));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state]);

  const onProgressRef = useLatest(onProgress);
  useEffect(() => onProgressRef.current?.(done.size), [done, onProgressRef]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
      {/* The practice inbox. */}
      <div className="flex flex-col gap-3">
        <div className="flex min-h-[292px] flex-col rounded-xl border border-border/60 bg-card p-1">
          <div className="flex items-center justify-between px-3 pb-1.5 pt-2 text-xs text-muted-foreground">
            <span>Practice inbox</span>
            <span className="tabular-nums">{rows.length} conversations</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
              <p className="text-sm text-foreground">Inbox zero.</p>
              <p className="text-[13px] text-muted-foreground">Press Z to bring them back.</p>
            </div>
          ) : (
            rows.map((row, i) => (
              <div
                key={row.id}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors",
                  i === index ? "bg-sidebar-row-active" : "",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">{row.from}</div>
                  <div className="truncate text-xs text-muted-foreground">{row.subject}</div>
                </div>
                {row.starred ? (
                  <StarIcon className="size-3.5 shrink-0 fill-warning text-warning" />
                ) : null}
              </div>
            ))
          )}
        </div>
        <p
          key={caption?.seq}
          aria-live="polite"
          className="h-5 px-1 text-[13px] text-muted-foreground motion-safe:animate-[onboarding-in_200ms_ease-out]"
        >
          {caption?.text ?? "Press a key on the right to try it here."}
        </p>
      </div>

      {/* The keys to try. */}
      <div className="grid grid-cols-2 content-start gap-2">
        {DRILLS.map((drill) => {
          const hit = done.has(drill.command);
          return (
            <div
              key={drill.command}
              className={cn(
                "flex min-h-[52px] flex-col justify-center gap-1.5 rounded-xl border px-3 py-2 transition-colors",
                hit ? "border-success/40 bg-success/[0.06]" : "border-border/60 bg-card",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <ShortcutKeys command={drill.command} />
                {hit ? (
                  <CheckIcon className="size-3.5 shrink-0 text-success motion-safe:animate-[onboarding-pop_240ms_ease-out]" />
                ) : null}
              </div>
              <span className="text-[13px] text-muted-foreground">{drill.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const KEY_DRILL_COUNT = DRILLS.length;
