/**
 * Follow-ups while a turn runs, as Otter Code does them: the "Follow-up
 * behavior" setting (queue or steer; ⌘↩ does the opposite for one message),
 * the queue banner above the composer, and the intent marker on messages.
 */

import { setSyncedPreference } from "../synced-preferences";
import { useId, useState, useSyncExternalStore } from "react";
import {
  ChevronDownIcon,
  CornerUpRightIcon,
  GripVerticalIcon,
  ListOrderedIcon,
  PencilIcon,
  Redo2Icon,
  XIcon,
} from "lucide-react";
import { Btn, HintTooltip, IconBtn, cn } from "./ui";
import { useShortcutLabel } from "../keybindings/store";

export type FollowUpBehavior = "queue" | "steer";

const FOLLOW_UP_KEY = "assistant:follow-up-behavior" as const;
const listeners = new Set<() => void>();

export function getFollowUpBehavior(): FollowUpBehavior {
  return localStorage.getItem(FOLLOW_UP_KEY) === "steer" ? "steer" : "queue";
}

export function setFollowUpBehavior(value: FollowUpBehavior): void {
  setSyncedPreference(FOLLOW_UP_KEY, value);
  for (const listener of listeners) listener();
}

// Picked on another device (or in another window).
window.addEventListener("storage", (event) => {
  if (event.key === FOLLOW_UP_KEY) for (const listener of listeners) listener();
});

export function useFollowUpBehavior(): FollowUpBehavior {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getFollowUpBehavior);
}

type QueueItem = { id: string; question: string; skill?: { name: string } };

/**
 * The queue banner docked above the composer (Otter Code's QueuedRunsControl):
 * a collapsible "Queued" header with a count, then one row per message —
 * drag / arrow-key reorder, edit in the composer, Steer, remove.
 */
export function QueuedRunsControl({
  items,
  editingId,
  canSteer,
  onEdit,
  onCancelEdit,
  onSteer,
  onRemove,
  onMove,
}: {
  items: QueueItem[];
  editingId: string | null;
  canSteer: boolean;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSteer: (id: string) => void;
  onRemove: (id: string) => void;
  /** Move `id` before `beforeId` (null = to the end). */
  onMove: (id: string, beforeId: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [drag, setDrag] = useState<{ id: string; insertIndex: number } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const steerShortcut = useShortcutLabel("agent.sendQueuedNow");
  const editShortcut = useShortcutLabel("agent.editQueued");
  const listId = useId();
  if (items.length === 0) return null;

  const drop = () => {
    if (!drag) return;
    const { id, insertIndex } = drag;
    const from = items.findIndex((i) => i.id === id);
    setDrag(null);
    if (insertIndex === from || insertIndex === from + 1) return;
    onMove(id, items[insertIndex]?.id ?? null);
  };

  return (
    <div
      role="region"
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      aria-live="polite"
      className="relative z-0 mb-2 rounded-2xl border border-(--chat-composer-outline) bg-(--chat-composer-surface) px-1.5 py-1 text-sm shadow-xs/5 dark:border-transparent"
    >
      <button
        type="button"
        aria-label={expanded ? "Collapse queued messages" : "Expand queued messages"}
        aria-expanded={expanded}
        aria-controls={listId}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg px-1.5 text-left hover:bg-accent-surface/50"
      >
        <ListOrderedIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 text-muted-foreground">Queued</span>
        <span className="min-w-4 text-center font-medium tabular-nums text-muted-foreground">
          {items.length}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      <ol id={listId} className={cn("max-h-32 overflow-y-auto", !expanded && "hidden")}>
        {items.map((item, index) => {
          const isEditing = editingId === item.id;
          const preview = `${item.skill ? `/${item.skill.name} ` : ""}${item.question}`;
          return (
            <li
              key={item.id}
              aria-current={isEditing ? "true" : undefined}
              draggable={drag?.id === item.id || armed === item.id}
              onDragStart={(event) => {
                if (armed !== item.id) return event.preventDefault();
                event.dataTransfer.effectAllowed = "move";
                setDrag({ id: item.id, insertIndex: index });
              }}
              onDragOver={(event) => {
                if (!drag) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const insertIndex = event.clientY < rect.top + rect.height / 2 ? index : index + 1;
                if (insertIndex !== drag.insertIndex) setDrag({ ...drag, insertIndex });
              }}
              onDrop={(event) => {
                event.preventDefault();
                drop();
              }}
              onDragEnd={() => {
                setArmed(null);
                setDrag(null);
              }}
              className={cn(
                "relative flex h-7 items-center gap-1.5 rounded-sm px-0.5",
                isEditing && "bg-accent-surface text-foreground",
                drag?.id === item.id && "opacity-50",
              )}
            >
              {drag && drag.insertIndex === index ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded bg-primary/70"
                />
              ) : null}
              {drag && drag.insertIndex === items.length && index === items.length - 1 ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 rounded bg-primary/70"
                />
              ) : null}
              <IconBtn
                label="Reorder queued message (drag, or press the arrow keys)"
                className="size-6 cursor-grab active:cursor-grabbing"
                onPointerDown={() => {
                  setArmed(item.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" && index > 0) {
                    event.preventDefault();
                    onMove(item.id, items[index - 1].id);
                  } else if (event.key === "ArrowDown" && index < items.length - 1) {
                    event.preventDefault();
                    onMove(item.id, items[index + 2]?.id ?? null);
                  }
                }}
              >
                <GripVerticalIcon className="size-3.5" />
              </IconBtn>
              <span className="min-w-0 flex-1 truncate text-foreground/80" title={preview}>
                {isEditing ? <span className="sr-only">Editing queued message: </span> : null}
                {preview}
              </span>
              {isEditing ? (
                <Btn
                  size="xs"
                  variant="ghost"
                  aria-label="Cancel editing queued message"
                  onClick={onCancelEdit}
                >
                  Cancel
                </Btn>
              ) : (
                <>
                  <HintTooltip
                    label="Edit in the composer"
                    hint={index === items.length - 1 ? editShortcut : undefined}
                  >
                    <IconBtn
                      label="Edit queued message"
                      className="size-6"
                      onClick={() => onEdit(item.id)}
                    >
                      <PencilIcon className="size-3.5" />
                    </IconBtn>
                  </HintTooltip>
                  <HintTooltip
                    label={canSteer ? "Send as a steer instead" : "There is no active run to steer"}
                    hint={canSteer && index === 0 ? steerShortcut : undefined}
                  >
                    <span className="flex shrink-0">
                      <Btn
                        size="xs"
                        variant="ghost-muted"
                        disabled={!canSteer}
                        onClick={() => onSteer(item.id)}
                      >
                        <CornerUpRightIcon className="size-3.5" />
                        Steer
                      </Btn>
                    </span>
                  </HintTooltip>
                  <HintTooltip label="Remove from queue">
                    <IconBtn
                      label="Remove queued message"
                      className="size-6"
                      onClick={() => onRemove(item.id)}
                    >
                      <XIcon className="size-3.5" />
                    </IconBtn>
                  </HintTooltip>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The "Queued" / "Steer" marker above a user message (Otter Code's inputIntent). */
export function IntentMarker({ intent }: { intent: "queued" | "steer" | "promoted" }) {
  const tooltip =
    intent === "queued"
      ? "Queued behind the active turn"
      : intent === "promoted"
        ? "Originally queued, then promoted to steer the active turn"
        : "Steered the active turn";
  return (
    <HintTooltip label={tooltip}>
      <div className="me-1 flex items-center justify-end gap-1 text-xs leading-none text-muted-foreground">
        {intent === "queued" ? null : <Redo2Icon aria-hidden className="size-3" />}
        {intent === "queued" ? "Queued" : "Steer"}
      </div>
    </HintTooltip>
  );
}
