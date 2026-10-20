import type { ChatChange, ProviderKind } from "./api";
import { clampTitle } from "./chat-store";
import { useAccounts, useMessage } from "./hooks";
import type { GmailMessageSummary } from "./types";

/**
 * Pointer-sized mail context for the agent chat. The agent can read the same
 * mailboxes (Claude and Codex through Otter Mail's tools, Hermes and OpenClaw with gog on
 * its server), so ids are enough — no mail content leaves the app.
 */
export type AgentContext = {
  /** Owning account email per conversation (falls back to account id). */
  conversations: {
    account: string;
    threadId: string;
    subject: string;
    from: string;
    messageIds: string[];
    /** Present when the item is a highlighted excerpt, not the whole thread. */
    quote?: string;
  }[];
  /** The project on screen, if any. */
  project?: { id: string; name: string };
};

/** A text excerpt selected from a message, plus its thread pointer. */
export type QuoteContext = {
  text: string;
  account: string;
  accountId: string;
  threadId: string;
  subject: string;
  messageId: string;
};

/** One row (or thread rep) → context entry. */
export function contextFromMessages(
  messages: GmailMessageSummary[],
  accountEmailById: (accountId: string | undefined) => string,
): AgentContext {
  return {
    conversations: messages.map((m) => ({
      account: accountEmailById(m.accountId),
      threadId: m.threadId || m.id,
      subject: m.subject || "(no subject)",
      from: m.fromEmail,
      messageIds: [m.id],
    })),
  };
}

/** A highlighted excerpt → a single quote context entry. */
export function contextFromQuote(q: QuoteContext): AgentContext {
  return {
    conversations: [
      {
        account: q.account,
        threadId: q.threadId,
        subject: q.subject,
        from: "",
        messageIds: [q.messageId],
        quote: q.text,
      },
    ],
  };
}

/** Question + pointer block sent with a chat turn. */
export function buildHandoffText(
  question: string,
  context: AgentContext,
  provider: ProviderKind,
): string {
  const lines: string[] = [question.trim(), "", "— context from Otter Mail —"];
  if (context.project) {
    lines.push(`• Project “${context.project.name}” (projectId ${context.project.id})`);
  }
  for (const c of context.conversations) {
    if (c.quote) {
      lines.push(
        `• Quoted from "${c.subject}" [${c.account}] (threadId ${c.threadId}):\n  “${c.quote}”`,
      );
    } else {
      lines.push(
        `• [${c.account}] "${c.subject}" — from ${c.from} (threadId ${c.threadId}, message ${c.messageIds.join(", ")})`,
      );
    }
  }
  lines.push(
    provider === "hermes" || provider === "openclaw"
      ? "Fetch full content with gog if needed."
      : "Read them with the otter-mail tools (get_thread) if needed.",
  );
  return lines.join("\n");
}

/** What the attached context items are, so the chip shows a fitting icon. */
export type ContextKind = "draft" | "sent" | "mail" | "mixed" | "quote" | "project";

/** The context sent with a message, as its chip recaps it. */
export type ContextMeta = {
  subjects: string[];
  count: number;
  kind: ContextKind;
  items?: { title: string; target: ChatChange["target"] }[];
};

/** Classify one message from its labels. */
function kindOf(labelIds: string[]): ContextKind {
  if (labelIds.includes("DRAFT")) return "draft";
  if (labelIds.includes("SENT")) return "sent";
  return "mail";
}

/** Collapse the selection's kinds: uniform → that kind, otherwise "mixed". */
function contextKind(labelSets: string[][]): ContextKind {
  if (labelSets.length === 0) return "mail";
  const kinds = new Set(labelSets.map(kindOf));
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

/** What a chat is about in the mail, for its composer. */
export type MailChatContext = {
  /** What goes with the next message, unless switched off; null with nothing open. */
  attached: {
    context: AgentContext;
    kind: ContextKind;
    /** The composer's chip. */
    name: string;
    detail: string;
    /** The recap the sent message keeps. */
    meta: ContextMeta;
  } | null;
  /** A highlighted excerpt: one-shot, let go once sent. */
  quote: QuoteContext | null;
  /** An empty chat's headline. */
  headline: string;
};

/**
 * The context the mail on screen gives a chat: a highlighted excerpt wins,
 * then the multi-selection, then the open conversation (cache hit — the
 * reader fetched it), with the project on screen. All pointer-only; the
 * agent reads the bodies itself.
 */
export function useMailChatContext({
  accountId,
  messageId,
  selectedRows,
  quote,
  project,
}: {
  accountId: string | null;
  messageId: string | null;
  selectedRows?: GmailMessageSummary[];
  quote?: QuoteContext | null;
  project?: { id: string; name: string } | null;
}): MailChatContext {
  const accountsQuery = useAccounts();
  const accountEmailById = (id: string | undefined) =>
    accountsQuery.data?.find((a) => a.id === id)?.email ?? id ?? "";
  const openMessage = useMessage(accountId, messageId);
  const multiSelected = selectedRows && selectedRows.length > 0;
  const mailContext: AgentContext | null = quote
    ? contextFromQuote(quote)
    : multiSelected
      ? contextFromMessages(selectedRows, accountEmailById)
      : accountId && messageId && openMessage.data
        ? {
            conversations: [
              {
                account: accountEmailById(accountId),
                threadId: openMessage.data.threadId || openMessage.data.id,
                subject: openMessage.data.subject || "(no subject)",
                from: openMessage.data.fromEmail,
                messageIds: [openMessage.data.id],
              },
            ],
          }
        : null;
  const context: AgentContext | null = project
    ? { conversations: [], ...mailContext, project }
    : mailContext;
  /** Only the project is attached (no conversation). */
  const projectOnly = Boolean(project) && !mailContext;
  // Draft / sent / mail / quote kind of what's attached, for the chip's icon.
  const kind: ContextKind = quote
    ? "quote"
    : projectOnly
      ? "project"
      : contextKind(
          multiSelected
            ? selectedRows.map((r) => r.labelIds)
            : openMessage.data
              ? [openMessage.data.labelIds]
              : [],
        );
  const headline = quote
    ? "What should we do with this excerpt?"
    : projectOnly && project
      ? `What should we do for “${clampTitle(project.name)}”?`
      : multiSelected
        ? `What should we do with these ${selectedRows.length} conversations?`
        : openMessage.data
          ? `What should we do with “${clampTitle(openMessage.data.subject || "this conversation")}”?`
          : "What should we do in your inbox?";
  if (!context) return { attached: null, quote: quote ?? null, headline };
  const conversations = context.conversations;
  return {
    attached: {
      context,
      kind,
      name: quote
        ? `“${quote.text}”`
        : projectOnly && project
          ? project.name
          : conversations.length > 1
            ? `${conversations.length} conversations`
            : conversations[0].subject || "(no subject)",
      detail: quote
        ? "Quote"
        : projectOnly
          ? "Project"
          : conversations.length > 1
            ? conversations
                .slice(0, 3)
                .map((c) => c.subject || "(no subject)")
                .join(" · ")
            : conversations[0].from,
      meta: {
        count: conversations.length || 1,
        subjects: quote
          ? [quote.text]
          : projectOnly && context.project
            ? [context.project.name]
            : conversations.map((x) => x.subject),
        kind,
        items: [
          ...(context.project
            ? [
                {
                  title: context.project.name,
                  target: { kind: "project" as const, id: context.project.id },
                },
              ]
            : []),
          ...conversations.map((conversation) => ({
            title: conversation.subject,
            target: {
              kind: "thread" as const,
              id: conversation.threadId,
              accountId:
                accountsQuery.data?.find((a) => a.email === conversation.account)?.id ??
                conversation.account,
            },
          })),
        ],
      },
    },
    quote: quote ?? null,
    headline,
  };
}
