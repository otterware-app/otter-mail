/**
 * UI choices that follow the Otter account to every device. They're kept in
 * localStorage (read synchronously, and shared by this app's windows) and
 * mirrored to the backend, which syncs them with the account (core's
 * services/preferences.ts, section `ui`). Changes from elsewhere land here as
 * `storage` events, which the modules owning these keys already listen to.
 */

import type { ThemeSource } from "@otter-mail/contracts";

const THEME_SOURCE = "otter:theme-source";

const SYNCED_KEYS = [
  THEME_SOURCE,
  // Before the picks: apply() goes in order, so a theme made elsewhere exists here before it's worn.
  "otter:themes:v1",
  "otter:theme:light",
  "otter:theme:dark",
  "otter:contrast",
  "otter:glass-opacity",
  "otter:interface-font-size",
  "otter:reading-width",
  "otter:message-list-style",
  "otter:group-messages-by-day",
  "otter:dim-read-messages",
  "otter:mail-layout",
  "otter:open-messages-with-arrows",
  "otter:mark-read-delay",
  "gmail:panel-animation-duration",
  "gmail:advance-direction",
  // The agent's, under their old names: other devices sync these keys.
  "assistant:favorite-models",
  "assistant:hidden-models",
  "assistant:follow-up-behavior",
  "mail:mailboxes",
] as const;

export type SyncedKey = (typeof SYNCED_KEYS)[number];

type UiPreferences = Partial<Record<string, string>>;

/** Keys set since startup: the startup snapshot, answered later, mustn't undo them. */
const settled = new Set<string>();

/** Stores a UI choice here and with the account. */
export function setSyncedPreference(key: SyncedKey, value: string): void {
  settled.add(key);
  localStorage.setItem(key, value);
  void window.desktopBridge.invoke("preferences:setUi", { key, value });
}

function apply(ui: UiPreferences, skip: ReadonlySet<string> = new Set()): void {
  for (const key of SYNCED_KEYS) {
    const value = ui[key];
    if (value === undefined || skip.has(key)) continue;
    settled.add(key);
    if (value === localStorage.getItem(key)) continue;
    localStorage.setItem(key, value);
    if (key === THEME_SOURCE)
      void window.desktopBridge.nativeTheme.setThemeSource(value as ThemeSource);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  }
}

let initialPreferences: Promise<void> | undefined;

/** The browser awaits this before mounting, so its first render uses its saved palette. */
export function loadSyncedPreferences(initialize = false): Promise<void> {
  return (initialPreferences ??= window.desktopBridge
    .invoke<UiPreferences>("preferences:getUi", { initialize })
    .then((ui) => {
      const newer = new Set(settled);
      for (const key of SYNCED_KEYS) {
        const here = localStorage.getItem(key);
        if (ui[key] === undefined && here !== null && !newer.has(key))
          setSyncedPreference(key, here);
      }
      apply(ui, newer);
    }));
}

/** Takes the account's UI choices, gives it the ones it lacks, and follows its changes. */
export function startSyncedPreferences(): () => void {
  void loadSyncedPreferences().catch((err) => console.warn("Couldn't load UI preferences", err));
  return window.desktopBridge.on("preferences:uiChanged", (ui) => apply(ui as UiPreferences));
}
