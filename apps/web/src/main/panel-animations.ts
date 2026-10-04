/**
 * Panel animation duration (ported from Otter Code's panelAnimations): how
 * long the sidebar, agent panel and floating reader take to open and close. 0 turns the
 * motion off. Lives in localStorage like the other per-device UI choices.
 */

import { setSyncedPreference } from "./synced-preferences";
import { useEffect, useState, useSyncExternalStore } from "react";

export const MIN_PANEL_ANIMATION_DURATION_MS = 0;
export const MAX_PANEL_ANIMATION_DURATION_MS = 400;
export const DEFAULT_PANEL_ANIMATION_DURATION_MS = 150;

const KEY = "gmail:panel-animation-duration" as const;
const CHANGE_EVENT = "gmail:panel-animation-duration-change";

function isValidDuration(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_PANEL_ANIMATION_DURATION_MS &&
    value <= MAX_PANEL_ANIMATION_DURATION_MS
  );
}

export function getPanelAnimationDurationMs(): number {
  const raw = localStorage.getItem(KEY);
  const value = raw === null ? NaN : Number(raw);
  return isValidDuration(value) ? value : DEFAULT_PANEL_ANIMATION_DURATION_MS;
}

export function setPanelAnimationDurationMs(durationMs: number): void {
  if (!isValidDuration(durationMs)) return;
  setSyncedPreference(KEY, String(durationMs));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function usePanelAnimationDurationMs(): number {
  return useSyncExternalStore(subscribe, getPanelAnimationDurationMs);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Suppresses panel motion for the first painted frame of launch or a
 * navigation. State restored by a route must be visible immediately; later
 * user actions can animate.
 */
function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setPaintedNavigationKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

export function usePanelAnimationSettings(navigationKey: string): {
  active: boolean;
  durationMs: number;
} {
  const durationMs = usePanelAnimationDurationMs();
  const prefersReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );
  const suppressed = usePanelNavigationSuppression(navigationKey);
  return { active: durationMs > 0 && !prefersReducedMotion && !suppressed, durationMs };
}

/** Keeps a closing panel mounted until its opt-in transition ends. */
export function usePanelPresence(open: boolean, animated: boolean, durationMs: number): boolean {
  const [present, setPresent] = useState(open);

  if (open && !present) setPresent(true);
  if (!open && !animated && present) setPresent(false);

  useEffect(() => {
    if (open || !animated) return;
    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => window.clearTimeout(timeout);
  }, [animated, durationMs, open]);

  return open || (animated && present);
}
