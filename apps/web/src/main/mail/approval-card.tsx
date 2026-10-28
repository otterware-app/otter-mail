/**
 * An agent asking before it acts, ChatGPT's way: in place of the composer, a
 * card that asks "Allow Claude to …?", shows exactly what will happen, and
 * answers with Deny (Esc) or Allow once (↩, focused). Allowing it for the rest
 * of the chat, and stopping the turn, are behind "…".
 */

import { EllipsisIcon, FileIcon, HandIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import type { ApprovalDecision, ApprovalRequest } from "./api";
import { COMPOSER_SURFACE } from "./composer-kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./menu";
import { Btn, cn, Kbd } from "./ui";

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

/** Files as ChatGPT names them in a question: an icon and the name, the path on hover. */
function Files({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 3);
  return (
    <>
      {shown.map((path, i) => (
        <span key={path}>
          {i > 0 ? (i === shown.length - 1 && paths.length <= 3 ? " and " : ", ") : null}
          <span title={path} className="whitespace-nowrap text-info-foreground">
            <FileIcon className="mr-1 inline size-3.5 -translate-y-px" aria-hidden />
            {basename(path)}
          </span>
        </span>
      ))}
      {paths.length > 3 ? ` and ${paths.length - 3} more` : null}
    </>
  );
}

/** "Allow Claude to run this command?", from what kind of thing the agent wants to do. */
function question(agent: string, approval: ApprovalRequest): ReactNode {
  switch (approval.kind) {
    case "command":
      return `Allow ${agent} to run this command?`;
    case "fileChange": {
      const paths = (approval.detail ?? "").split("\n").filter(Boolean);
      return paths.length > 0 ? (
        <>
          Allow {agent} to edit <Files paths={paths} />?
        </>
      ) : (
        `Allow ${agent} to edit files?`
      );
    }
    case "permission":
      return `Allow ${agent} to change its permissions?`;
    case "tool":
      // Otter Mail's tools ask with their title ("Send email"); other tools, generically.
      return approval.title === "Tool approval"
        ? `Allow ${agent} to use a tool?`
        : `Allow ${agent} to ${approval.title[0]!.toLowerCase()}${approval.title.slice(1)}?`;
  }
}

export function ApprovalCard({
  agent,
  approval,
  pendingCount,
  responding,
  onRespond,
  onCancel,
}: {
  /** Who is asking ("Claude"). */
  agent: string;
  approval: ApprovalRequest;
  pendingCount: number;
  responding: boolean;
  onRespond: (decision: ApprovalDecision) => void;
  /** Stops the whole turn (T3's "Cancel" decision). */
  onCancel: () => void;
}) {
  const allow = useRef<HTMLButtonElement>(null);

  // Allow once takes the focus the composer had, so ↩ allows; focus elsewhere
  // (a draft being written) is left alone. The chat keys the card by approval.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) allow.current?.focus();
  }, []);

  const more = [
    ...(approval.choices.includes("session")
      ? [{ label: "Allow for this chat", run: () => onRespond("session") }]
      : []),
    ...(approval.choices.includes("always")
      ? [{ label: "Always allow", run: () => onRespond("always") }]
      : []),
    { label: "Stop the agent", run: onCancel },
  ];
  // Commands and permissions are shown as they are; a tool's detail is prose.
  const code = approval.kind === "command" || approval.kind === "permission";
  const note = [approval.reason, approval.kind === "tool" ? approval.detail : undefined]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="group"
      aria-label={approval.title}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || responding) return;
        event.preventDefault();
        onRespond("deny");
      }}
      className={cn("flex flex-col gap-3 px-4 pt-3.5 pb-3", COMPOSER_SURFACE)}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <HandIcon className="size-3.5" aria-hidden />
        <span>Permissions</span>
        {pendingCount > 1 ? (
          <span className="ml-auto tabular-nums">1 of {pendingCount}</span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-[15px] leading-snug text-foreground">{question(agent, approval)}</p>
        {note ? (
          <p className="max-h-24 overflow-auto whitespace-pre-line text-[13px] text-muted-foreground [scrollbar-width:thin]">
            {note}
          </p>
        ) : null}
        {code && approval.detail ? (
          <code className="block max-h-24 overflow-auto rounded-lg bg-muted/60 px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] [scrollbar-width:thin]">
            {approval.detail}
          </code>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Btn
              size="icon-sm"
              variant="ghost-muted"
              aria-label="More options"
              disabled={responding}
              className="rounded-full"
            >
              <EllipsisIcon />
            </Btn>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            {more.map((item) => (
              <DropdownMenuItem key={item.label} onSelect={item.run}>
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Btn
          size="sm"
          disabled={responding}
          onClick={() => onRespond("deny")}
          className="rounded-full pr-1.5"
        >
          Deny
          <Kbd>Esc</Kbd>
        </Btn>
        <Btn
          ref={allow}
          size="sm"
          disabled={responding}
          onClick={() => onRespond("once")}
          className="rounded-full pr-1.5 focus:ring-2 focus:ring-focus-ring focus:ring-offset-1 focus:ring-offset-(--chat-composer-surface)"
        >
          Allow once
          <Kbd>↩</Kbd>
        </Btn>
      </div>
    </div>
  );
}
