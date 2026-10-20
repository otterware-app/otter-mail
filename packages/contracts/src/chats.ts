/**
 * Agent chats, synced through the Otter account to every device: each chat
 * (the provider it runs on, its session there), its transcript as the app
 * shows it, and the tabs it opened beside it in the AI workspace. A chat is
 * one document and the latest write wins: devices keep their chats in
 * chats.json (core's services/chats.ts) and write each change to the relay
 * (`/v1/chats`, below), which tells the account's other devices.
 *
 * Claude and Codex run on one computer: their chats read the same everywhere
 * but continue only on the `device` they ran on.
 */

import type { ChatChange } from "./index.js";

export type ChatProvider = "hermes" | "openclaw" | "openrouter" | "codex" | "claude";

/** Providers whose sessions live on the computer that ran them. */
export const LOCAL_CHAT_PROVIDERS: readonly ChatProvider[] = ["claude", "codex"];

/** A step an agent took: what it did, in words, and its input. */
export interface ChatStep {
  kind: "command" | "read" | "edit" | "search" | "web" | "skill" | "tool";
  title: string;
  detail?: string;
  /** The integration (MCP server) it came from. */
  source?: string;
}

/** An agent turn's content in order: what it said, and the steps it took. */
export type ChatTurnItem =
  | { kind: "text"; id?: string; text: string }
  | { kind: "step"; id?: string; step: ChatStep; output?: string };

/** What the attached context items are, so the chip shows a fitting icon. */
export type ChatContextKind = "draft" | "sent" | "mail" | "mixed" | "quote";

/** The mail sent with a message, as its chip recaps it. */
export interface ChatContextMeta {
  subjects: string[];
  count: number;
  kind: ChatContextKind;
  items?: { title: string; target: ChatChange["target"] }[];
}

/** A file sent with a message (a thumbnail for images, on the device that sent it). */
export interface ChatSentAttachment {
  name: string;
  kind: "image" | "file";
  size: number;
  thumb?: string;
}

/** One transcript entry. */
export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  /** The user's message. */
  text: string;
  /** Agent turns: what the agent said and the steps it took, in order. */
  items?: ChatTurnItem[];
  /** Confirmed results of this turn, shown underneath its reply. */
  changes?: ChatChange[];
  /** Attached mail context, shown as a chip above the user's message. */
  context?: ChatContextMeta;
  /** Invoked skill, rendered as a badge on the user's message. */
  skill?: string;
  /** How a user message was delivered (Otter Code's inputIntent marker). */
  intent?: "queued" | "steer" | "promoted";
  attachments?: ChatSentAttachment[];
  /** Passages of earlier replies the message quotes, with their comments. */
  citations?: { text: string; comment?: string }[];
  error?: string;
  /** Agent turns: when the run started / settled, for the "Worked for" fold. */
  startedAt?: number;
  finishedAt?: number;
}

/**
 * What a workspace tab shows. Mail is named by its account (an email
 * address, the same on every device); a page by its address; a file by its
 * link in the chat, read back through the chat's agent.
 */
export type ChatTabRef =
  | { kind: "thread"; accountId: string; id: string }
  | { kind: "draft"; accountId: string; id: string }
  | { kind: "page"; url: string }
  | { kind: "file"; href: string };

/** Something the chat used, made or opened: a tab beside it in the workspace. */
export interface ChatTab {
  /** Stable for what it shows (`chatTabId`), so opening it again finds the tab. */
  id: string;
  title: string;
  ref: ChatTabRef;
  addedAt: number;
}

export interface Chat {
  id: string;
  title: string;
  provider: ChatProvider;
  /** The provider's session (Hermes session, Codex thread, OpenRouter session…). */
  sessionId: string | null;
  /** Started by Otter Mail: deleting the chat deletes the session. */
  sessionOwned: boolean;
  /** Hermes without sessions chains turns through the Responses API. */
  lastResponseId: string | null;
  /** Claude and Codex chats: the computer they ran on, the only one to continue them. */
  device: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
  tabs: ChatTab[];
  turns: ChatTurn[];
}

/** A chat without its transcript, as the relay lists them. Deleted ones keep their id and time. */
export type ChatSummary = Omit<Chat, "turns"> & { deletedAt: number | null };

/** The tab id for what a ref shows. */
export function chatTabId(ref: ChatTabRef): string {
  switch (ref.kind) {
    case "thread":
    case "draft":
      return `${ref.kind}:${ref.accountId}:${ref.id}`;
    case "page":
      return `page:${ref.url}`;
    case "file":
      return `file:${ref.href}`;
  }
}

export const CHAT_LIMITS = {
  chats: 500,
  turns: 80,
  tabs: 50,
  title: 300,
  /** A step's output, as other devices see it. */
  output: 4000,
  /** A chat as the relay keeps it (JSON). */
  bytes: 500_000,
} as const;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * A chat as it's written to the relay: its latest turns and tabs, steps'
 * outputs clipped and image thumbnails left on the device that sent them,
 * and older turns dropped until it fits.
 */
export function chatForSync(chat: Chat): Chat {
  const turns = chat.turns.slice(-CHAT_LIMITS.turns).map((turn) => ({
    ...turn,
    items: turn.items?.map((item) =>
      item.kind === "step" && item.output !== undefined
        ? { ...item, output: clip(item.output, CHAT_LIMITS.output) }
        : item,
    ),
    attachments: turn.attachments?.map(({ thumb: _thumb, ...rest }) => rest),
  }));
  const synced = {
    ...chat,
    title: clip(chat.title, CHAT_LIMITS.title),
    tabs: chat.tabs.slice(-CHAT_LIMITS.tabs),
    turns,
  };
  while (synced.turns.length > 1 && JSON.stringify(synced).length > CHAT_LIMITS.bytes) {
    synced.turns = synced.turns.slice(Math.ceil(synced.turns.length / 4));
  }
  return synced;
}

// ── Relay API ────────────────────────────────────────────────────────────────
//
// All need the Otter account's session.
//
//   GET    /v1/chats      → ListChatsResponse (deleted ones too, without turns)
//   GET    /v1/chats/:id  → { chat: Chat } (404 once deleted)
//   PUT    /v1/chats/:id  ← Chat (chatForSync'd) → 204; 409 when the relay
//                           has a later write (pull it); 413 too big
//   DELETE /v1/chats/:id  → 204
//
// A change reaches the account's other devices as the realtime event
// `{ type: "chats" }` (relay.ts).

export interface ListChatsResponse {
  chats: ChatSummary[];
}
