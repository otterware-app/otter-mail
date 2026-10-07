/**
 * Every command a keybinding can trigger, and the default bindings (the Otter
 * Code model: a closed set of command ids; titles derive from the id, e.g.
 * `message.markUnread` → "Message: Mark Unread").
 *
 * `when` context keys (see dispatch.ts):
 * - editableFocus: typing in an input, textarea, or rich-text field
 * - dialogOpen:    a dialog, popover, or menu is open
 * - settingsOpen:  the settings page is showing
 * - panelExpanded: the agent panel fills the window (the mail is hidden)
 * - messageOpen:   a conversation is open in the reader
 * - agentOpen:     the agent chat panel is showing
 * - modelPickerOpen: the composer's model picker is open
 *
 * Besides the closed set, `label.move:<label name>` rules move the selection
 * to one of the user's labels (by full name, so one binding works in every
 * account).
 */

export const MAILBOX_JUMP_COMMANDS = [
  "mailbox.jump.1",
  "mailbox.jump.2",
  "mailbox.jump.3",
  "mailbox.jump.4",
  "mailbox.jump.5",
  "mailbox.jump.6",
  "mailbox.jump.7",
  "mailbox.jump.8",
  "mailbox.jump.9",
] as const;

/** ⌘1…⌘9 pick the Nth model while the model picker is open (T3's modelPicker.jump.N). */
export const MODEL_PICKER_JUMP_COMMANDS = [
  "modelPicker.jump.1",
  "modelPicker.jump.2",
  "modelPicker.jump.3",
  "modelPicker.jump.4",
  "modelPicker.jump.5",
  "modelPicker.jump.6",
  "modelPicker.jump.7",
  "modelPicker.jump.8",
  "modelPicker.jump.9",
] as const;

export const KEYBINDING_COMMANDS = [
  "commandPalette.toggle",
  "sidebar.toggle",
  "agent.toggle",
  "agent.toggleExpanded",
  "agent.newTab",
  "agent.newChat",
  "agent.previousTab",
  "modelPicker.toggle",
  "composer.mode",
  "agent.sendQueuedNow",
  "agent.editQueued",
  "modelPicker.previousProvider",
  "modelPicker.nextProvider",
  ...MODEL_PICKER_JUMP_COMMANDS,
  "search.focus",
  "compose.new",
  "composer.send",
  "keybindings.show",
  "mail.undo",
  "mail.redo",
  "go.inbox",
  "go.sent",
  "go.starred",
  "go.drafts",
  "go.allMail",
  ...MAILBOX_JUMP_COMMANDS,
  "list.next",
  "list.previous",
  "list.extendSelectionDown",
  "list.extendSelectionUp",
  "list.open",
  "list.expandThread",
  "list.collapseThread",
  "message.close",
  "message.reply",
  "message.replyAll",
  "message.forward",
  "message.archive",
  "message.trash",
  "message.junk",
  "message.star",
  "message.markRead",
  "message.markUnread",
  "message.label",
  "message.move",
  "message.translate",
] as const;

export const LABEL_MOVE_PREFIX = "label.move:";
/** Label shortcuts saved before they became moves; they now move too. */
const LEGACY_LABEL_PREFIX = "label.toggle:";

export type LabelMoveCommand = `${typeof LABEL_MOVE_PREFIX}${string}`;

export type KeybindingCommand = (typeof KEYBINDING_COMMANDS)[number] | LabelMoveCommand;

/** What a handler registers under: a fixed command, or every label move. */
export type CommandHandlerKey = (typeof KEYBINDING_COMMANDS)[number] | "label.move";

export function labelMoveCommand(labelName: string): LabelMoveCommand {
  return `${LABEL_MOVE_PREFIX}${labelName}`;
}

/** The label name of a `label.move:<name>` command, else null. */
export function labelMoveName(command: string): string | null {
  const prefix = [LABEL_MOVE_PREFIX, LEGACY_LABEL_PREFIX].find((p) => command.startsWith(p));
  if (!prefix) return null;
  const name = command.slice(prefix.length).trim();
  return name || null;
}

export function isKeybindingCommand(value: string): value is KeybindingCommand {
  return (
    (KEYBINDING_COMMANDS as readonly string[]).includes(value) || labelMoveName(value) !== null
  );
}

export type KeybindingRule = {
  key: string;
  command: KeybindingCommand;
  when?: string;
};

/** Context keys offered in the When editor (plus the literals). */
export const WHEN_VARIABLES = [
  "editableFocus",
  "dialogOpen",
  "settingsOpen",
  "panelExpanded",
  "messageOpen",
  "agentOpen",
  "modelPickerOpen",
  "true",
  "false",
] as const;

const OUTSIDE_FIELDS = "!editableFocus && !dialogOpen";
export const IN_MAIL = "!editableFocus && !dialogOpen && !settingsOpen && !panelExpanded";
const ON_MESSAGE = `${IN_MAIL} && messageOpen`;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+k", command: "commandPalette.toggle" },
  // ⌘B means bold while typing.
  { key: "mod+b", command: "sidebar.toggle", when: OUTSIDE_FIELDS },
  { key: "mod+shift+b", command: "agent.toggle", when: "!dialogOpen" },
  { key: "mod+shift+f", command: "agent.toggleExpanded", when: "!dialogOpen" },
  { key: "mod+t", command: "agent.newTab", when: "!dialogOpen" },
  { key: "mod+shift+o", command: "agent.newChat", when: "!dialogOpen" },
  { key: "ctrl+tab", command: "agent.previousTab", when: "!dialogOpen" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "agentOpen" },
  { key: "mod+shift+a", command: "composer.mode", when: "agentOpen" },
  {
    key: "mod+shift+enter",
    command: "agent.sendQueuedNow",
    when: "agentOpen",
  },
  {
    key: "alt+arrowup",
    command: "agent.editQueued",
    when: "agentOpen && editableFocus",
  },
  {
    key: "mod+shift+arrowup",
    command: "modelPicker.previousProvider",
    when: "modelPickerOpen",
  },
  {
    key: "mod+shift+arrowdown",
    command: "modelPicker.nextProvider",
    when: "modelPickerOpen",
  },
  ...MODEL_PICKER_JUMP_COMMANDS.map((command, i): KeybindingRule => ({
    key: `mod+${i + 1}`,
    command,
    when: "modelPickerOpen",
  })),
  { key: "/", command: "search.focus", when: OUTSIDE_FIELDS },
  { key: "mod+f", command: "search.focus", when: "!dialogOpen" },
  { key: "c", command: "compose.new", when: OUTSIDE_FIELDS },
  { key: "mod+enter", command: "composer.send" },
  { key: "?", command: "keybindings.show", when: OUTSIDE_FIELDS },
  { key: "z", command: "mail.undo", when: OUTSIDE_FIELDS },
  { key: "shift+z", command: "mail.redo", when: OUTSIDE_FIELDS },
  { key: "g i", command: "go.inbox", when: IN_MAIL },
  { key: "g t", command: "go.sent", when: IN_MAIL },
  { key: "g s", command: "go.starred", when: IN_MAIL },
  { key: "g d", command: "go.drafts", when: IN_MAIL },
  { key: "g a", command: "go.allMail", when: IN_MAIL },
  ...MAILBOX_JUMP_COMMANDS.map((command, i): KeybindingRule => ({
    key: `mod+${i + 1}`,
    command,
    when: "!dialogOpen",
  })),
  { key: "j", command: "list.next", when: IN_MAIL },
  { key: "arrowdown", command: "list.next", when: IN_MAIL },
  { key: "k", command: "list.previous", when: IN_MAIL },
  { key: "arrowup", command: "list.previous", when: IN_MAIL },
  { key: "shift+arrowdown", command: "list.extendSelectionDown", when: IN_MAIL },
  { key: "shift+arrowup", command: "list.extendSelectionUp", when: IN_MAIL },
  { key: "enter", command: "list.open", when: IN_MAIL },
  { key: "arrowright", command: "list.expandThread", when: IN_MAIL },
  { key: "arrowleft", command: "list.collapseThread", when: IN_MAIL },
  { key: "u", command: "message.close", when: ON_MESSAGE },
  { key: "escape", command: "message.close", when: ON_MESSAGE },
  { key: "r", command: "message.reply", when: ON_MESSAGE },
  { key: "a", command: "message.replyAll", when: ON_MESSAGE },
  { key: "f", command: "message.forward", when: ON_MESSAGE },
  { key: "e", command: "message.archive", when: IN_MAIL },
  { key: "#", command: "message.trash", when: IN_MAIL },
  { key: "backspace", command: "message.trash", when: IN_MAIL },
  { key: "delete", command: "message.trash", when: IN_MAIL },
  { key: "!", command: "message.junk", when: IN_MAIL },
  { key: "s", command: "message.star", when: IN_MAIL },
  { key: "shift+i", command: "message.markRead", when: IN_MAIL },
  { key: "shift+u", command: "message.markUnread", when: IN_MAIL },
  { key: "l", command: "message.label", when: IN_MAIL },
  { key: "v", command: "message.move", when: IN_MAIL },
  { key: "t", command: "message.translate", when: ON_MESSAGE },
];

function titleCaseSegment(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "message.markUnread" → "Message: Mark Unread"; label moves → "Move to Label: Clients/Acme". */
export function commandLabel(command: string): string {
  const labelName = labelMoveName(command);
  if (labelName !== null) return `Move to Label: ${labelName}`;
  return command.split(".").map(titleCaseSegment).join(": ");
}
