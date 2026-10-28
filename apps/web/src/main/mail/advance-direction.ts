/** After archiving, deleting, or moving the selected message, which row (if
    any) the list should select next. */

import { setSyncedPreference } from "../synced-preferences";
export type AdvanceDirection = "next" | "previous" | "none";

const KEY = "gmail:advance-direction" as const;

export function getAdvanceDirection(): AdvanceDirection {
  const value = localStorage.getItem(KEY);
  return value === "previous" || value === "none" ? value : "next";
}

export function setAdvanceDirection(direction: AdvanceDirection): void {
  setSyncedPreference(KEY, direction);
}

/** Picks the row to select after `rows[idx]` leaves the list, honoring the
    configured direction with a fallback to the other side when the preferred
    neighbor doesn't exist. */
export function pickAdvanceTarget<T>(rows: T[], idx: number): T | null {
  const direction = getAdvanceDirection();
  if (direction === "none") return null;
  if (direction === "previous") return rows[idx - 1] ?? rows[idx + 1] ?? null;
  return rows[idx + 1] ?? rows[idx - 1] ?? null;
}
