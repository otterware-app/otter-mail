import type { ProviderKind } from "./api";
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
