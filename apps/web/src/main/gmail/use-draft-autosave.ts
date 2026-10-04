import { useLatest } from "../use-latest";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { gmailApi } from "./api";
import type { ComposeAttachment, GmailMessageDetail } from "./types";

export type DraftSaveState = "idle" | "saving" | "saved" | "error";

/** The draft changed outside this composer (Hermes, Gmail web, a phone). */
export type DraftRemoteState =
  /** Edited elsewhere while this composer has unsaved edits: the user picks. */
  | { kind: "conflict"; detail: GmailMessageDetail }
  /** Sent or deleted elsewhere. */
  | { kind: "gone" };

/** How often an open draft checks whether it was edited elsewhere. */
const REMOTE_CHECK_MS = 10_000;
/** How long "Updated elsewhere" shows after an in-place reload. */
const REMOTE_NOTICE_MS = 4_000;

/**
 * Debounced Gmail-draft autosave shared by every composer. Creates a draft on
 * the first meaningful edit, updates it in place afterwards (moving it when
 * the From account changes), retries failures, flushes on unmount, and
 * refreshes the mail lists once on the way out — never mid-edit, since every
 * draft update mints a new message id.
 *
 * Collaboration: the draft can also be edited elsewhere (an agent, Gmail web,
 * a phone). While open, the composer checks the draft's current version every
 * few seconds, and every save states the version it builds on:
 *  - no unsaved edits → the new version loads in place (`onRemoteChange`);
 *  - unsaved edits → autosave pauses and `remote` asks the user to choose;
 *  - sent/deleted elsewhere → autosave stops; the user can keep a new copy.
 * Closing with an unresolved conflict keeps the user's text as a new draft,
 * so neither version is lost.
 */
export function useDraftAutosave({
  accountId,
  threadId,
  signal,
  getPayload,
  delayMs = 1500,
  enabled = true,
  initialDraftId,
  initialMessageId,
  onRemoteChange,
}: {
  accountId: string | null;
  threadId?: string;
  /** Debounce after the last edit (longer when big attachments ride along). */
  delayMs?: number;
  /** Serialized editing state; every change re-arms the debounce. */
  signal: string;
  /** null = nothing worth persisting yet (e.g. empty composer). */
  getPayload: () => {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    body: string;
    bodyHtml: string;
    attachments?: ComposeAttachment[];
  } | null;
  /** false while the composer is still loading (resumed draft, attachments). */
  enabled?: boolean;
  /** An existing draft being resumed (may arrive after mount). */
  initialDraftId?: string | null;
  /** The version the resumed draft was opened at. */
  initialMessageId?: string;
  /** Loads another version into the composer's fields. */
  onRemoteChange?: (detail: GmailMessageDetail) => void | Promise<void>;
}) {
  const qc = useQueryClient();
  const [saveState, setSaveState] = useState<DraftSaveState>("idle");
  const [remote, setRemote] = useState<DraftRemoteState | null>(null);
  const [remoteNotice, setRemoteNotice] = useState(false);

  const draftIdRef = useRef<string | null>(initialDraftId ?? null);
  const draftAccountRef = useRef<string | null>(initialDraftId ? accountId : null);
  // The version this composer's content builds on (our last save, or the one
  // we opened / loaded). Anything else on Gmail was written elsewhere.
  const versionRef = useRef<string | null>(initialMessageId ?? null);
  // Thread Gmail assigned on the first save. Without pinning it, every update
  // re-threads the draft — a new list row per save until sync reconciles.
  const adoptedThreadRef = useRef<string | null>(null);
  const doneRef = useRef(false);
  const savingRef = useRef(false);
  const unmountedRef = useRef(false);
  /** Saves suspended: loading, applying another version, or awaiting a choice. */
  const pausedRef = useRef(!enabled);
  const remoteRef = useLatest(remote);
  const sessionKeyRef = useRef(crypto.randomUUID());
  const snapshotRef = useRef(signal);

  const signalRef = useLatest(signal);
  const accountRef = useLatest(accountId);
  const threadRef = useLatest(threadId);
  const getPayloadRef = useLatest(getPayload);
  const onRemoteChangeRef = useLatest(onRemoteChange);

  // A resumed draft's id can arrive after mount (looked up by message id).
  useEffect(() => {
    if (initialDraftId && !draftIdRef.current) {
      draftIdRef.current = initialDraftId;
      draftAccountRef.current = accountRef.current;
    }
  }, [initialDraftId, accountRef]);

  /**
   * Treats whatever the composer shows a moment from now as already saved:
   * after it seeds itself (editor, signature) or loads another version, those
   * state updates must not look like edits and trigger a save.
   */
  const adoptingRef = useRef(false);
  const adoptCurrentSoon = () => {
    adoptingRef.current = true;
    setTimeout(() => {
      snapshotRef.current = signalRef.current;
      adoptingRef.current = false;
    }, 300);
  };

  // Baseline once the composer is ready (not at first render: seeding the
  // editor changes the signal, and that alone isn't an edit).
  const adoptCurrentSoonForEffect = useLatest(adoptCurrentSoon);
  useEffect(() => {
    if (!enabled) return;
    adoptCurrentSoonForEffect.current();
    pausedRef.current = remoteRef.current != null;
  }, [enabled, adoptCurrentSoonForEffect, remoteRef]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["gmail:messages"] });
    void qc.invalidateQueries({ queryKey: ["gmail:combinedMessages"] });
    void qc.invalidateQueries({ queryKey: ["gmail:combinedCounts"] });
    void qc.invalidateQueries({ queryKey: ["gmail:thread"] });
    void qc.invalidateQueries({ queryKey: ["gmail:labels"] });
  };
  const refreshRef = useLatest(refresh);

  /** Loads another version into the composer (no save for that change). */
  const applyVersion = async (detail: GmailMessageDetail) => {
    pausedRef.current = true;
    try {
      await onRemoteChangeRef.current?.(detail);
      versionRef.current = detail.id;
      adoptCurrentSoon();
    } finally {
      pausedRef.current = false;
    }
  };

  /** Someone else saved `messageId`: reload in place, or ask if we have edits. */
  const handleRemoteVersion = async (messageId: string) => {
    const account = accountRef.current;
    const draftId = draftIdRef.current;
    if (!account || !draftId) return;
    pausedRef.current = true;
    try {
      const detail = await gmailApi.loadDraftVersion(account, draftId, messageId);
      const dirty = signalRef.current !== snapshotRef.current;
      console.log("[useDraftAutosave:remoteChange]", { draftId, dirty });
      if (dirty) {
        setRemote({ kind: "conflict", detail });
        return; // stays paused until the user chooses
      }
      await applyVersion(detail);
      setRemoteNotice(true);
      setTimeout(() => setRemoteNotice(false), REMOTE_NOTICE_MS);
    } catch (err) {
      console.log("[useDraftAutosave:remoteLoadFailed]", { error: String(err) });
      pausedRef.current = remoteRef.current != null;
    }
  };

  const markGone = () => {
    console.log("[useDraftAutosave:gone]", { draftId: draftIdRef.current });
    pausedRef.current = true;
    setRemote({ kind: "gone" });
  };

  const save = async () => {
    const account = accountRef.current;
    if (!account || doneRef.current || savingRef.current || pausedRef.current) return;
    if (adoptingRef.current || signalRef.current === snapshotRef.current) return;
    const payload = getPayloadRef.current();
    if (!payload) return;
    const snapshotAtSave = signalRef.current;
    savingRef.current = true;
    setSaveState("saving");
    try {
      // The From account changed under an existing draft — move it over.
      if (draftIdRef.current && draftAccountRef.current && draftAccountRef.current !== account) {
        try {
          await gmailApi.deleteDraft(draftAccountRef.current, draftIdRef.current);
        } catch {
          // orphan gets reconciled by sync
        }
        draftIdRef.current = null;
        versionRef.current = null;
        adoptedThreadRef.current = null;
      }
      const res = await gmailApi.saveDraft({
        accountId: account,
        draftId: draftIdRef.current ?? undefined,
        sessionKey: sessionKeyRef.current,
        expectMessageId: draftIdRef.current ? (versionRef.current ?? undefined) : undefined,
        ...payload,
        threadId: threadRef.current ?? adoptedThreadRef.current ?? undefined,
      });
      if ("gone" in res) {
        setSaveState("idle");
        markGone();
        return;
      }
      if ("conflict" in res) {
        setSaveState("idle");
        await handleRemoteVersion(res.messageId);
        return;
      }
      draftIdRef.current = res.draftId;
      draftAccountRef.current = account;
      if (res.messageId) versionRef.current = res.messageId;
      if (!threadRef.current && res.threadId) adoptedThreadRef.current = res.threadId;
      snapshotRef.current = snapshotAtSave;
      setSaveState("saved");
    } catch (err) {
      console.log("[useDraftAutosave:saveFailed]", { error: String(err) });
      setSaveState("error");
      // Retry while the composer is open; a closed one's last save carries on
      // in the backend (same session, so no duplicate draft).
      if (!unmountedRef.current) setTimeout(() => void triggerRef.current?.(), 5000);
    } finally {
      savingRef.current = false;
    }
  };
  const saveRef = useLatest(save);
  // The in-flight save, so finalize can await the unmount flush before
  // deleting (send path closes the composer first, optimistically).
  const pendingRef = useRef<Promise<void> | null>(null);
  const trigger = () => {
    const p = saveRef.current();
    pendingRef.current = p;
    return p;
  };
  const triggerRef = useRef<typeof trigger | null>(null);
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/immutability -- The retry callback closes over this ref; layout updates it before timers or cleanup can invoke it.
    triggerRef.current = trigger;
  });

  useEffect(() => {
    const timer = setTimeout(() => void triggerRef.current?.(), delayMs);
    return () => clearTimeout(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [signal, delayMs, triggerRef]);

  // Watch for edits made elsewhere while the composer is open and focused.
  const handleRemoteVersionForEffect = useLatest(handleRemoteVersion);
  const markGoneForEffect = useLatest(markGone);
  useEffect(() => {
    const check = async () => {
      const account = accountRef.current;
      const draftId = draftIdRef.current;
      if (!account || !draftId || !versionRef.current) return;
      if (doneRef.current || pausedRef.current || savingRef.current) return;
      if (typeof document !== "undefined" && !document.hasFocus()) return;
      try {
        const { messageId } = await gmailApi.getDraftVersion(account, draftId);
        // Re-check: a save of ours may have landed while we asked.
        if (doneRef.current || savingRef.current || pausedRef.current) return;
        if (messageId === null) markGoneForEffect.current();
        else if (messageId !== versionRef.current)
          await handleRemoteVersionForEffect.current(messageId);
      } catch (err) {
        console.log("[useDraftAutosave:checkFailed]", { error: String(err) });
      }
    };
    const timer = setInterval(() => void check(), REMOTE_CHECK_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [accountRef, handleRemoteVersionForEffect, markGoneForEffect]);

  // Flush the last edits and refresh the lists once, on the way out. With an
  // unresolved conflict (or the draft gone), the user's text is kept as a new
  // draft instead of overwriting the other version.
  useEffect(
    () => () => {
      unmountedRef.current = true;
      if (remoteRef.current) {
        draftIdRef.current = null;
        versionRef.current = null;
        pausedRef.current = false;
      }
      void Promise.resolve(triggerRef.current?.()).finally(() => refreshRef.current());
    },
    [refreshRef, remoteRef, triggerRef],
  );

  /** Conflict: load the other version, dropping this composer's edits. */
  const takeTheirs = () => {
    const current = remoteRef.current;
    if (current?.kind !== "conflict") return;
    setRemote(null);
    void applyVersion(current.detail);
  };

  /** Conflict: keep this composer's text, overwriting the other version. */
  const keepMine = () => {
    const current = remoteRef.current;
    if (current?.kind !== "conflict") return;
    versionRef.current = current.detail.id;
    setRemote(null);
    pausedRef.current = false;
    void triggerRef.current?.();
  };

  /** Gone: keep this composer's text as a new draft. */
  const saveAsNew = () => {
    draftIdRef.current = null;
    versionRef.current = null;
    snapshotRef.current = "";
    setRemote(null);
    pausedRef.current = false;
    void triggerRef.current?.();
  };

  /** Stop autosaving (send/discard); optionally delete the persisted draft. */
  const finalize = async (opts?: { deleteDraft?: boolean }) => {
    doneRef.current = true;
    // A flush kicked off by unmounting may still be creating the draft.
    if (pendingRef.current) await pendingRef.current;
    // Delete by id, or through the session: the backend waits for any save
    // still in flight and removes whatever draft it became.
    const account = draftAccountRef.current ?? accountRef.current;
    if (opts?.deleteDraft && account) {
      try {
        await gmailApi.deleteSessionDraft(
          account,
          sessionKeyRef.current,
          draftIdRef.current ?? undefined,
        );
      } catch {
        // sync reconciles leftovers
      }
      draftIdRef.current = null;
    }
    refreshRef.current();
  };

  /** Where the draft is once its last save landed (undo send reopens it). */
  const savedDraft = async (): Promise<{ accountId: string; messageId: string } | null> => {
    if (pendingRef.current) await pendingRef.current;
    // An earlier save may still be running (the closing flush skips then).
    for (let i = 0; i < 100 && savingRef.current; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const account = draftAccountRef.current;
    const messageId = versionRef.current;
    return account && messageId ? { accountId: account, messageId } : null;
  };

  /** Re-enable autosave after a failed send. */
  const reopen = () => {
    doneRef.current = false;
  };

  return {
    saveState,
    remote,
    /** True briefly after another version loaded in place. */
    remoteNotice,
    takeTheirs,
    keepMine,
    saveAsNew,
    finalize,
    savedDraft,
    reopen,
  };
}
