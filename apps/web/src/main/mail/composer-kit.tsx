import { TimePicker } from "./mail-schedule";
import { useState, type ReactNode } from "react";
import { PaperclipIcon, Trash2Icon, TypeIcon } from "lucide-react";
import { matchesCommand } from "../keybindings/dispatch";
import { ShortcutText } from "../keybindings/store";
import { HintTooltip, IconBtn, cn } from "./ui";
import type { DraftRemoteState, DraftSaveState } from "./use-draft-autosave";
import { normalizeAddressList } from "./address";
import { diffText } from "./text-diff";
import { htmlToText } from "./text";
import type { GmailMessageDetail } from "./types";

/**
 * Shared building blocks for every composer (new message, inline reply /
 * forward, draft editor), so they look and behave the same: a card surface,
 * labelled field rows, and one footer (attach · formatting · discard · status
 * · ⌘↩ · Send).
 */

/**
 * Codex's composer card: a big soft surface. Light themes keep a faint outline
 * and shadow; dark themes let the raised tone carry it.
 */
export const COMPOSER_SURFACE =
  "rounded-3xl border border-(--chat-composer-outline) bg-(--chat-composer-surface) shadow-composer transition-colors focus-within:border-input/70 dark:border-transparent dark:shadow-none dark:inset-shadow-2xs dark:inset-shadow-(color:--chat-composer-highlight) dark:focus-within:border-transparent";

/**
 * The composer surface; ⌘↩ inside it sends. `card` is Otter Code's floating
 * chat-composer card (inline reply, draft in a thread); `plain` is for the
 * full-page composer, which is its own surface.
 */
export function ComposerCard({
  onSend,
  variant = "card",
  className,
  children,
}: {
  onSend: () => void;
  variant?: "card" | "plain";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-col", variant === "card" && COMPOSER_SURFACE, className)}
      onKeyDown={(e) => {
        // Dialogs are portalled but their key events still bubble through React.
        if ((e.target as Element).closest('[role="dialog"]')) return;
        if (matchesCommand(e.nativeEvent, "composer.send")) {
          e.preventDefault();
          onSend();
        }
      }}
    >
      {children}
    </div>
  );
}

/** One labelled header row (From, To, Cc, Subject…), hairline-separated. */
export function ComposerField({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-border/40 px-5 py-1 text-sm">
      <span className="w-14 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </div>
  );
}

/** Quiet "Cc Bcc" reveal buttons for the To row. */
export function CcBccToggles({
  showCc,
  showBcc,
  onShowCc,
  onShowBcc,
}: {
  showCc: boolean;
  showBcc: boolean;
  onShowCc: () => void;
  onShowBcc: () => void;
}) {
  const btn =
    "cursor-pointer rounded-md px-1.5 py-0.5 text-sm text-muted-foreground/80 outline-none hover:bg-accent-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring";
  return (
    <>
      {!showCc ? (
        <button type="button" className={btn} onClick={onShowCc}>
          Cc
        </button>
      ) : null}
      {!showBcc ? (
        <button type="button" className={btn} onClick={onShowBcc}>
          Bcc
        </button>
      ) : null}
    </>
  );
}

/** Subject field input, styled as the message's title. */
export function SubjectInput({
  value,
  onChange,
  placeholder = "Subject",
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The page's headline (a full-page draft), not a field row. */
  title?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label="Subject"
      className={cn(
        "min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:font-normal placeholder:text-placeholder",
        title ? "w-full text-xl font-medium leading-8 tracking-tight" : "text-sm font-medium",
      )}
    />
  );
}

/** The fields a conflict compares. */
export type DraftVersionText = { to: string; cc?: string; subject: string; body: string };

/**
 * Shown when the open draft changed elsewhere (an agent, Gmail web, a phone)
 * while this composer had unsaved edits — with a diff of what "Keep mine"
 * would change in their version — or when it was sent/deleted elsewhere.
 */
export function DraftRemoteBanner({
  remote,
  mine,
  onTakeTheirs,
  onKeepMine,
  onSaveAsNew,
}: {
  remote: DraftRemoteState | null;
  /** This composer's current version (for the conflict diff). */
  mine: DraftVersionText;
  onTakeTheirs: () => void;
  onKeepMine: () => void;
  onSaveAsNew: () => void;
}) {
  const [showDiff, setShowDiff] = useState(true);
  if (!remote) return null;
  const action =
    "h-6 cursor-pointer rounded-md px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  return (
    <div className="border-b border-warning/30 bg-warning/10">
      <div role="status" className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
        <span className="min-w-0 flex-1 text-warning-foreground">
          {remote.kind === "conflict"
            ? "This draft was changed elsewhere while you were editing."
            : "This draft was sent or deleted elsewhere."}
        </span>
        {remote.kind === "conflict" ? (
          <>
            <button
              type="button"
              onClick={() => setShowDiff((v) => !v)}
              className={cn(
                action,
                "text-muted-foreground hover:bg-warning/15 hover:text-foreground",
              )}
            >
              {showDiff ? "Hide changes" : "Show changes"}
            </button>
            <button
              type="button"
              onClick={onTakeTheirs}
              className={cn(action, "hover:bg-warning/15")}
            >
              Use their version
            </button>
            <button
              type="button"
              onClick={onKeepMine}
              className={cn(action, "bg-warning/20 text-foreground hover:bg-warning/30")}
            >
              Keep mine
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onSaveAsNew}
            className={cn(action, "bg-warning/20 text-foreground hover:bg-warning/30")}
          >
            Keep as a new draft
          </button>
        )}
      </div>
      {remote.kind === "conflict" && showDiff ? (
        <DraftDiff theirs={remote.detail} mine={mine} />
      ) : null}
    </div>
  );
}

/** What "Keep mine" would change in their version: fields, then the text. */
/* oxlint-disable react/no-array-index-key -- Stateless spans represent an ordered diff snapshot. */
function DraftDiff({ theirs, mine }: { theirs: GmailMessageDetail; mine: DraftVersionText }) {
  const theirBody = theirs.bodyText ?? (theirs.bodyHtml ? htmlToText(theirs.bodyHtml) : "");
  const fields = [
    { label: "Subject", theirs: theirs.subject ?? "", mine: mine.subject },
    {
      label: "To",
      theirs: normalizeAddressList(theirs.to ?? ""),
      mine: normalizeAddressList(mine.to),
    },
    {
      label: "Cc",
      theirs: normalizeAddressList(theirs.cc ?? ""),
      mine: normalizeAddressList(mine.cc ?? ""),
    },
  ].filter((f) => f.theirs.trim() !== f.mine.trim());
  const parts = diffText(theirBody.trim(), mine.body.trim());
  const changed = parts.some((p) => p.kind !== "same");
  return (
    <div className="te-scroll max-h-56 space-y-2 overflow-y-auto border-t border-warning/20 bg-canvas/60 px-4 py-3 text-xs leading-relaxed">
      <div className="flex items-center gap-3 text-2xs text-muted-foreground">
        <span>Keeping yours would change their version:</span>
        <span className="rounded-sm bg-emerald-500/15 px-1 text-emerald-600 dark:text-emerald-400">
          your text
        </span>
        <span className="rounded-sm bg-red-500/15 px-1 text-red-600 line-through dark:text-red-400">
          their text
        </span>
      </div>
      {fields.map((f) => (
        <div key={f.label} className="flex gap-2">
          <span className="w-14 shrink-0 text-muted-foreground">{f.label}</span>
          <span className="min-w-0">
            {f.theirs ? (
              <span className="rounded-sm bg-red-500/15 text-red-600 line-through dark:text-red-400">
                {f.theirs}
              </span>
            ) : null}{" "}
            {f.mine ? (
              <span className="rounded-sm bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                {f.mine}
              </span>
            ) : null}
          </span>
        </div>
      ))}
      <p className="whitespace-pre-wrap text-foreground/90">
        {changed
          ? parts.map((part, i) =>
              part.kind === "same" ? (
                <span key={i}>{part.text}</span>
              ) : part.kind === "added" ? (
                <span
                  key={i}
                  className="rounded-sm bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                >
                  {part.text}
                </span>
              ) : (
                <span
                  key={i}
                  className="mr-0.5 rounded-sm bg-red-500/15 text-red-600 line-through dark:text-red-400"
                >
                  {part.text}
                </span>
              ),
            )
          : "The message text is the same."}
      </p>
    </div>
  );
}
/* oxlint-enable react/no-array-index-key */

/** Footer status for a composer's draft. */
export function draftStatus(draft: {
  saveState: DraftSaveState;
  remoteNotice: boolean;
}): string | null {
  if (draft.remoteNotice) return "Updated elsewhere";
  return draftStatusText(draft.saveState);
}

export function draftStatusText(state: DraftSaveState): string | null {
  if (state === "saving") return "Saving draft…";
  if (state === "saved") return "Draft saved";
  if (state === "error") return "Couldn't save draft — retrying";
  return null;
}

/** Codex-size icon buttons for the composer footer. */
const FOOTER_ICON = "size-8 rounded-lg";

/** Attach · formatting · discard on the left; status, ⌘↩ hint and Send on the right. */
export function ComposerFooter({
  onAttach,
  attachDisabled,
  formatting,
  onToggleFormatting,
  onDiscard,
  status,
  statusTone = "muted",
  canSend,
  onSend,
  onSchedule,
  className,
}: {
  onAttach: () => void;
  attachDisabled?: boolean;
  formatting: boolean;
  onToggleFormatting: () => void;
  onDiscard: () => void;
  status?: ReactNode;
  statusTone?: "muted" | "error";
  canSend: boolean;
  onSend: () => void;
  onSchedule: (time: number) => Promise<unknown>;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 px-3 py-2.5", className)}>
      <HintTooltip label="Attach files">
        <IconBtn
          label="Attach files"
          disabled={attachDisabled}
          onClick={onAttach}
          className={FOOTER_ICON}
        >
          <PaperclipIcon className="size-4" />
        </IconBtn>
      </HintTooltip>
      <HintTooltip label={formatting ? "Hide formatting" : "Formatting"}>
        <IconBtn
          label="Formatting"
          active={formatting}
          onClick={onToggleFormatting}
          className={FOOTER_ICON}
        >
          <TypeIcon className="size-4" />
        </IconBtn>
      </HintTooltip>
      <HintTooltip label="Discard draft">
        <IconBtn
          label="Discard draft"
          onClick={onDiscard}
          className={cn(FOOTER_ICON, "hover:text-destructive-foreground")}
        >
          <Trash2Icon className="size-4" />
        </IconBtn>
      </HintTooltip>
      {status ? (
        <span
          className={cn(
            "min-w-0 truncate pl-2 text-sm",
            statusTone === "error" ? "text-destructive-foreground" : "text-muted-foreground/70",
          )}
        >
          {status}
        </span>
      ) : null}
      <span className="flex-1" />
      <TimePicker title="Schedule send" disabled={!canSend} onChoose={onSchedule} />
      <button
        type="button"
        onClick={onSend}
        disabled={!canSend}
        className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-30"
      >
        Send
        <ShortcutText command="composer.send" className="text-[13px] font-normal opacity-60" />
      </button>
    </div>
  );
}

/**
 * Full-height compose page (a new message, or a draft with no conversation):
 * header fields and the body scroll as one document; the footer stays put.
 */
export function ComposeDocument({
  fields,
  subject,
  editor,
  attachments,
  footer,
}: {
  fields: ReactNode;
  /** The subject as the page's headline, between the recipients and the body. */
  subject?: ReactNode;
  editor: ReactNode;
  attachments?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="te-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-2 pt-2">
          {fields}
          {subject ? <div className="px-5 pb-1 pt-6">{subject}</div> : null}
          <div className="flex min-h-0 flex-1 flex-col">{editor}</div>
          {attachments}
        </div>
      </div>
      <div className="shrink-0 border-t border-border/40">
        <div className="mx-auto w-full max-w-3xl px-2">{footer}</div>
      </div>
    </div>
  );
}
