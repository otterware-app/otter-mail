import { ExternalLinkIcon, FileTextIcon, PenLineIcon, SearchIcon } from "lucide-react";
import type { MouseEvent } from "react";
import { getAccountColor, getAccountDisplayName } from "./account-style";
import { parseAddressEntry, splitAddressList } from "./address";
import { useAccounts, useMessage } from "./hooks";
import { SenderAvatar } from "./sender-avatar";
import type { GmailMessageDetail, GmailMessageSummary } from "./types";
import { HintTooltip, cn } from "./ui";
import { UnsubscribeLink } from "./unsubscribe-link";
import { openLink } from "../browser/store";
import { isModClick } from "../keybindings/keys";

type OpenFile = (messageId: string, attachment: GmailMessageDetail["attachments"][number]) => void;

/**
 * A conversation at a glance (Codex's pinned summary): where it lives and
 * how long it's run, everyone in it, every file sent in it, and the way out
 * of a mailing list. Pinned beside the reader when there's room, or opened
 * from the header's toggle as a popover.
 */
export function ConversationSummary({
  accountId,
  threadId,
  rows,
  onComposeTo,
  onSearchSender,
  onOpenFile,
  className,
}: {
  accountId: string;
  threadId: string;
  rows: GmailMessageSummary[];
  onComposeTo?: (email: string) => void;
  onSearchSender?: (email: string) => void;
  onOpenFile: OpenFile;
  className?: string;
}) {
  const account = useAccounts().data?.find((a) => a.id === accountId);
  const sent = rows.filter((m) => !m.labelIds.includes("DRAFT"));
  const first = sent[0] ?? rows[0];
  const last = sent[sent.length - 1] ?? rows[rows.length - 1];
  const unread = sent.filter((m) => m.unread).length;
  const people = participants(sent, account?.email);
  const withFiles = sent.filter((m) => m.hasAttachments);

  const openInGmail = (e: MouseEvent) => {
    const user = encodeURIComponent(account?.email ?? accountId);
    openLink(`https://mail.google.com/mail/u/${user}/#all/${threadId}`, { flip: isModClick(e) });
  };

  return (
    <div
      className={cn(
        "w-64 rounded-2xl border border-foreground/10 bg-popover text-foreground shadow-[0_16px_40px_-22px_rgb(0_0_0/45%)]",
        className,
      )}
    >
      {/* Where it lives, and how long it's run. */}
      <div className="flex items-start gap-2 px-4 pb-3 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {account ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: getAccountColor(account) }}
              />
            ) : null}
            <span className="truncate">{account ? getAccountDisplayName(account) : accountId}</span>
          </div>
          <div className="mt-1 text-sm">
            {sent.length} message{sent.length === 1 ? "" : "s"}
            {unread > 0 ? <span className="text-muted-foreground"> · {unread} unread</span> : null}
          </div>
          {first && last ? (
            <div className="text-[13px] text-muted-foreground">{span(first.date, last.date)}</div>
          ) : null}
        </div>
        {/* IMAP mail has no web page to open. */}
        {account?.imap ? null : (
          <HintTooltip label="Open in Gmail">
            <button
              type="button"
              aria-label="Open in Gmail"
              onClick={openInGmail}
              className="-me-1.5 -mt-0.5 flex size-7 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <ExternalLinkIcon className="size-4" />
            </button>
          </HintTooltip>
        )}
      </div>

      {people.length > 0 ? (
        <Section title="People">
          {people.slice(0, 8).map((p) => (
            <div
              key={p.email}
              className="group/person flex h-8 items-center gap-2.5 rounded-lg px-2 hover:bg-foreground/[0.06]"
              title={p.email}
            >
              <SenderAvatar name={p.name} email={p.email} accountId={accountId} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{p.name || p.email}</span>
              {p.sent > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground group-hover/person:hidden">
                  {p.sent}
                </span>
              ) : null}
              <span className="hidden shrink-0 items-center group-hover/person:flex">
                {onComposeTo ? (
                  <PersonAction
                    label={`Write to ${p.name || p.email}`}
                    onClick={() => onComposeTo(p.email)}
                  >
                    <PenLineIcon />
                  </PersonAction>
                ) : null}
                {onSearchSender ? (
                  <PersonAction
                    label={`Mail from ${p.name || p.email}`}
                    onClick={() => onSearchSender(p.email)}
                  >
                    <SearchIcon />
                  </PersonAction>
                ) : null}
              </span>
            </div>
          ))}
          {people.length > 8 ? (
            <div className="px-2 pt-0.5 text-[13px] text-muted-foreground">
              and {people.length - 8} more
            </div>
          ) : null}
        </Section>
      ) : null}

      {withFiles.length > 0 ? (
        <Section title="Attachments">
          {withFiles.map((m) => (
            <MessageFiles
              key={m.id}
              accountId={accountId}
              messageId={m.id}
              onOpenFile={onOpenFile}
            />
          ))}
        </Section>
      ) : null}

      {/* A mailing list's way out (renders nothing for ordinary mail). */}
      {last ? (
        <div className="border-t border-foreground/10 px-4 py-2.5 text-[13px] empty:hidden">
          <UnsubscribeLink
            accountId={accountId}
            messageId={last.id}
            senderName={last.fromName}
            senderEmail={last.fromEmail}
          />
        </div>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-foreground/10 px-2 pb-2 pt-2.5">
      <div className="px-2 pb-1 text-[13px] text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function PersonAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <HintTooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground [&_svg]:size-3.5"
      >
        {children}
      </button>
    </HintTooltip>
  );
}

/** One message's files (its detail is usually cached from the reader). */
function MessageFiles({
  accountId,
  messageId,
  onOpenFile,
}: {
  accountId: string;
  messageId: string;
  onOpenFile: OpenFile;
}) {
  const detail = useMessage(accountId, messageId).data;
  // Inline images (a content id) are part of the body, not files people sent.
  const files = (detail?.attachments ?? []).filter((a) => !a.contentId);
  return files.map((a) => (
    <button
      key={a.id}
      type="button"
      title={`Open ${a.filename}`}
      onClick={() => onOpenFile(messageId, a)}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left hover:bg-foreground/[0.06]"
    >
      <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">{a.filename}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{formatSize(a.size)}</span>
    </button>
  ));
}

type Person = { name: string; email: string; sent: number; seenAt: number };

/** Everyone on the conversation but you: who wrote (most first), then who was written to. */
function participants(rows: GmailMessageSummary[], self?: string): Person[] {
  const me = self?.toLowerCase();
  const people = new Map<string, Person>();
  const add = (name: string, email: string, wrote: boolean, at: number) => {
    const key = email.trim().toLowerCase();
    if (!key.includes("@") || key === me) return;
    const person = people.get(key) ?? { name: "", email: key, sent: 0, seenAt: at };
    if (!person.name && name) person.name = name;
    if (wrote) person.sent++;
    people.set(key, person);
  };
  rows.forEach((m, i) => {
    add(m.fromName, m.fromEmail, true, i);
    for (const entry of splitAddressList(m.to)) {
      const { name, email } = parseAddressEntry(entry);
      add(name, email, false, i);
    }
  });
  return [...people.values()].sort((a, b) => b.sent - a.sent || a.seenAt - b.seenAt);
}

function span(from: number, to: number): string {
  const day = (t: number) =>
    new Date(t).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  const a = day(from);
  const b = day(to);
  return a === b ? a : `${a} – ${b}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
