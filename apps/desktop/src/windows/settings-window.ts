export type SettingsTarget = {
  /** None: the pane Settings was last on. */
  pane?:
    | "general"
    | "appearance"
    | "keybindings"
    | "accounts"
    | "agents"
    | "integrations"
    | "browser"
    | "otter";
};

// Where the in-app settings page should navigate on open. The main window
// pulls this via window:getSettingsTarget on mount and on settings:open.
let pendingTarget: SettingsTarget | null = null;

export function setSettingsTarget(target: SettingsTarget): void {
  pendingTarget = target;
}

export function takeSettingsTarget(): SettingsTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}
