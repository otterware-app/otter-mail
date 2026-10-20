/**
 * A chat's transcript: the user's messages with what they carried (context,
 * skill, files, citations), and each agent turn's reply, with its work folded
 * behind a "Worked for …" row once it's done and the changes it made below.
 */

import { useEffect, useState } from "react";
import { MessageScroller } from "@shadcn/react/message-scroller";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CheckIcon,
  CopyIcon,
  FilePenLineIcon,
  FolderIcon,
  LayersIcon,
  MailIcon,
  SendIcon,
  TextQuoteIcon,
  XIcon,
} from "lucide-react";
import { IconBtn, HintTooltip } from "./ui";
import { WorkLog } from "./work-log";
import type { ChatChange } from "./api";
import type { ContextKind, ContextMeta } from "./chat-context";
import type { ChatTurn } from "./chat-store";
import { ChatMarkdown } from "./chat-markdown";
import { ChatChanges } from "./chat-changes";
import { SentAttachments } from "./chat-attachments";
import { IntentMarker } from "./chat-queue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./menu";
import { toast } from "./toast";

export function ContextKindIcon({ kind, className }: { kind: ContextKind; className?: string }) {
  const Icon =
    kind === "project"
      ? FolderIcon
      : kind === "quote"
        ? TextQuoteIcon
        : kind === "draft"
          ? FilePenLineIcon
          : kind === "sent"
            ? SendIcon
            : kind === "mixed"
              ? LayersIcon
              : MailIcon;
  return <Icon className={className} />;
}

/** Command-style badge for an invoked skill (composer + user message). */
export function SkillBadge({
  name,
  onRemove,
  onAccent,
}: {
  name: string;
  onRemove?: () => void;
  onAccent?: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-semibold",
        onAccent ? "bg-foreground/8 text-foreground" : "bg-primary/10 text-primary",
      ].join(" ")}
    >
      <span className="opacity-50">/</span>
      {name}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove skill"
          className="opacity-70 hover:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

/** Chip recap of the context sent with a user turn. */
function ContextRecap({
  context,
  onOpen,
}: {
  context: ContextMeta;
  onOpen: (item: { title: string; target: ChatChange["target"] }) => void;
}) {
  const label =
    context.count > 1
      ? `${context.count} conversations`
      : (context.subjects[0] ?? "1 conversation");
  const items = context.items ?? [];
  const chipClass =
    "flex max-w-64 items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground";
  return (
    <div className="mb-1 flex justify-end">
      {items.length === 1 ? (
        <button
          type="button"
          onClick={() => onOpen(items[0])}
          title={items[0].title}
          aria-label={`Open context: ${items[0].title}`}
          className={`${chipClass} cursor-pointer hover:bg-accent-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring`}
        >
          <ContextKindIcon kind={context.kind} className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </button>
      ) : items.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={`${chipClass} cursor-pointer hover:bg-accent-surface hover:text-foreground`}
              aria-label={`Open ${label}`}
            >
              <ContextKindIcon kind={context.kind} className="size-3 shrink-0" />
              <span>{label}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items.map((item) => (
              <DropdownMenuItem key={JSON.stringify(item)} onSelect={() => onOpen(item)}>
                {item.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className={chipClass}>
          <ContextKindIcon kind={context.kind} className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{label}</span>
        </span>
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `${mins}m ${total % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Live elapsed time for the "Working for" row. */
function WorkingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(now - startedAt)}</>;
}

/** Bottom-of-turn activity row while Hermes is still running. */
function WorkingRow({ startedAt }: { startedAt?: number }) {
  return (
    <div className="border-b border-border/40 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        <span className="relative shrink-0 whitespace-nowrap animate-status-pulse">
          {startedAt ? (
            <>
              Working for <WorkingTimer startedAt={startedAt} />
            </>
          ) : (
            "Working…"
          )}
        </span>
      </div>
    </div>
  );
}

/** A run the app lost track of, waiting to be picked up again from the provider. */
function DetachedRow({ providerName }: { providerName: string }) {
  return (
    <div className="border-b border-border/40 pb-2 pt-1">
      <div className="flex h-6 min-w-0 items-baseline px-1 text-sm leading-relaxed text-muted-foreground">
        Lost {providerName} mid-reply — the rest shows here once it's back.
      </div>
    </div>
  );
}

/** Collapsed summary of a finished run; toggles the tool rows underneath. */
function WorkFoldRow({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="relative flex items-center gap-1 border-b border-border/40 pb-2 pe-0.5 pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring/70"
      >
        <span>{label}</span>
        <Icon className="size-3.5 opacity-70" />
      </button>
    </div>
  );
}

/** Failed turn: red heading row plus the explanation underneath. */
function ErrorRow({ message, providerName }: { message: string; providerName: string }) {
  return (
    <div className="flex flex-col px-0.5 py-1">
      <div className="flex items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center text-destructive">
          <CircleAlertIcon className="size-4 stroke-2" aria-hidden />
        </span>
        <span className="text-sm font-medium leading-relaxed text-destructive">
          {providerName} error
        </span>
      </div>
      <p className="ms-7 select-text text-sm leading-relaxed text-foreground/80">{message}</p>
    </div>
  );
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <HintTooltip label={copied ? "Copied" : "Copy message"}>
      <IconBtn
        label={copied ? "Copied" : "Copy message"}
        className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => toast.error("Couldn't copy message"),
          );
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </IconBtn>
    </HintTooltip>
  );
}

export function ChatTranscript({
  turns,
  streaming,
  detached,
  providerName,
  onOpenFile,
  loadImage,
  onOpenContext,
  onOpenChange,
}: {
  turns: ChatTurn[];
  /** A turn of this chat is running: the last one streams. */
  streaming: boolean;
  /** Its run was let go of mid-reply, waiting to be picked up again. */
  detached: boolean;
  providerName: string;
  onOpenFile: (href: string) => void;
  loadImage: (href: string) => Promise<string>;
  onOpenContext: (item: { title: string; target: ChatChange["target"] }) => void;
  onOpenChange: (change: ChatChange) => Promise<void>;
}) {
  // Finished runs fold their tool rows behind a "Worked for …" summary.
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const toggleFold = (id: string) =>
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return turns.map((turn) => {
    if (turn.role === "user") {
      return (
        <MessageScroller.Item key={turn.id} messageId={turn.id} scrollAnchor>
          <div className="group flex flex-col items-end gap-1 py-3">
            {turn.intent ? <IntentMarker intent={turn.intent} /> : null}
            {turn.context ? <ContextRecap context={turn.context} onOpen={onOpenContext} /> : null}
            <div className="relative max-w-[80%] select-text whitespace-pre-wrap rounded-2xl bg-message px-4 py-2.5 text-sm leading-relaxed text-message-foreground wrap-anywhere">
              {turn.skill ? (
                <span className="mb-1 mr-1.5 inline-flex align-middle">
                  <SkillBadge name={turn.skill} onAccent />
                </span>
              ) : null}
              {turn.attachments ? <SentAttachments attachments={turn.attachments} /> : null}
              {turn.citations?.map((citation, at) => (
                // oxlint-disable-next-line react/no-array-index-key -- A sent message's citations never change.
                <div key={at} className="mb-2">
                  <div className="line-clamp-3 border-l-2 border-message-foreground/25 pl-2.5 text-message-foreground/70">
                    {citation.text}
                  </div>
                  {citation.comment ? <div className="mt-1">{citation.comment}</div> : null}
                </div>
              ))}
              {turn.text}
            </div>
            {turn.text ? <CopyMessageButton text={turn.text} /> : null}
          </div>
        </MessageScroller.Item>
      );
    }
    const isLast = turn.id === turns[turns.length - 1]?.id;
    const live = streaming && isLast && !turn.finishedAt && !turn.error;
    // Progress messages and tool steps fold away; the final reply stays.
    const items = (turn.items ?? []).filter((item) => item.kind === "step" || item.text.trim());
    const lastStep = items.findLastIndex((item) => item.kind === "step");
    const work = items.slice(0, lastStep + 1);
    const answer = items
      .slice(lastStep + 1)
      .map((item) => (item.kind === "text" ? item.text.trim() : ""))
      .join("\n\n");
    const steps = work.filter((item) => item.kind === "step").length;
    const folded = steps > 0 && !live;
    const showWork = steps > 0 && (live || expandedFolds.has(turn.id));
    const foldLabel =
      turn.startedAt && turn.finishedAt
        ? `Worked for ${formatDuration(turn.finishedAt - turn.startedAt)}`
        : `Took ${steps} step${steps === 1 ? "" : "s"}`;
    return (
      <MessageScroller.Item key={turn.id} messageId={turn.id} scrollAnchor>
        <div className="flex flex-col">
          {folded ? (
            <WorkFoldRow
              label={foldLabel}
              expanded={expandedFolds.has(turn.id)}
              onToggle={() => toggleFold(turn.id)}
            />
          ) : null}
          {showWork ? <WorkLog items={work} onOpenFile={onOpenFile} loadImage={loadImage} /> : null}
          {answer ? (
            <div className="group min-w-0 px-1 py-2">
              <div data-cite-source>
                <ChatMarkdown text={answer} onOpenFile={onOpenFile} loadImage={loadImage} />
              </div>
              {!live ? (
                <div className="mt-1">
                  <CopyMessageButton text={answer} />
                </div>
              ) : null}
            </div>
          ) : null}
          {live ? <WorkingRow startedAt={turn.startedAt} /> : null}
          {isLast && !streaming && detached ? <DetachedRow providerName={providerName} /> : null}
          {turn.error ? <ErrorRow message={turn.error} providerName={providerName} /> : null}
          {!live && turn.changes?.length ? (
            <ChatChanges changes={turn.changes} onOpen={onOpenChange} />
          ) : null}
        </div>
      </MessageScroller.Item>
    );
  });
}
