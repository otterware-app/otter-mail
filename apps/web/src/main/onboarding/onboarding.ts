import { useSyncExternalStore } from "react";
import { toast, type ToastId } from "../mail/toast";

/**
 * Where this device is in getting started: the setup (a mailbox, a look, how
 * you work, the agent, the keys) and the tour of the app. Kept in
 * localStorage, per device: the setup resumes where it was left (a Gmail
 * sign-in on the web leaves the page), and runs again once every mailbox is
 * gone. The tour is asked for from the setup's last step, the command
 * palette or Settings, and the mail view runs it.
 */

export type SetupStage = "setup" | "done";

const STAGE_KEY = "otter:onboarding";
const STEP_KEY = "otter:onboarding:step";

let tourRequested = false;
let tourOffer: ToastId | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function getSetupStage(): SetupStage | null {
  const value = localStorage.getItem(STAGE_KEY);
  return value === "setup" || value === "done" ? value : null;
}

export function useSetupStage(): SetupStage | null {
  return useSyncExternalStore(subscribe, getSetupStage);
}

/** Shows the setup (again), from `step` when given. */
export function startSetup(step?: string): void {
  console.log("[Onboarding:startSetup]", { step });
  withdrawTourOffer();
  if (step) localStorage.setItem(STEP_KEY, step);
  else localStorage.removeItem(STEP_KEY);
  localStorage.setItem(STAGE_KEY, "setup");
  emit();
}

export function finishSetup(): void {
  console.log("[Onboarding:finishSetup]");
  localStorage.setItem(STAGE_KEY, "done");
  localStorage.removeItem(STEP_KEY);
  emit();
}

/** Marks a device that already had mail as set up, without showing the setup. */
export function markSetUp(): void {
  localStorage.setItem(STAGE_KEY, "done");
  emit();
}

export function getSavedStep(): string | null {
  return localStorage.getItem(STEP_KEY);
}

export function saveStep(step: string): void {
  localStorage.setItem(STEP_KEY, step);
}

/** Offers the tour in a toast, to someone whose mail was already here. */
export function offerTour(): void {
  tourOffer = toast.info("New to Otter Mail?", {
    description: "A one-minute tour of what it can do.",
    action: { label: "Take the tour", onClick: requestTour },
  });
}

function withdrawTourOffer(): void {
  if (tourOffer) toast.close(tourOffer);
  tourOffer = null;
}

export function requestTour(): void {
  console.log("[Onboarding:requestTour]");
  withdrawTourOffer();
  tourRequested = true;
  emit();
}

export function endTour(): void {
  tourRequested = false;
  emit();
}

export function useTourRequested(): boolean {
  return useSyncExternalStore(subscribe, () => tourRequested);
}
