import type { GmailAccount } from "./types";

/** Preset account colors offered in Settings — a macOS-style accent palette. */
export const ACCOUNT_COLOR_PALETTE: string[] = [
  "#ff3b30", // red
  "#ff9500", // orange
  "#ffcc00", // yellow
  "#34c759", // green
  "#00c7be", // teal
  "#007aff", // blue
  "#5856d6", // indigo
  "#af52de", // purple
  "#ff2d55", // pink
  "#a2845e", // brown
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** An account's display color — its saved choice, or a stable fallback from the palette. */
export function getAccountColor(account: Pick<GmailAccount, "id" | "color">): string {
  return (
    account.color ?? ACCOUNT_COLOR_PALETTE[hashString(account.id) % ACCOUNT_COLOR_PALETTE.length]
  );
}

/** An account's display name — the user's override, or the Google profile name. */
export function getAccountDisplayName(account: Pick<GmailAccount, "name" | "displayName">): string {
  return account.displayName?.trim() || account.name;
}

/** Readable text color for surfaces painted in an account color (YIQ luma). */
export function getAccountContrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#1d1c1d" : "#ffffff";
}
