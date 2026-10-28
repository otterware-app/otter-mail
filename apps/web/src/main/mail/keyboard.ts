/**
 * Guard for single-key Gmail-style shortcuts: ignore keystrokes aimed at
 * inputs, editors, or any open dialog/popover so typing never triggers mail
 * actions.
 */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return isOverlayOpen();
}

/**
 * A dialog or popover is open. Toasts don't count: Base UI gives each one
 * role="dialog", but they're passing notices ("Archived · Undo") and must not
 * swallow mail shortcuts while they're on screen.
 */
export function isOverlayOpen(): boolean {
  return Array.from(
    document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper]'),
  ).some((el) => !el.closest('[data-slot="toast-viewport"]'));
}
