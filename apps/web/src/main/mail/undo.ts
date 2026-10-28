import type { ModifyMessageParams, ModifyThreadParams } from "./api";

/**
 * Undo history: mutation hooks register the INVERSE of each user-initiated
 * triage action. z undoes the newest, then the one before; each action's toast
 * undoes its own, in any order. Running an inverse doesn't register again; it
 * goes on the redo list instead (⇧Z), and redoing an action registers it anew.
 *
 * Actions on different conversations undo independently. A newer action on the
 * same conversation or message retires the older one's undo, which would
 * otherwise act on a state that's gone (e.g. un-archive something since trashed).
 *
 * Each registration also says what the action did ("Archived", "Moved to
 * “X”"); listeners (the action toast) hear about it once it's committed, so a
 * bulk action announces itself once ("Archived 3 conversations").
 */
export type UndoAction =
  | { kind: "modifyMessage"; params: ModifyMessageParams }
  | { kind: "modifyThread"; params: ModifyThreadParams }
  | { kind: "untrashThread"; params: { accountId: string; threadId: string } }
  | { kind: "untrashMessage"; params: { accountId: string; messageId: string } }
  /** Only as redos: trashing again what an undo brought back. */
  | { kind: "trashThread"; params: { accountId: string; threadId: string } }
  | { kind: "trashMessage"; params: { accountId: string; messageId: string } }
  /** Something that isn't a mail change, e.g. holding back a message being sent. */
  | { kind: "callback"; run: () => void }
  /** A bulk action: every row's inverse, undone together. */
  | { kind: "batch"; actions: UndoAction[] };

/** What an action did, for its toast: `${verb}${suffix}` for one, or
    `${verb} 3 ${noun}s${suffix}` for several ("Moved 3 conversations to “X”"). */
export type ActionSummary = {
  verb: string;
  suffix?: string;
  noun: "conversation" | "message";
};

/** Oldest first; z takes from the end. */
const history: UndoAction[] = [];
/** What undos took back, oldest first; ⇧Z takes from the end. */
const redos: UndoAction[] = [];
const HISTORY_LIMIT = 20;

type ActionListener = (title: string, action: UndoAction) => void;
const listeners = new Set<ActionListener>();

/** Hears every committed undoable action, with a title describing it. */
export function onUndoableAction(listener: ActionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function titleFor(summaries: ActionSummary[]): string {
  const [first] = summaries;
  const suffix = first.suffix ?? "";
  if (summaries.length === 1) return `${first.verb}${suffix}`;
  const same = summaries.every(
    (s) => s.verb === first.verb && (s.suffix ?? "") === suffix && s.noun === first.noun,
  );
  if (!same) return `Changed ${summaries.length} items`;
  return `${first.verb} ${summaries.length} ${first.noun}s${suffix}`;
}

/**
 * A bulk action registers one undo per row (from each mutation's onMutate,
 * which runs asynchronously); a group collects the next `size` registrations
 * into a single batch so z restores the whole selection. The timeout commits
 * whatever arrived if some row never registers (e.g. its mutation failed early).
 */
let group: {
  remaining: number;
  actions: UndoAction[];
  summaries: ActionSummary[];
  timer: ReturnType<typeof setTimeout>;
} | null = null;

function announce(action: UndoAction, summaries: ActionSummary[]): void {
  if (summaries.length === 0) return;
  const title = titleFor(summaries);
  for (const listener of listeners) listener(title, action);
}

/** The conversations and messages an action touches. */
function targets(action: UndoAction): string[] {
  switch (action.kind) {
    case "modifyThread":
    case "untrashThread":
    case "trashThread":
      return [`${action.params.accountId}/thread/${action.params.threadId}`];
    case "modifyMessage":
    case "untrashMessage":
    case "trashMessage":
      return [`${action.params.accountId}/message/${action.params.messageId}`];
    case "callback":
      return [];
    case "batch":
      return action.actions.flatMap(targets);
  }
}

/** Retires older undos and redos of anything `action` touches: whole actions,
    or a batch's rows (so a bulk undo still restores the rest). */
function retire(action: UndoAction): void {
  const touched = new Set(targets(action));
  if (touched.size === 0) return;
  const stale = (a: UndoAction) => targets(a).some((t) => touched.has(t));
  for (const list of [history, redos]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.kind === "batch") entry.actions = entry.actions.filter((a) => !stale(a));
      if (entry.kind === "batch" ? entry.actions.length === 0 : stale(entry)) list.splice(i, 1);
    }
  }
}

function push(action: UndoAction): void {
  retire(action);
  history.push(action);
  if (history.length > HISTORY_LIMIT) history.shift();
}

/** The action an undo took back, to run again; null for what can't be redone
    (a send held back reopened its draft). */
function inverse(action: UndoAction): UndoAction | null {
  switch (action.kind) {
    case "modifyThread":
    case "modifyMessage": {
      const { addLabelIds, removeLabelIds, ...rest } = action.params;
      return {
        ...action,
        params: { ...rest, addLabelIds: removeLabelIds, removeLabelIds: addLabelIds },
      } as UndoAction;
    }
    case "untrashThread":
      return { kind: "trashThread", params: action.params };
    case "untrashMessage":
      return { kind: "trashMessage", params: action.params };
    case "trashThread":
      return { kind: "untrashThread", params: action.params };
    case "trashMessage":
      return { kind: "untrashMessage", params: action.params };
    case "callback":
      return null;
    case "batch": {
      const actions = action.actions.map(inverse).filter((a) => a !== null);
      return actions.length > 0 ? { kind: "batch", actions } : null;
    }
  }
}

function commitGroup(): void {
  if (!group) return;
  clearTimeout(group.timer);
  const { actions, summaries } = group;
  group = null;
  if (actions.length === 0) return;
  const action: UndoAction = actions.length === 1 ? actions[0] : { kind: "batch", actions };
  push(action);
  announce(action, summaries);
}

export function beginUndoGroup(size: number): void {
  commitGroup();
  if (size > 1) {
    group = {
      remaining: size,
      actions: [],
      summaries: [],
      timer: setTimeout(commitGroup, 2000),
    };
  }
}

/** Registers an action's inverse. `summary` = announce it (omitted when the
    action is itself an undo, or shouldn't show a toast). */
export function registerUndo(action: UndoAction, summary?: ActionSummary): void {
  if (group) {
    group.actions.push(action);
    if (summary) group.summaries.push(summary);
    if (--group.remaining <= 0) commitGroup();
    return;
  }
  push(action);
  if (summary) announce(action, [summary]);
}

/** Forgets every undo and redo (after an irreversible action like Delete forever). */
export function clearUndo(): void {
  commitGroup();
  history.length = 0;
  redos.length = 0;
}

/** Drops `action` from the history (it was undone another way, or can't be anymore). */
export function forgetUndo(action: UndoAction): void {
  const i = history.indexOf(action);
  if (i !== -1) history.splice(i, 1);
}

/** Takes `action` out of the history to run it, or the newest (z) when omitted.
    Null when there's nothing to undo, or `action` was retired. */
export function takeUndo(action?: UndoAction): UndoAction | null {
  const i = action ? history.indexOf(action) : history.length - 1;
  return i === -1 ? null : history.splice(i, 1)[0];
}

/** After `undone` ran: puts what it took back on the redo list. */
export function registerRedo(undone: UndoAction): void {
  const action = inverse(undone);
  if (!action) return;
  redos.push(action);
  if (redos.length > HISTORY_LIMIT) redos.shift();
}

/** The newest undone action, to run again (⇧Z). */
export function takeRedo(): UndoAction | null {
  return redos.pop() ?? null;
}

/** Auto-mark-read (and ⇧I) shouldn't clobber the undo slot. */
export function isPureMarkRead(addLabelIds?: string[], removeLabelIds?: string[]): boolean {
  return (
    (addLabelIds == null || addLabelIds.length === 0) &&
    removeLabelIds?.length === 1 &&
    removeLabelIds[0] === "UNREAD"
  );
}

// Mutations run by an undo re-register (so z toggles) but don't announce
// themselves: the undo shows its own "Undone". Marked by params identity —
// TanStack hands the same variables object to onMutate.
const quiet = new WeakSet<object>();

/** Marks mutation params as coming from an undo (no action toast). */
export function quietParams<T extends object>(params: T): T {
  const copy = { ...params };
  quiet.add(copy);
  return copy;
}

export function isQuiet(params: object): boolean {
  return quiet.has(params);
}
