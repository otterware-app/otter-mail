import { toast } from "./toast";
import { forgetUndo, registerUndo, type UndoAction } from "./undo";

/**
 * Undo send (Gmail's): a sent message waits a few seconds before it really
 * goes, with "Sending… Undo" on screen (z / ⌘Z work too). Composers close
 * right away, and their last autosave keeps the draft in Drafts — so taking
 * the send back reopens that draft, and a send that fails leaves it there.
 */

/** How long a message is held before it's handed to Gmail. */
export const UNDO_SEND_MS = 10_000;

export type SavedDraft = { accountId: string; messageId: string };

let openDraft: (draft: SavedDraft) => void = () => {};

/** Where a taken-back message reopens (the main view registers the reader). */
export function setDraftOpener(open: (draft: SavedDraft) => void): () => void {
  openDraft = open;
  return () => {
    if (openDraft === open) openDraft = () => {};
  };
}

export function sendWithUndo({
  subject,
  send,
  onSent,
  savedDraft,
}: {
  /** Shown under "Sending…" / "Sent". */
  subject: string;
  /** Hands the message to Gmail (the payload is captured by the caller). */
  send: () => Promise<unknown>;
  /** After Gmail took it: e.g. delete the draft copy. */
  onSent?: () => Promise<unknown> | void;
  /** The draft the composer left behind, to reopen when the send is undone. */
  savedDraft: () => Promise<SavedDraft | null>;
}): void {
  let state: "waiting" | "sending" | "cancelled" = "waiting";
  const description = subject.trim() || "(no subject)";

  const cancel = () => {
    if (state !== "waiting") return;
    state = "cancelled";
    clearTimeout(timer);
    forgetUndo(undoEntry);
    toast.close(toastId);
    console.log("[undoSend:cancelled]", { subject: description });
    void savedDraft().then((draft) => {
      if (draft) {
        openDraft(draft);
        toast.info("Sending undone", { description: "The message is back in the composer." });
      } else {
        toast.info("Sending undone", { description: "The message was kept in Drafts." });
      }
    });
  };

  const undoEntry: UndoAction = { kind: "callback", run: cancel };
  const toastId = toast.loading("Sending…", {
    description,
    action: { label: "Undo", onClick: cancel },
  });
  registerUndo(undoEntry);

  const timer = setTimeout(() => {
    if (state !== "waiting") return;
    state = "sending";
    forgetUndo(undoEntry);
    // Past the point of no return: the Undo button goes.
    toast.update(toastId, "loading", "Sending…", { description, timeout: 0 });
    console.log("[undoSend:sending]", { subject: description });
    send().then(
      async () => {
        await onSent?.();
        toast.update(toastId, "success", "Sent", { description });
      },
      () => toast.update(toastId, "error", `Couldn't send “${description}” — kept in Drafts`),
    );
  }, UNDO_SEND_MS);
}
