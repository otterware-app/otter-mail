import { features } from "../features";
import { osNames } from "../os-names";
import type { SettingsPane } from "../gmail/api";
import { commandLabel, DEFAULT_KEYBINDINGS, KEYBINDING_COMMANDS } from "../keybindings/commands";

/*
 * Settings search (Otter Code's): a catalog of the settings people look for,
 * matched on title, pane and search terms. A result opens its pane and scrolls
 * to the row or section whose id is the item's (or its `targetId`).
 */

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly pane: SettingsPane;
  /** Where to scroll when the item has no row of its own. Defaults to `id`. */
  readonly targetId?: string;
  /** Descriptions, option labels, and aliases people may remember instead of the title. */
  readonly searchTerms?: ReadonlyArray<string>;
  /**
   * Sorts after every other match. Keybinding commands mirror rows on other
   * panes, so "notifications" still leads with Notifications, not a command.
   */
  readonly secondary?: boolean;
  /** False where this app doesn't have the setting (only the Mac app does): search skips it. */
  readonly available?: boolean;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPane, string>> = {
  general: "General",
  otter: "Account",
  appearance: "Appearance",
  keybindings: "Keybindings",
  accounts: "Mailboxes",
  agents: "Agents",
  browser: "Browser",
  integrations: "Integrations",
};

/** Anchor id of the first row bound to `command` on the Keybindings pane. */
export function keybindingSearchAnchorId(command: string) {
  return `keybinding-${command}`;
}

/**
 * One result per built-in command, alphabetical by label. The anchor is the
 * command's first row; default keys are searchable so "mod+b" lands on
 * Sidebar: Toggle.
 */
const KEYBINDING_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = KEYBINDING_COMMANDS.toSorted(
  (left, right) => commandLabel(left).localeCompare(commandLabel(right)),
).map((command) => ({
  id: keybindingSearchAnchorId(command),
  title: commandLabel(command),
  pane: "keybindings",
  searchTerms: [
    command,
    ...DEFAULT_KEYBINDINGS.filter((binding) => binding.command === command).map((b) => b.key),
  ],
  secondary: true,
}));

/**
 * Searchable settings, in result order. Rows and sections with an anchor
 * render their id and title via `searchableSetting`.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "todoist",
    title: "Todoist",
    pane: "integrations",
    searchTerms: ["tasks projects due date priority API token connect disconnect"],
  },
  // General
  {
    id: "launch-at-login",
    title: "Launch at login",
    pane: "general",
    available: features.launchAtLogin,
    searchTerms: ["startup open automatically log in mac computer"],
  },
  {
    id: "rail-unread-dots",
    title: "Show unread dots in the rail",
    pane: "general",
    searchTerms: ["unread dot indicator mailboxes views sidebar rail badge"],
  },
  {
    id: "dock-badge",
    title: "Show unread count on Dock icon",
    pane: "general",
    available: features.dockBadge,
    searchTerms: ["badge number unread"],
  },
  {
    id: "sync-interval",
    title: "Check for new mail",
    pane: "general",
    searchTerms: ["sync fetch refresh background interval cadence manually minutes seconds"],
  },
  {
    id: "notifications",
    title: "Notifications",
    pane: "general",
    searchTerms: ["alerts new mail inbox only all off banner"],
  },
  {
    id: "advance-direction",
    title: "After archive, delete, or move",
    pane: "general",
    searchTerms: ["next previous message select auto advance"],
  },
  {
    id: "read-languages",
    title: "Languages I read",
    pane: "general",
    available: features.translation,
    searchTerms: ["translation translate language foreign"],
  },
  {
    id: "auto-translate",
    title: "Translate automatically",
    pane: "general",
    available: features.translation,
    searchTerms: ["translation language foreign auto"],
  },
  {
    id: "default-mail-app",
    title: "Default email app",
    pane: "general",
    available: features.defaultMailApp,
    searchTerms: ["mailto links handler mac system"],
  },
  {
    id: "tour",
    title: "Tour",
    pane: "general",
    searchTerms: ["getting started walkthrough help onboarding"],
  },
  {
    id: "setup",
    title: "Setup",
    pane: "general",
    searchTerms: ["getting started onboarding run again wizard"],
  },
  {
    id: "updates",
    title: "Updates",
    pane: "general",
    searchTerms: ["version check restart to update release about"],
  },
  {
    id: "send-feedback",
    title: "Send feedback",
    pane: "general",
    searchTerms: ["support report bug problem suggest feature help"],
  },
  // Account
  {
    id: "otter-account",
    title: "Otter account",
    pane: "otter",
    searchTerms: ["sign in sign out profile sync devices realtime push"],
  },
  {
    id: "devices",
    title: "Devices",
    pane: "otter",
    searchTerms: ["signed in sessions sign out computers phones"],
  },
  {
    id: "delete-otter-account",
    title: "Delete Otter account",
    pane: "otter",
    searchTerms: ["remove close"],
  },
  // Appearance
  {
    id: "app-icon",
    title: "App icon",
    pane: "appearance",
    searchTerms: ["dock favicon otter colors icon"],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    pane: "appearance",
    searchTerms: ["mode light dark system"],
  },
  {
    id: "themes",
    title: "Themes",
    pane: "appearance",
    searchTerms: ["colors palette look", "custom create duplicate import export"],
  },
  {
    id: "contrast",
    title: "Contrast",
    pane: "appearance",
    searchTerms: ["text borders legibility accessibility"],
  },
  {
    id: "glass-opacity",
    title: "Glass opacity",
    pane: "appearance",
    searchTerms: ["transparency blur translucent menus dialogs solid"],
  },
  {
    id: "font-size",
    title: "Font size",
    pane: "appearance",
    searchTerms: ["text size bigger smaller zoom scale typography accessibility"],
  },
  {
    id: "mail-layout",
    title: "Mail layout",
    pane: "appearance",
    searchTerms: [
      "split view full inbox floating",
      "reading pane columns wide list layout floating window popup bottom right panel",
    ],
  },
  {
    id: "message-list-style",
    title: "Message list style",
    pane: "appearance",
    searchTerms: ["classic with dividers", "rows spacing separation density inbox accessibility"],
  },
  {
    id: "reading-width",
    title: "Reading width",
    pane: "appearance",
    searchTerms: ["email thread message reader wide narrow full column space"],
  },
  {
    id: "group-messages-by-day",
    title: "Group messages by day",
    pane: "appearance",
    searchTerms: ["date separators today yesterday collapse expand sections inbox"],
  },
  {
    id: "dim-read-messages",
    title: "Dim read messages",
    pane: "appearance",
    searchTerms: ["gray grey muted background unread message list inbox"],
  },
  {
    id: "open-messages-with-arrows",
    title: "Open messages with arrow keys",
    pane: "appearance",
    searchTerms: ["keyboard navigation j k highlight selection enter reading pane preview"],
  },
  {
    id: "mark-read-delay",
    title: "Mark as read delay",
    pane: "appearance",
    searchTerms: ["unread read timer seconds keyboard arrows preview browsing"],
  },
  {
    id: "panel-animations",
    title: "Panel animations",
    pane: "appearance",
    searchTerms: ["motion speed duration fast slow"],
  },
  // Keybindings
  {
    id: "keybindings",
    title: "Keybindings",
    pane: "keybindings",
    searchTerms: ["keyboard shortcuts hotkeys commands bindings"],
  },
  ...KEYBINDING_SEARCH_ITEMS,
  // Mailboxes
  {
    id: "mailboxes",
    title: "Mailboxes",
    pane: "accounts",
    searchTerms: ["accounts gmail imap turn on off order reorder drag add"],
  },
  {
    id: "all-mailboxes",
    title: "All mailboxes",
    pane: "accounts",
    searchTerms: ["combined unified one inbox"],
  },
  {
    id: "mailbox-status",
    title: "Mailbox status",
    pane: "accounts",
    searchTerms: ["sync now sign in again refresh password"],
  },
  {
    id: "mailbox-display-name",
    title: "Display name",
    pane: "accounts",
    searchTerms: ["account rename name sidebar"],
  },
  {
    id: "mailbox-color",
    title: "Mailbox color",
    pane: "accounts",
    searchTerms: ["account colour combined"],
  },
  {
    id: "signature",
    title: "Signature",
    pane: "accounts",
    searchTerms: ["sign off footer replies forwards"],
  },
  {
    id: "remove-mailbox",
    title: "Remove account",
    pane: "accounts",
    searchTerms: ["delete mailbox sign out"],
  },
  // Agents
  {
    id: "agent-providers",
    title: "Providers",
    pane: "agents",
    searchTerms: [
      "agents openrouter api key server model claude codex hermes openclaw enable turn on off default new chats",
    ],
  },
  {
    id: "agent-binary-path",
    title: "Binary path",
    pane: "agents",
    available: features.localAgents,
    searchTerms: ["agents cli claude codex runtime home config directory launch arguments"],
  },
  {
    id: "agent-access",
    title: "Access",
    pane: "agents",
    available: features.localAgents,
    searchTerms: ["agents permissions runtime mode full access supervised approvals"],
  },
  {
    id: "agent-models",
    title: "Models",
    pane: "agents",
    searchTerms: ["agents favorites hidden default model"],
  },
  {
    id: "hermes-connection",
    title: "Connection",
    pane: "agents",
    searchTerms: ["hermes base url api key server connect"],
  },
  {
    id: "openclaw-connection",
    title: "Connection",
    pane: "agents",
    searchTerms: ["openclaw gateway address token connect pair approve device tailscale"],
  },
  {
    id: "follow-up-behavior",
    title: "Follow-up behavior",
    pane: "agents",
    searchTerms: ["chat queue steer running agent"],
  },
  {
    id: "connected-agents",
    title: `Agents on this ${osNames.computer}`,
    pane: "agents",
    available: features.localAgents,
    searchTerms: ["mcp server token connect claude code codex cursor external tools"],
  },
  // Browser
  {
    id: "browser-links",
    title: "Open links",
    pane: "browser",
    available: features.browser,
    searchTerms: ["links mail chat tab default browser safari chrome external"],
  },
  {
    id: "browser-extensions-button",
    title: "Extensions button",
    pane: "browser",
    available: features.browser,
    searchTerms: ["toolbar puzzle pin extensions menu"],
  },
  {
    id: "browser-extensions",
    title: "Extensions",
    pane: "browser",
    available: features.browser,
    searchTerms: [
      "chrome web store add-ons plugins ad blocker password manager developer mode unpacked",
    ],
  },
  {
    id: "browser-data",
    title: "Clear browsing data",
    pane: "browser",
    available: features.browser,
    searchTerms: ["cookies cache site data sign out history"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = new Map<string, SettingsSearchItem>(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
);

/**
 * `id` and `title` props for the element a search item anchors to. Panes
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID.get(id)!;
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return items
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.pane]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (item.available === false) return [];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}
