/**
 * The agent chats, shared by every view that shows one: the saved chats and
 * the ones open as tabs, the turns in flight and what they wait on, the
 * follow-ups queued behind them, and each chat's unsent draft and citations.
 * Each chat is bound to the provider it started with; turns stream through
 * the backend's provider layer as canonical chat events, which
 * `useChatEvents` (the main window's) lays into their chat whether or not a
 * view shows it. The chats are saved on this device, for instant paint.
 */

import { useEffect } from "react";
import { create } from "zustand";

import { useBrowser } from "../browser/store";
import { features } from "../features";
import { isProviderUsable } from "./agent-providers";
import {
  gmailApi,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatAttachment,
  type ChatChange,
  type ChatEvent,
  type ChatQuestion,
  type ChatSession,
  type ChatSessionMessage,
  type ProviderKind,
  type ProviderSnapshot,
  type Skill,
} from "./api";
import type { SentAttachment } from "./chat-attachments";
import { mergeChatChanges } from "./chat-changes";
import type { Citation } from "./chat-cite";
import type { ContextMeta } from "./chat-context";
import type { FollowUpBehavior } from "./chat-queue";
import { toast } from "./toast";
import type { TurnItem } from "./work-log";

/** One transcript entry. */
export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  /** The user's message. */
  text: string;
  /** Agent turns: what the agent said and the steps it took, in order. */
  items?: TurnItem[];
  /** Confirmed results of this turn, shown underneath its reply. */
  changes?: ChatChange[];
  /** Attached mail context, shown as a chip above the user's message. */
  context?: ContextMeta;
  /** Invoked skill, rendered as a badge on the user's message. */
  skill?: string;
  /** How a user message was delivered (Otter Code's inputIntent marker). */
  intent?: "queued" | "steer" | "promoted";
  /** Files sent with a user message (thumbnails for images). */
  attachments?: SentAttachment[];
  /** Passages of earlier replies the user message quotes, with their comments. */
  citations?: Omit<Citation, "id">[];
  error?: string;
  /** Agent turns: when the run started / settled, for the "Worked for" fold. */
  startedAt?: number;
  finishedAt?: number;
};

/**
 * A saved chat, bound to the provider it started with. `sessionId` is the
 * provider-side session (Hermes session / Codex thread); Hermes chats on a
 * server without sessions have none and chain via `lastResponseId` (Responses API).
 */
export type Conversation = {
  id: string;
  title: string;
  turns: ChatTurn[];
  provider: ProviderKind;
  sessionId: string | null;
  /** Created by this app (deleting the chat deletes the session) vs. opened from the provider. */
  sessionOwned: boolean;
  lastResponseId: string | null;
  /**
   * The turn in flight (its request id), saved so one the app quits during is
   * picked up again on the next launch, where the provider's runs outlive it.
   */
  openRequest?: string | null;
  updatedAt: number;
};

/** A turn in flight, bound to its conversation (several chats can run at once). */
export type Run = { requestId: string; convoId: string; provider: ProviderKind };

/** A composed message, before it becomes a turn (or a steer). */
export type Outgoing = {
  id: string;
  convoId: string;
  /** Who it was written for: an empty chat takes the provider the picker shows. */
  provider: ProviderKind;
  question: string;
  /** What the agent receives (question + attached context block). */
  input: string;
  skill?: Skill;
  title: string;
  context?: ContextMeta;
  attachments?: ChatAttachment[];
  sent?: SentAttachment[];
  citations?: Citation[];
};

/**
 * A follow-up waiting for the running turn (Otter Code's queued run). It has
 * no transcript row until it starts; it lives in the queue banner. In memory
 * only: a queued message is a live intent, not a draft worth persisting.
 */
export type QueuedMessage = Outgoing;

type ChatsState = {
  conversations: Conversation[];
  /** The chat showing; "" while the panel holds only browser pages. */
  activeId: string;
  /** Open chats, in strip order; empty while only browser tabs remain. */
  tabs: string[];
  /** Turns in flight, by chat: each streams into its own chat, so tabs work in parallel. */
  runs: Record<string, Run>;
  /** Background chats whose turn finished since you last looked at them. */
  unseen: ReadonlySet<string>;
  /** Approvals the running turns wait on (oldest first). */
  approvals: { requestId: string; approval: ApprovalRequest }[];
  /** Questions the running turns ask (OpenClaw's ask_user), oldest first. */
  questions: { requestId: string; question: ChatQuestion }[];
  queue: QueuedMessage[];
  /** The queued message the composer is editing: it waits until the edit ends. */
  editingQueued: string | null;
  /** The chat whose transcript is being pulled from its provider. */
  hydrating: string | null;
  /** Each chat's unsent message. */
  drafts: Record<string, string>;
  /** Passages cited from replies into each chat's next message. */
  citations: Record<string, Citation[]>;
};

const STORE_KEY = "gmail:hermes-chat:v2";
const MAX_STORED_TURNS = 80;
const MAX_CONVERSATIONS = 40;

export function clampTitle(text: string): string {
  const t = text.trim();
  if (!t) return "New chat";
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function newConversation(provider: ProviderKind = "openrouter"): Conversation {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    turns: [],
    provider,
    sessionId: null,
    sessionOwned: false,
    lastResponseId: null,
    updatedAt: Date.now(),
  };
}

/** Hydrated user turns show the question, not the context block sent with it. */
function stripHandoff(text: string): string {
  const cut = text.indexOf("\n\n— context from Otter Mail —");
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * Rebuilds transcript turns from a session's stored messages: what the agent
 * said and did between two user messages is one agent turn, in order, as a
 * live stream renders it.
 */
function turnsFromMessages(messages: ChatSessionMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let open: ChatTurn | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === "user") {
      open = null;
      turns.push({ id: `h-${i}`, role: "user", text: stripHandoff(m.text) });
    } else if (m.role === "assistant") {
      if (!open) {
        open = { id: `h-${i}`, role: "assistant", text: "", items: [] };
        turns.push(open);
      }
      // Everything the agent says and does until the user's next message is one turn.
      if (m.text) open.items!.push({ kind: "text", text: m.text });
      for (const step of m.toolCalls ?? []) open.items!.push({ kind: "step", step });
    } else if (m.role === "tool" && open) {
      const pending = open.items!.find((t) => t.kind === "step" && t.output === undefined);
      if (pending?.kind === "step") pending.output = m.text || "(done)";
    }
  }
  return turns.filter((t) => t.role === "user" || (t.items?.length ?? 0) > 0);
}

/**
 * A run's turns as the provider recorded them, after the message that
 * started it (`u-<requestId>`): the agent turns take the record's items one
 * for one when the steers line up; else the record replaces them, steers and
 * all. It ends on an agent turn, for the rest of the run to stream into.
 */
function withTranscript(
  turns: ChatTurn[],
  requestId: string,
  messages: ChatSessionMessage[],
): ChatTurn[] {
  let at = turns.findIndex((t) => t.id === `u-${requestId}`);
  if (at < 0) at = turns.findLastIndex((t) => t.role === "user");
  const local = turns.slice(at + 1);
  const recorded = turnsFromMessages(messages);
  const startedAt = local.find((t) => t.role === "assistant")?.startedAt;
  let next: ChatTurn[];
  if (recorded.length === local.length && recorded.every((t, i) => t.role === local[i].role)) {
    next = local.map((t, i) =>
      t.role === "assistant"
        ? { ...t, text: "", items: recorded[i].items, error: undefined, finishedAt: undefined }
        : t,
    );
  } else {
    next = recorded.map((t, i) => (i === 0 && t.role === "assistant" ? { ...t, startedAt } : t));
  }
  if (next[next.length - 1]?.role !== "assistant")
    next.push({ id: `a-${requestId}-rest`, role: "assistant", text: "", items: [], startedAt });
  return [...turns.slice(0, at + 1), ...next];
}

/** Canonical error codes from the backend → what the transcript says. */
function friendlyError(code: string, provider: ProviderKind): string {
  const name =
    provider === "openrouter"
      ? "OpenRouter"
      : provider === "codex"
        ? "Codex"
        : provider === "claude"
          ? "Claude"
          : provider === "openclaw"
            ? "OpenClaw"
            : "Hermes";
  switch (code) {
    case "not_configured":
      return `${name} isn't set up — connect it in Settings → Agents.`;
    case "not_installed":
      return "The Codex CLI wasn't found — check it in Settings → Agents.";
    case "provider_disabled":
      return `${name} is turned off in Settings → Agents.`;
    case "unauthorized":
      return "The API key was rejected — update it in Settings.";
    case "unreachable":
      if (provider === "openrouter") return "Can't reach OpenRouter. Try again in a moment.";
      if (provider === "openclaw")
        return "Can't reach the OpenClaw gateway — are you on Tailscale?";
      return provider === "codex"
        ? "Lost the connection to Codex — send again to retry."
        : "Can't reach Hermes — are you on Tailscale?";
    case "timeout":
      return `${name} went quiet for too long — the run was stopped.`;
    case "cancelled":
      return "Stopped.";
    case "pairing_required":
      return "Approve this device on the OpenClaw gateway — the command is in Settings → Agents.";
    case "origin_not_allowed":
      return "The OpenClaw gateway doesn't allow this site yet — see Settings → Agents.";
    case "session_not_found":
      return `This chat's ${name} session no longer exists — send again to start a new one.`;
    case "not_received":
      return `${name} never got this message — send it again.`;
    default:
      return code.startsWith("agent_error: ")
        ? code.slice("agent_error: ".length)
        : `${name} answered with an error (${code}).`;
  }
}

type Saved = Pick<ChatsState, "conversations" | "activeId" | "tabs">;

function loadStore(): Saved {
  let conversations: Conversation[] = [];
  let activeId: string | null = null;
  let tabs: string[] = [];
  try {
    const v2 = JSON.parse(localStorage.getItem(STORE_KEY) ?? "") as Partial<Saved>;
    if (Array.isArray(v2.conversations)) {
      conversations = v2.conversations.map((c) => ({
        ...c,
        // A turn can only be picked up again in the session it was sent to.
        openRequest: c.sessionId ? (c.openRequest ?? null) : null,
      }));
      activeId = v2.activeId ?? null;
      tabs = Array.isArray(v2.tabs) ? v2.tabs : [];
    }
  } catch {
    // nothing saved yet
  }
  // Only non-empty sessions are kept. A panel with only pages needs no chat.
  conversations = conversations.filter((c) => c.turns.length > 0);
  if (activeId === "" && tabs.length === 0 && features.browser && useBrowser.getState().tabs.length)
    return { conversations, activeId, tabs };
  if (!activeId || !conversations.some((c) => c.id === activeId)) {
    const fresh = newConversation();
    conversations = [fresh, ...conversations];
    activeId = fresh.id;
  }
  tabs = tabs.filter((id) => conversations.some((c) => c.id === id));
  if (!tabs.includes(activeId)) tabs = [...tabs, activeId];
  return { conversations, activeId, tabs };
}

export const useChats = create<ChatsState>(() => ({
  ...loadStore(),
  runs: {},
  unseen: new Set(),
  approvals: [],
  questions: [],
  queue: [],
  editingQueued: null,
  hydrating: null,
  drafts: {},
  citations: {},
}));

useChats.subscribe((state, prev) => {
  if (
    state.conversations === prev.conversations &&
    state.activeId === prev.activeId &&
    state.tabs === prev.tabs
  )
    return;
  const conversations = state.conversations
    .slice(0, MAX_CONVERSATIONS)
    .map((c) => ({ ...c, turns: c.turns.slice(-MAX_STORED_TURNS) }));
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ conversations, activeId: state.activeId, tabs: state.tabs }),
  );
});

const { getState: get, setState: set } = useChats;

function patchConversation(id: string, fn: (c: Conversation) => Conversation): void {
  set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)) }));
}

/** Empty chats that aren't open anywhere are dropped (no litter). */
function pruned(conversations: Conversation[], tabs: string[]): Conversation[] {
  return conversations.filter((c) => c.turns.length > 0 || tabs.includes(c.id));
}

function endRun(requestId: string): void {
  const entry = Object.values(get().runs).find((r) => r.requestId === requestId);
  if (!entry) return;
  set((s) => {
    const runs = { ...s.runs };
    delete runs[entry.convoId];
    return { runs };
  });
  startQueued();
}

/**
 * A chat's queued message starts once no turn is running in it (after
 * completion, an error, or Stop) — never at a tool boundary; that's what
 * Steer is for. Each chat drains its own queue.
 */
function startQueued(): void {
  for (;;) {
    const { queue, runs, editingQueued } = get();
    const next = queue.find((m) => !runs[m.convoId] && m.id !== editingQueued);
    if (!next) return;
    set({ queue: queue.filter((m) => m.id !== next.id) });
    startTurn(next, "queued");
  }
}

/** The user bubble + an empty agent turn that the stream fills in. */
function appendExchange(
  convoId: string,
  msg: Outgoing,
  requestKey: string,
  intent?: ChatTurn["intent"],
): void {
  patchConversation(convoId, (c) => ({
    ...c,
    updatedAt: Date.now(),
    turns: [
      // A steer closes the running turn's fold; the stream continues below.
      ...c.turns.map((t, i) =>
        i === c.turns.length - 1 && t.role === "assistant" && !t.finishedAt
          ? { ...t, finishedAt: Date.now() }
          : t,
      ),
      {
        id: `u-${requestKey}`,
        role: "user",
        text: msg.question,
        skill: msg.skill?.name,
        context: msg.context,
        attachments: msg.sent,
        citations: msg.citations?.map(({ text, comment }) => ({ text, comment })),
        intent,
      },
      {
        id: `a-${requestKey}`,
        role: "assistant",
        text: "",
        items: [],
        startedAt: Date.now(),
      },
    ],
  }));
}

/** Starts a new turn in the message's conversation. */
function startTurn(msg: Outgoing, intent?: ChatTurn["intent"]): void {
  const convo = get().conversations.find((c) => c.id === msg.convoId);
  if (!convo) return;
  const requestId = crypto.randomUUID();
  const firstTurn = convo.turns.length === 0;
  const kind = firstTurn ? msg.provider : convo.provider;
  console.log("[AgentChat:send]", {
    requestId,
    provider: kind,
    attached: Boolean(msg.context),
    skill: msg.skill?.name,
    session: convo.sessionId ?? "new",
  });
  // The run first: a chat with an open request and no run is one to resume.
  set((s) => ({
    runs: { ...s.runs, [msg.convoId]: { requestId, convoId: msg.convoId, provider: kind } },
  }));
  patchConversation(msg.convoId, (c) => ({
    ...c,
    // The first turn pins the chat to the provider it was sent with.
    provider: firstTurn ? kind : c.provider,
    title: firstTurn ? msg.title : c.title,
    openRequest: requestId,
  }));
  appendExchange(msg.convoId, msg, requestId, intent);
  // Returns at once; the turn streams as chat events (incl. the new session id).
  gmailApi
    .agentSend({
      provider: kind,
      requestId,
      input: msg.input,
      sessionId: convo.sessionId ?? undefined,
      title: firstTurn ? msg.title : undefined,
      skill: msg.skill ? { name: msg.skill.name, path: msg.skill.path } : undefined,
      attachments: msg.attachments,
      previousResponseId: convo.sessionId ? undefined : (convo.lastResponseId ?? undefined),
    })
    .catch((error: unknown) => {
      console.log("[AgentChat:send] failed", { error: String(error) });
      patchConversation(msg.convoId, (c) => ({
        ...c,
        turns: c.turns.map((t) =>
          t.id === `a-${requestId}`
            ? { ...t, error: friendlyError("unreachable", kind), finishedAt: Date.now() }
            : t,
        ),
        openRequest: null,
      }));
      endRun(requestId);
    });
}

/**
 * Steers the message into the running turn (Codex turn/steer, Claude's live
 * prompt, Hermes' run steer). Refused → it goes (back) to the queue.
 */
function steer(msg: Outgoing, intent: "steer" | "promoted" = "steer"): void {
  const target = get().runs[msg.convoId];
  if (!target) return startTurn(msg);
  console.log("[AgentChat:steer]", { provider: target.provider, intent });
  const key = `${target.requestId}-${msg.id}`;
  appendExchange(msg.convoId, msg, key, intent);
  const refused = () => {
    // Removes the optimistic exchange.
    patchConversation(msg.convoId, (c) => ({
      ...c,
      turns: c.turns.filter((t) => t.id !== `u-${key}` && t.id !== `a-${key}`),
    }));
    set((s) => ({ queue: [msg, ...s.queue] }));
    startQueued();
  };
  gmailApi
    .agentSteer(target.provider, target.requestId, msg.input)
    .then(({ accepted }) => !accepted && refused(), refused);
}

/**
 * Otter Code's dispatch modes: idle → start; running → queue or steer per
 * `followUp`. Steering sends text only; a message with files waits for its
 * own turn.
 */
export function sendMessage(msg: Outgoing, followUp: FollowUpBehavior): void {
  if (!get().runs[msg.convoId]) return startTurn(msg);
  if (followUp === "queue" || msg.attachments) set((s) => ({ queue: [...s.queue, msg] }));
  else steer(msg);
}

/** Promote a queued message to steer the active run (Otter Code's "Steer"). */
export function steerQueued(id: string): void {
  const msg = get().queue.find((m) => m.id === id);
  if (!msg || !get().runs[msg.convoId]) return;
  set((s) => ({ queue: s.queue.filter((m) => m.id !== id) }));
  steer(msg, "promoted");
}

/** Drag / arrow-key reorder: move `id` before `beforeId` (null = to the end). */
export function moveQueued(id: string, beforeId: string | null): void {
  set((s) => {
    const moving = s.queue.find((m) => m.id === id);
    if (!moving || id === beforeId) return s;
    const rest = s.queue.filter((m) => m.id !== id);
    const at = beforeId === null ? rest.length : rest.findIndex((m) => m.id === beforeId);
    return at < 0 ? s : { queue: [...rest.slice(0, at), moving, ...rest.slice(at)] };
  });
}

export function removeQueued(id: string): void {
  set((s) => ({ queue: s.queue.filter((m) => m.id !== id) }));
}

/** A queued message's new text; the attached context block stays below it. */
export function updateQueued(id: string, text: string): void {
  set((s) => ({
    queue: s.queue.map((m) =>
      m.id === id
        ? {
            ...m,
            question: text,
            input:
              m.input === m.question
                ? text
                : m.question
                  ? m.input.replace(m.question, text)
                  : `${text}\n\n${m.input}`,
            title: clampTitle(text),
          }
        : m,
    ),
  }));
}

export function setEditingQueued(id: string | null): void {
  if (get().editingQueued === id) return;
  set({ editingQueued: id });
  startQueued();
}

/** Interrupts the chat's run; the queue stays and its next message starts (Otter Code). */
export function stopRun(convoId: string): void {
  const run = get().runs[convoId];
  if (run) void gmailApi.agentCancel(run.provider, run.requestId);
}

export async function respondApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const { approvals, runs } = get();
  const pending = approvals.find((a) => a.approval.id === approvalId);
  const owner = pending && Object.values(runs).find((r) => r.requestId === pending.requestId);
  if (!owner) return;
  const { provider: kind, requestId } = owner;
  console.log("[AgentChat:approval]", { kind, decision });
  try {
    await gmailApi.agentRespondApproval({ provider: kind, requestId, approvalId, decision });
    set((s) => ({ approvals: s.approvals.filter((a) => a.approval.id !== approvalId) }));
  } catch (error) {
    console.log("[AgentChat:approval] failed", { error: String(error) });
  }
}

/** Answers the question the run asked (null skips it); the run goes on with the answer. */
export async function answerQuestion(
  questionId: string,
  answers: Record<string, string[]> | null,
): Promise<void> {
  const { questions, runs } = get();
  const pending = questions.find((q) => q.question.id === questionId);
  const owner = pending && Object.values(runs).find((r) => r.requestId === pending.requestId);
  if (!owner) return;
  console.log("[AgentChat:question]", { kind: owner.provider, skipped: answers === null });
  try {
    await gmailApi.agentAnswerQuestion({
      provider: owner.provider,
      requestId: owner.requestId,
      questionId,
      answers,
    });
    set((s) => ({ questions: s.questions.filter((q) => q.question.id !== questionId) }));
  } catch (error) {
    console.log("[AgentChat:question] failed", { error: String(error) });
    toast.error("Couldn't send the answer", {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

export function setDraft(convoId: string, text: string): void {
  set((s) => ({ drafts: { ...s.drafts, [convoId]: text } }));
}

export function setCitations(convoId: string, update: (list: Citation[]) => Citation[]): void {
  set((s) => ({ citations: { ...s.citations, [convoId]: update(s.citations[convoId] ?? []) } }));
}

/**
 * A fresh chat, in a new tab beside the current one. An already-empty active
 * chat is kept instead (no empty duplicates) unless `reuseEmpty` is false.
 */
export function newChat(provider: ProviderKind, reuseEmpty = true): void {
  const { conversations, activeId } = get();
  const active = conversations.find((c) => c.id === activeId);
  if (reuseEmpty && active && active.turns.length === 0) return;
  console.log("[AgentChat:newChat]");
  const fresh = newConversation(provider);
  set((s) => {
    const at = s.tabs.indexOf(s.activeId);
    const tabs = [...s.tabs.slice(0, at + 1), fresh.id, ...s.tabs.slice(at + 1)];
    return { conversations: pruned([fresh, ...s.conversations], tabs), activeId: fresh.id, tabs };
  });
}

/** The panel's last page closed with no chat open: a fresh chat takes its place. */
export function ensureChat(): void {
  if (get().tabs.length > 0) return;
  const fresh = newConversation();
  set((s) => ({
    conversations: [fresh, ...s.conversations],
    activeId: fresh.id,
    tabs: [fresh.id],
  }));
}

/** Shows a chat: its tab if open, else a new tab. */
export function switchTo(id: string): void {
  set((s) => {
    // Opens in a new tab beside the current one (an empty "New chat" tab
    // is simply reused).
    const at = s.tabs.indexOf(s.activeId);
    const current = s.conversations.find((c) => c.id === s.activeId);
    const tabs = s.tabs.includes(id)
      ? s.tabs
      : current && current.turns.length === 0 && !s.runs[s.activeId]
        ? s.tabs.map((t) => (t === s.activeId ? id : t))
        : [...s.tabs.slice(0, at + 1), id, ...s.tabs.slice(at + 1)];
    const unseen = new Set(s.unseen);
    unseen.delete(id);
    return { conversations: pruned(s.conversations, tabs), activeId: id, tabs, unseen };
  });
}

/**
 * Closes a chat's tab; it stays in history (a running turn finishes there).
 * With no page open either, the last chat gives way to a fresh one.
 */
export function closeChat(id: string, provider: ProviderKind, { pagesOpen = false } = {}): void {
  set((s) => {
    if (s.tabs.length < 2 && !pagesOpen) {
      const current = s.conversations.find((c) => c.id === id);
      if (!current || current.turns.length === 0) return s;
      const fresh = newConversation(provider);
      return {
        conversations: pruned([fresh, ...s.conversations], [fresh.id]),
        activeId: fresh.id,
        tabs: [fresh.id],
      };
    }
    const at = s.tabs.indexOf(id);
    const tabs = s.tabs.filter((t) => t !== id);
    const activeId = s.activeId === id ? (tabs[Math.max(0, at - 1)] ?? "") : s.activeId;
    return { conversations: pruned(s.conversations, tabs), activeId, tabs };
  });
}

export function deleteConversation(id: string, provider: ProviderKind): void {
  const running = get().runs[id];
  if (running) {
    void gmailApi.agentCancel(running.provider, running.requestId);
    endRun(running.requestId);
  }
  // Sessions this app created go with the chat; ones opened from the provider only unlink.
  const target = get().conversations.find((c) => c.id === id);
  if (target?.sessionId && target.sessionOwned) {
    void gmailApi.agentDeleteSession(target.provider, target.sessionId).catch(() => {});
  }
  set((s) => {
    const remaining = s.conversations.filter((c) => c.id !== id);
    const openTabs = s.tabs.filter((t) => t !== id);
    if (s.activeId !== id) return { conversations: remaining, tabs: openTabs };
    // The deleted chat was showing: its neighbour tab, else the latest chat.
    const at = s.tabs.indexOf(id);
    if (openTabs.length > 0)
      return {
        conversations: remaining,
        activeId: openTabs[Math.max(0, at - 1)],
        tabs: openTabs,
      };
    const latest = remaining.find((c) => c.turns.length > 0);
    if (latest) return { conversations: remaining, activeId: latest.id, tabs: [latest.id] };
    const fresh = newConversation(provider);
    return { conversations: [fresh, ...remaining], activeId: fresh.id, tabs: [fresh.id] };
  });
}

/** Resumes a session persisted on the provider (e.g. started in Hermes' WebUI) as a chat. */
export function openServerSession(
  session: ChatSession,
  provider: ProviderKind,
  providerName: string,
): void {
  const existing = get().conversations.find(
    (c) => c.sessionId === session.id && c.provider === provider,
  );
  if (existing) {
    switchTo(existing.id);
    return;
  }
  console.log("[AgentChat:openServerSession]", {
    provider,
    sessionId: session.id,
    source: session.source,
  });
  const convo: Conversation = {
    id: crypto.randomUUID(),
    title: clampTitle(session.title || session.preview || `${providerName} session`),
    turns: [],
    provider,
    sessionId: session.id,
    sessionOwned: false,
    lastResponseId: null,
    updatedAt: session.lastActive,
  };
  set((s) => {
    // A new tab, like any chat opened from history (an empty tab is reused).
    const at = s.tabs.indexOf(s.activeId);
    const current = s.conversations.find((c) => c.id === s.activeId);
    const tabs =
      current && current.turns.length === 0 && !s.runs[s.activeId]
        ? s.tabs.map((t) => (t === s.activeId ? convo.id : t))
        : [...s.tabs.slice(0, at + 1), convo.id, ...s.tabs.slice(at + 1)];
    return {
      conversations: pruned([convo, ...s.conversations], tabs),
      activeId: convo.id,
      tabs,
      hydrating: convo.id,
    };
  });
  gmailApi
    .agentSessionMessages(provider, session.id)
    .then(
      (messages) => {
        const hydrated = turnsFromMessages(messages);
        patchConversation(convo.id, (c) =>
          c.turns.length > 0 ? c : { ...c, turns: hydrated, updatedAt: Date.now() },
        );
      },
      (error) => console.log("[AgentChat:hydrate] failed", { error: String(error) }),
    )
    .finally(() => set((s) => (s.hydrating === convo.id ? { hydrating: null } : s)));
}

const resumeTried = new Map<string, ProviderSnapshot>();

/**
 * A turn the app quit during (or lost the connection in) is picked up
 * again: the provider shows how far its run got, then streams the rest.
 * Tried once per provider state, so a gateway that comes back retries it.
 */
export function resumeRuns(providers: ProviderSnapshot[]): void {
  for (const c of get().conversations) {
    const requestId = c.openRequest;
    const host = providers.find((p) => p.kind === c.provider);
    if (!requestId || !c.sessionId || get().runs[c.id] || !host || !isProviderUsable(host))
      continue;
    if (resumeTried.get(requestId) === host) continue;
    resumeTried.set(requestId, host);
    console.log("[AgentChat:resume]", { provider: c.provider, requestId });
    set((s) => ({
      runs: { ...s.runs, [c.id]: { requestId, convoId: c.id, provider: c.provider } },
    }));
    const giveUp = () => {
      patchConversation(c.id, (current) =>
        current.openRequest === requestId ? { ...current, openRequest: null } : current,
      );
      endRun(requestId);
    };
    gmailApi.agentResume({ provider: c.provider, requestId, sessionId: c.sessionId }).then(
      ({ resumed }) => {
        if (!resumed) giveUp();
      },
      (error) => {
        console.log("[AgentChat:resume] failed", { error: String(error) });
        endRun(requestId);
      },
    );
  }
}

/** A stream event, laid into the chat whose run it belongs to (not necessarily the one showing). */
function onChatEvent(raw: unknown): void {
  const event = raw as ChatEvent;
  const s = event
    ? Object.values(get().runs).find((r) => r.requestId === event.requestId)
    : undefined;
  if (!event || !s) return;
  // Approvals live beside the transcript, not in it.
  if (event.type === "approval") {
    set((st) => ({
      approvals: [...st.approvals, { requestId: event.requestId, approval: event.approval }],
    }));
    return;
  }
  if (event.type === "approvalResolved") {
    set((st) => ({ approvals: st.approvals.filter((a) => a.approval.id !== event.approvalId) }));
    return;
  }
  if (event.type === "question") {
    set((st) => ({
      questions: [
        ...st.questions.filter((q) => q.question.id !== event.question.id),
        { requestId: event.requestId, question: event.question },
      ],
    }));
    return;
  }
  if (event.type === "questionResolved") {
    set((st) => ({ questions: st.questions.filter((q) => q.question.id !== event.questionId) }));
    return;
  }
  if (event.type === "done" || event.type === "error") {
    set((st) => ({
      approvals: st.approvals.filter((a) => a.requestId !== event.requestId),
      questions: st.questions.filter((q) => q.requestId !== event.requestId),
    }));
  }
  // The app let go of a run that goes on at the provider (it quit, or the
  // connection's gone): the turn waits, as it is, to be picked up again.
  if (event.type === "error" && event.message === "detached") {
    endRun(event.requestId);
    return;
  }
  if (event.type === "transcript") {
    patchConversation(s.convoId, (c) => ({
      ...c,
      turns: withTranscript(c.turns, event.requestId, event.messages),
      updatedAt: Date.now(),
    }));
    return;
  }
  patchConversation(s.convoId, (c) => {
    // The provider opened a session for this chat: bind it for the next turns.
    if (event.type === "session") return { ...c, sessionId: event.sessionId, sessionOwned: true };
    const nextTurns = [...c.turns];
    const turn = nextTurns[nextTurns.length - 1];
    if (!turn || turn.role !== "assistant") return c;
    const items = [...(turn.items ?? [])];
    const updated: ChatTurn = { ...turn, items };
    const last = items[items.length - 1];
    if (event.type === "change") {
      updated.changes = mergeChatChanges([...(turn.changes ?? []), event.change]);
    } else if (event.type === "delta" || event.type === "text") {
      // Text continues the text before it; after a step it starts anew.
      const index = event.id
        ? items.findIndex((item) => item.kind === "text" && item.id === event.id)
        : last?.kind === "text"
          ? items.length - 1
          : -1;
      const previous = items[index];
      if (previous?.kind === "text")
        items[index] = {
          ...previous,
          text: event.type === "text" ? event.text : previous.text + event.text,
        };
      else items.push({ kind: "text", id: event.id, text: event.text });
    } else if (event.type === "tool") {
      items.push({ kind: "step", id: event.id, step: event.step });
    } else if (event.type === "toolResult") {
      // Its step by id; else the latest one still running.
      const index = items.findLastIndex(
        (t) =>
          t.kind === "step" &&
          t.output === undefined &&
          (event.id === undefined || t.id === undefined || t.id === event.id),
      );
      const step = items[index];
      if (step?.kind === "step") items[index] = { ...step, output: event.output };
    } else if (event.type === "error") {
      updated.error = friendlyError(event.message, s.provider);
    }
    if (event.type === "done" || event.type === "error") updated.finishedAt = Date.now();
    nextTurns[nextTurns.length - 1] = updated;
    const lastResponseId =
      event.type === "done" && event.responseId ? event.responseId : c.lastResponseId;
    // A session deleted elsewhere: unbind so the next send starts a fresh one.
    const sessionId =
      event.type === "error" && event.message === "session_not_found" ? null : c.sessionId;
    return { ...c, turns: nextTurns, lastResponseId, sessionId, updatedAt: Date.now() };
  });
  if (event.type === "done" || event.type === "error") {
    set((st) => ({
      conversations: st.conversations.map((c) =>
        c.openRequest === event.requestId ? { ...c, openRequest: null } : c,
      ),
      unseen: s.convoId === st.activeId ? st.unseen : new Set(st.unseen).add(s.convoId),
    }));
    endRun(event.requestId);
  }
  // A steer the agent never got to: it goes first in line.
  if (event.type === "steerReturned") {
    set((st) => ({
      queue: [
        {
          id: crypto.randomUUID(),
          convoId: s.convoId,
          provider: s.provider,
          question: event.text,
          input: event.text,
          title: clampTitle(event.text),
        },
        ...st.queue,
      ],
    }));
    startQueued();
  }
}

/** The main window's part: turns stream into their chats while any view, or none, shows them. */
export function useChatEvents(): void {
  useEffect(() => window.desktopBridge.on("agent:chatEvent", onChatEvent), []);
}
