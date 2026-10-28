/**
 * Per-model client preferences, as T3 Code keeps them: favorites (pinned in
 * the picker) and models hidden from the picker. Keys are `kind:slug`;
 * stored on this device and shared live between Settings and the composer.
 */

import { setSyncedPreference, type SyncedKey } from "../synced-preferences";
import { useSyncExternalStore } from "react";
import type { ProviderKind } from "./api";

type Prefs = { favorites: string[]; hidden: string[] };

const KEYS = {
  favorites: "assistant:favorite-models",
  hidden: "assistant:hidden-models",
} as const satisfies Record<keyof Prefs, SyncedKey>;

const listeners = new Set<() => void>();

function read(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

let snapshot: Prefs = { favorites: read(KEYS.favorites), hidden: read(KEYS.hidden) };

function write(name: keyof Prefs, values: string[]): void {
  setSyncedPreference(KEYS[name], JSON.stringify(values));
  snapshot = { ...snapshot, [name]: values };
  for (const listener of listeners) listener();
}

// Picked on another device (or in another window).
window.addEventListener("storage", (event) => {
  if (event.key !== KEYS.favorites && event.key !== KEYS.hidden) return;
  snapshot = { favorites: read(KEYS.favorites), hidden: read(KEYS.hidden) };
  for (const listener of listeners) listener();
});

export const modelKey = (kind: ProviderKind, slug: string) => `${kind}:${slug}`;

export function useModelPrefs(): Prefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function toggleFavorite(key: string): void {
  const { favorites } = snapshot;
  write(
    "favorites",
    favorites.includes(key) ? favorites.filter((k) => k !== key) : [...favorites, key],
  );
}

export function setHidden(key: string, hidden: boolean): void {
  const rest = snapshot.hidden.filter((k) => k !== key);
  write("hidden", hidden ? [...rest, key] : rest);
}

/** T3's bulk toggle: all hidden → show all; otherwise hide every one. */
export function toggleAllHidden(keys: string[]): void {
  const allHidden = keys.every((k) => snapshot.hidden.includes(k));
  write(
    "hidden",
    allHidden
      ? snapshot.hidden.filter((k) => !keys.includes(k))
      : [...new Set([...snapshot.hidden, ...keys])],
  );
}

/** Restore this provider's models without changing other providers' preferences. */
export function resetModelPrefs(kind: ProviderKind): void {
  const prefix = `${kind}:`;
  write(
    "favorites",
    snapshot.favorites.filter((key) => !key.startsWith(prefix)),
  );
  write(
    "hidden",
    snapshot.hidden.filter((key) => !key.startsWith(prefix)),
  );
}
