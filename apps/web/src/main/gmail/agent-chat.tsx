import { useLatest } from "../use-latest";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { MessageScroller } from "@shadcn/react/message-scroller";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FilePenLineIcon,
  HistoryIcon,
  LayersIcon,
  MailIcon,
  SendIcon,
  TextQuoteIcon,
  FolderIcon,
  Trash2Icon,
  XIcon,
  MousePointer2Icon,
  PlusIcon,
  CheckIcon,
  SearchIcon,
  CornerUpRightIcon,
  ListPlusIcon,
  CopyIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { IconBtn, HintTooltip, buttonClass, cn } from "./ui";
import { COMPOSER_SURFACE } from "./composer-kit";
import { WorkLog, type TurnItem } from "./work-log";
import { PanelControlSlot } from "./top-bar";
import { PanelTab } from "./panel-tab";
import { mostRecentTab, orderedPanelTabs } from "./panel-tabs";
import { usePanelTabDrag } from "./use-panel-tab-drag";
import {
  gmailApi,
  type ChatEvent,
  type ChatChange,
  type ChatSession,
  type ChatSessionMessage,
  type ApprovalDecision,
  type ChatAttachment,
  type ApprovalRequest,
  type AgentSettingsPatch,
  type ProviderKind,
  type ToolStep,
  type Skill,
} from "./api";
import { ProviderModelPicker, RuntimeModePicker, TraitsPicker } from "./model-picker";
import { ApprovalCard } from "./approval-card";
import {
  ProviderIcon,
  isProviderUsable,
  providerSummary,
  useAgentProviders,
  useSetProvidersState,
} from "./agent-providers";
import {
  buildHandoffText,
  contextFromMessages,
  contextFromQuote,
  type AgentContext,
  type QuoteContext,
} from "./chat-context";
import { ChatMarkdown } from "./chat-markdown";
import { ChatChanges, mergeChatChanges } from "./chat-changes";
import {
  AttachmentChip,
  ComposerAttachments,
  DropOverlay,
  SentAttachments,
  filesFromPaste,
  useChatAttachments,
  useFileDrop,
  type SentAttachment,
} from "./chat-attachments";
import { IntentMarker, QueuedRunsControl, useFollowUpBehavior } from "./chat-queue";
import { toast } from "./toast";
import { useCommandHandlers, useKeybindingContext } from "../keybindings/dispatch";
import { useAccounts, useMessage } from "./hooks";
import type { GmailMessageSummary } from "./types";
import { features } from "../features";
import { BrowserPages, BrowserTabIcon } from "../browser/browser-view";
import {
  closeTab as closeBrowserTab,
  hostOf,
  newTab,
  selectTab,
  useBrowser,
  type BrowserTab,
} from "../browser/store";
import { modKeyName, shortcutText } from "../keybindings/keys";

/** What the attached context items are, so the chip shows a fitting icon. */
type ContextKind = "draft" | "sent" | "mail" | "mixed" | "quote" | "project";
type ContextMeta = { subjects: string[]; count: number; kind: ContextKind };

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

function ContextKindIcon({ kind, className }: { kind: ContextKind; className?: string }) {
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

/** One transcript entry. */
type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  /** The user's message (agent turns stored before `items`: their reply). */
  text: string;
  /** Agent turns: what the agent said and the steps it took, in order. */
  items?: TurnItem[];
  /** Confirmed results of this turn, shown underneath its reply. */
  changes?: ChatChange[];
  /** Agent turns stored before `items`: their tool rows. */
  tools?: { name: string; output?: string }[];
  /** Attached mail context, shown as a chip above the user's message. */
  context?: ContextMeta;
  /** Invoked skill, rendered as a badge on the user's message. */
  skill?: string;
  /** How a user message was delivered (Otter Code's inputIntent marker). */
  intent?: "queued" | "steer" | "promoted";
  /** Files sent with a user message (thumbnails for images). */
  attachments?: SentAttachment[];
  error?: string;
  /** Agent turns: when the run started / settled, for the "Worked for" fold. */
  startedAt?: number;
  finishedAt?: number;
};

/**
 * A tool row as turns stored before steps labelled it (Claude `search_mail: {…}`,
 * Codex `otter-mail: search_mail` or the command, Hermes the tool's name), as a
 * step; null for Claude's own ToolSearch.
 */
function legacyStep(label: string): ToolStep | null {
  const words = (name: string) => {
    const text = name.replace(/[_-]+/g, " ").trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const [, head, rest] = label.match(/^([\w.-]+): ([\s\S]*)$/) ?? [];
  if (head === "ToolSearch") return null;
  if (head && /^otter[-_]mail$/.test(head))
    return { kind: "tool", title: words(rest), source: "Otter Mail" };
  if (head === "Bash")
    return { kind: "command", title: `Ran ${rest.split("\n")[0]}`, detail: rest };
  if (head === "Read")
    return { kind: "read", title: `Read ${rest.split("/").pop()}`, detail: rest };
  // Claude's rows for Otter Mail's tools went without their prefix: `search_mail: {…}`.
  if (head && /^[a-z]+(_[a-z]+)+$/.test(head))
    return { kind: "tool", title: words(head), source: "Otter Mail", detail: rest };
  if (head) return { kind: "tool", title: words(head), detail: rest };
  if (/\s/.test(label)) return { kind: "command", title: `Ran ${label}`, detail: label };
  return { kind: "tool", title: words(label) };
}

/** An agent turn's items; turns stored before `items` had tool rows, then the reply. */
function itemsOf(turn: ChatTurn): TurnItem[] {
  if (turn.items) return turn.items;
  const steps = (turn.tools ?? []).flatMap((t): TurnItem[] => {
    const step = legacyStep(t.name);
    return step ? [{ kind: "step", step, output: t.output }] : [];
  });
  return [...steps, ...(turn.text ? [{ kind: "text" as const, text: turn.text }] : [])];
}

/** Command-style badge for an invoked skill (composer + user message). */
function SkillBadge({
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
function ContextRecap({ context }: { context: ContextMeta }) {
  const label =
    context.count > 1
      ? `${context.count} conversations`
      : (context.subjects[0] ?? "1 conversation");
  return (
    <div className="mb-1 flex justify-end">
      <span className="flex max-w-64 items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground">
        <ContextKindIcon kind={context.kind} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </span>
    </div>
  );
}

/**
 * A saved chat, bound to the provider it started with. `sessionId` is the
 * provider-side session (Hermes session / Codex thread); pre-migration Hermes
 * chats have none and keep chaining via `lastResponseId` (Responses API).
 */
type Conversation = {
  id: string;
  title: string;
  turns: ChatTurn[];
  provider: ProviderKind;
  sessionId: string | null;
  /** Created by this app (deleting the chat deletes the session) vs. opened from the provider. */
  sessionOwned: boolean;
  lastResponseId: string | null;
  updatedAt: number;
};

/** `tabs`: open chats, in strip order; empty while only browser tabs remain. */
type Store = { conversations: Conversation[]; activeId: string; tabs: string[] };

/** A turn in flight, bound to its conversation (several chats can run at once). */
type Run = { requestId: string; convoId: string; provider: ProviderKind };

/** A composed message, before it becomes a turn (or a steer). */
type Outgoing = {
  id: string;
  convoId: string;
  question: string;
  /** What the agent receives (question + attached context block). */
  input: string;
  skill?: Skill;
  title: string;
  context?: ContextMeta;
  attachments?: ChatAttachment[];
  sent?: SentAttachment[];
};

/**
 * A follow-up waiting for the running turn (Otter Code's queued run). It has
 * no transcript row until it starts; it lives in the queue banner. In memory
 * only: a queued message is a live intent, not a draft worth persisting.
 */
type QueuedMessage = Outgoing;

const STORE_KEY = "gmail:hermes-chat:v2";
const PANEL_TABS_KEY = "gmail:panel-tabs";
const LEGACY_KEY = "gmail:hermes-chat:v1";
const MAX_STORED_TURNS = 80;
const MAX_CONVERSATIONS = 40;

function loadPanelTabOrder(): string[] {
  try {
    const order: unknown = JSON.parse(localStorage.getItem(PANEL_TABS_KEY) ?? "[]");
    return Array.isArray(order) ? order.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function clampTitle(text: string): string {
  const t = text.trim();
  if (!t) return "New chat";
  return t.length > 56 ? `${t.slice(0, 56)}…` : t;
}

function deriveTitle(turns: ChatTurn[]): string {
  return clampTitle(turns.find((t) => t.role === "user")?.text ?? "");
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

/** Human label for a session's origin (WebUI, CLI, this API, …). */
function sourceLabel(source: string): string {
  switch (source) {
    case "hermes_browser":
      return "WebUI";
    case "api_server":
      return "API";
    case "cli":
      return "CLI";
    case "codex":
      return "Codex";
    case "openrouter":
      return "OpenRouter";
    default:
      return source.charAt(0).toUpperCase() + source.slice(1);
  }
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
  return turns.filter((t) => t.role === "user" || itemsOf(t).length > 0);
}

function loadStore(): Store {
  let conversations: Conversation[] = [];
  let activeId: string | null = null;
  let tabs: string[] = [];
  try {
    const v2 = JSON.parse(localStorage.getItem(STORE_KEY) ?? "") as Partial<Store>;
    if (Array.isArray(v2.conversations)) {
      // Older chats carry no session / provider fields (they were all Hermes).
      conversations = v2.conversations.map((c) => ({
        ...c,
        provider: c.provider ?? "hermes",
        sessionId: c.sessionId ?? null,
        sessionOwned: c.sessionOwned ?? false,
      }));
      activeId = v2.activeId ?? null;
      tabs = Array.isArray(v2.tabs) ? v2.tabs : [];
    }
  } catch {
    // fall through to legacy migration
  }
  if (conversations.length === 0) {
    try {
      const v1 = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "") as {
        turns?: ChatTurn[];
        lastResponseId?: string | null;
      };
      if (v1.turns && v1.turns.length > 0) {
        conversations = [
          {
            id: crypto.randomUUID(),
            title: deriveTitle(v1.turns),
            turns: v1.turns,
            provider: "hermes",
            sessionId: null,
            sessionOwned: false,
            lastResponseId: v1.lastResponseId ?? null,
            updatedAt: Date.now(),
          },
        ];
      }
    } catch {
      // no legacy data
    }
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

function saveStore(store: Store): void {
  const conversations = store.conversations
    .slice(0, MAX_CONVERSATIONS)
    .map((c) => ({ ...c, turns: c.turns.slice(-MAX_STORED_TURNS) }));
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ conversations, activeId: store.activeId, tabs: store.tabs }),
  );
}

function formatAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
    default:
      return code.startsWith("agent_error: ")
        ? code.slice("agent_error: ".length)
        : `${name} answered with an error (${code}).`;
  }
}

/** Hydrated user turns show the question, not the context block sent with it. */
function stripHandoff(text: string): string {
  const cut = text.indexOf("\n\n— context from Otter Mail —");
  return cut === -1 ? text : text.slice(0, cut);
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

/**
 * Dropdown sheet of past conversations plus, when the provider keeps them, the
 * other sessions persisted there (Hermes WebUI, earlier Codex threads, …).
 * Escape/backdrop-click closes it.
 */
function HistoryList({
  conversations,
  activeId,
  onPick,
  onDelete,
  onClose,
  serverSessions,
  serverLoading,
  onPickServer,
  providerName,
}: {
  providerName: string;
  conversations: Conversation[];
  activeId: string;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  /** Undefined when the server has no Sessions API (section hidden). */
  serverSessions?: ChatSession[];
  serverLoading: boolean;
  onPickServer: (session: ChatSession) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);
  const all = conversations.filter((c) => c.turns.length > 0);
  const items = all.filter((c) => matches(c.title));
  const showServer = serverSessions !== undefined || serverLoading;
  const server = (serverSessions ?? []).filter((s) => matches(s.title || s.preview || s.id));
  const nothingYet = all.length === 0 && (serverSessions?.length ?? 0) === 0 && !serverLoading;
  // Section labels only when there are two sections to tell apart.
  const labelled = showServer && all.length > 0;

  const row =
    "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06]";
  return (
    <>
      <div
        className="absolute inset-x-0 bottom-0 top-(--workspace-topbar-height) z-10"
        onClick={onClose}
        aria-hidden
      />
      {/* Under the History button (right), like a menu, not across the panel. */}
      <div className="absolute right-2 top-[calc(var(--workspace-topbar-height)-4px)] z-20 flex max-h-[70%] w-80 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-xl border border-foreground/10 bg-popover text-foreground shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
        {nothingYet ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <HistoryIcon className="size-6 text-muted-foreground" strokeWidth={1.5} />
            <span className="text-sm text-foreground">No past chats yet</span>
            <span className="text-[13px] text-muted-foreground">
              Chats you finish show up here.
            </span>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-foreground/10 px-3 py-2">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats"
                aria-label="Search chats"
                className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {labelled ? (
                <div className="px-2 pb-1 pt-1 text-[13px] text-muted-foreground">Recent</div>
              ) : null}
              {items.map((c) => (
                <div key={c.id} className="group/row relative">
                  <button type="button" onClick={() => onPick(c.id)} className={row}>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.id === activeId ? (
                      <CheckIcon className="size-4 shrink-0 text-foreground group-hover/row:invisible" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground group-hover/row:invisible">
                        {formatAgo(c.updatedAt)}
                      </span>
                    )}
                  </button>
                  {/* Delete takes the time's place on hover. */}
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    aria-label="Delete chat"
                    title="Delete chat"
                    className="absolute right-1 top-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-foreground/[0.08] hover:text-destructive-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                  >
                    <Trash2Icon className="size-3.5" />
                  </button>
                </div>
              ))}
              {showServer ? (
                <>
                  {labelled ? (
                    <div className="px-2 pb-1 pt-2.5 text-[13px] text-muted-foreground">
                      On {providerName}
                    </div>
                  ) : null}
                  {server.map((sess) => (
                    <button
                      key={sess.id}
                      type="button"
                      onClick={() => onPickServer(sess)}
                      title={sourceLabel(sess.source)}
                      className={row}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {sess.title || sess.preview || sess.id}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatAgo(sess.lastActive)}
                      </span>
                    </button>
                  ))}
                  {serverLoading && server.length === 0 ? (
                    <div className="px-2 py-2 text-[13px] text-muted-foreground">
                      Loading {providerName} sessions…
                    </div>
                  ) : null}
                </>
              ) : null}
              {q && items.length === 0 && server.length === 0 ? (
                <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
                  No chats match “{query.trim()}”
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Right-side agent chat. Each conversation is bound to a provider (Hermes,
 * Codex); turns stream through the backend's provider layer as canonical chat
 * events. The local store mirrors transcripts for instant paint (history
 * dropdown); "attach" adds pointer-only context.
 */
type ChatTab = {
  id: string;
  title: string;
  state: "idle" | "working" | "approval" | "unseen";
};

const TAB_STATE_LABEL: Record<ChatTab["state"], string | null> = {
  idle: null,
  working: "Working",
  approval: "Waiting for your approval",
  unseen: "Finished",
};

/**
 * The panel's strip: draggable pill tabs for chats and browser pages,
 * always shown, so the current chat is named even when it's the only one.
 * A chat's icon carries its state (working, waiting on an approval,
 * or finished while you were elsewhere).
 */
function AgentTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onReorder,
}: {
  tabs: (ChatTab | BrowserTab)[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (order: string[]) => void;
}) {
  const { ref, draggingId, handlers } = usePanelTabDrag(onReorder);
  return (
    <div
      role="tablist"
      ref={ref}
      aria-label="Open chats and pages"
      className="no-drag scroll-fade-x relative flex min-w-0 shrink items-center gap-1 overflow-x-auto [scrollbar-width:none]"
      {...handlers}
    >
      {tabs.map((tab) => {
        const page = "url" in tab;
        const status = page ? null : TAB_STATE_LABEL[tab.state];
        const title = page ? tab.title || (tab.url ? hostOf(tab.url) : "New tab") : tab.title;
        return (
          <PanelTab
            key={tab.id}
            id={tab.id}
            title={title}
            tooltip={
              page && tab.url ? `${title}\n${tab.url}` : status ? `${title} — ${status}` : title
            }
            selected={tab.id === activeId}
            dragging={draggingId === tab.id}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
            icon={
              page ? (
                <BrowserTabIcon tab={tab} />
              ) : (
                <>
                  <MousePointer2Icon className="size-3.5" />
                  {tab.state !== "idle" ? (
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-1 ring-canvas",
                        tab.state === "approval" ? "bg-warning" : "bg-primary",
                        tab.state === "working" && "animate-status-pulse",
                      )}
                    />
                  ) : null}
                </>
              )
            }
          />
        );
      })}
    </div>
  );
}

export function AgentChatPanel({
  accountId,
  messageId,
  selectedRows,
  quote,
  onClearQuote,
  closeTabRef,
  newTabRef,
  onClosePanel,
  project,
  onOpenChange,
  expanded = false,
  onToggleExpanded,
}: {
  /** The panel fills the window (the mail hides), for a page or a long chat. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  /** The project on screen: attached along with (or without) a conversation. */
  project?: { id: string; name: string } | null;
  /** Account of the open conversation (context attach), null when none. */
  accountId: string | null;
  messageId: string | null;
  /** Multi-selected list rows; take priority over the open conversation. */
  selectedRows?: GmailMessageSummary[];
  /** A highlighted excerpt to attach; overrides the auto-derived context. */
  quote?: QuoteContext | null;
  onClearQuote?: () => void;
  /** ⌘W: closes the active chat or page, including the last tab. */
  closeTabRef?: MutableRefObject<(() => boolean) | null>;
  /** Global ⌘T: a new chat on shells without browser pages. */
  newTabRef?: MutableRefObject<((reuseEmpty?: boolean) => void) | null>;
  /** Closing the last tab closes the panel. */
  onClosePanel?: () => void;
  onOpenChange: (change: ChatChange) => Promise<void>;
}) {
  const [store, setStore] = useState<Store>(() => loadStore());
  const { conversations, activeId } = store;
  const active = conversations.find((c) => c.id === activeId);
  const turns = active?.turns ?? [];
  // The browser's tab showing over the chat (Mac), if one is.
  const browserTabId = useBrowser((s) => (features.browser ? s.activeId : null));
  const browserTabs = useBrowser((s) => s.tabs);
  const [tabOrder, setTabOrder] = useState(loadPanelTabOrder);
  const panelTabs = orderedPanelTabs(tabOrder, [
    ...store.tabs,
    ...(features.browser ? browserTabs.map((tab) => tab.id) : []),
  ]);
  if (panelTabs.length !== tabOrder.length || panelTabs.some((id, at) => id !== tabOrder[at])) {
    setTabOrder(panelTabs);
  }
  const panelTabsRef = useLatest(panelTabs);
  useEffect(() => {
    localStorage.setItem(PANEL_TABS_KEY, JSON.stringify(tabOrder));
  }, [tabOrder]);
  const panelRef = useRef<HTMLDivElement>(null);
  const recentTabsRef = useRef<string[]>([]);
  useEffect(() => {
    const tabs = new Set([
      ...store.tabs,
      ...(features.browser ? browserTabs.map((tab) => tab.id) : []),
    ]);
    const shown = browserTabId ?? activeId;
    recentTabsRef.current = [
      ...(tabs.has(shown) ? [shown] : []),
      ...recentTabsRef.current.filter((id) => id !== shown && tabs.has(id)),
    ];
  }, [activeId, browserTabId, store.tabs, browserTabs]);
  // The final page can close through its × or an extension, leaving a fresh chat.
  if (!browserTabId && store.tabs.length === 0) {
    setStore((s) => {
      const fresh = newConversation();
      return { conversations: [fresh, ...s.conversations], activeId: fresh.id, tabs: [fresh.id] };
    });
  }

  const [draft, setDraft] = useState("");
  // Turns in flight, one per conversation: each streams into its own chat, so
  // tabs can work in parallel.
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const run = runs[activeId] ?? null;
  // Background tabs whose turn finished since you last looked at them.
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());
  const [attach, setAttach] = useState(true);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Pasted / dropped / picked files for the next message.
  const files = useChatAttachments();
  const drop = useFileDrop((dropped) => {
    void files.add(dropped);
    inputRef.current?.focus();
  });
  const filePickerRef = useRef<HTMLInputElement>(null);
  // ⌘ held: the send button previews the alternate action (queue ⇄ steer).
  const [modHeld, setModHeld] = useState(false);
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setModHeld(e.metaKey || e.ctrlKey);
    const clear = () => setModHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const followUp = useFollowUpBehavior();
  // Approvals the running turn is waiting on (oldest first).
  const [approvals, setApprovals] = useState<{ requestId: string; approval: ApprovalRequest }[]>(
    [],
  );
  const [respondingApproval, setRespondingApproval] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Provider: a conversation keeps the one it started with; an empty one
  // follows the picker (the default for new chats).
  const providersQuery = useAgentProviders();
  const setProvidersState = useSetProvidersState();
  const providersState = providersQuery.data;
  const selectedKind = providersState?.selected ?? "openrouter";
  const providerKind: ProviderKind =
    active && active.turns.length > 0 ? active.provider : selectedKind;
  const provider = providersState?.providers.find((p) => p.kind === providerKind);
  const providerName =
    provider?.displayName ??
    (providerKind === "openrouter" ? "OpenRouter" : providerKind === "codex" ? "Codex" : "Hermes");
  const usable = isProviderUsable(provider);
  const sessionsAvailable = Boolean(provider?.sessions && usable);
  // Finished runs fold their tool rows behind a "Worked for …" summary.
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const toggleFold = (id: string) =>
    setExpandedFolds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Conversation whose transcript is being pulled from the server.
  const [hydrating, setHydrating] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    saveStore(store);
  }, [store]);

  // Other sessions persisted on the provider (Hermes WebUI, Codex threads…), fetched when history opens.
  const serverSessionsQuery = useQuery<ChatSession[]>({
    queryKey: ["agent-sessions", providerKind],
    queryFn: () => gmailApi.agentSessions(providerKind, 40),
    enabled: historyOpen && sessionsAvailable,
    staleTime: 15_000,
  });

  // Skills for the "/" picker, from whichever provider this chat uses.
  const skillsQuery = useQuery<Skill[]>({
    queryKey: ["agent-skills", providerKind],
    queryFn: () => gmailApi.agentSkills(providerKind),
    enabled: usable,
    staleTime: 5 * 60_000,
  });
  const skills = skillsQuery.data ?? [];

  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItemRef = useRef<HTMLButtonElement | null>(null);
  // A picked skill is promoted out of the textarea into a badge; the textarea
  // then holds only the instruction.
  const [activeSkill, setActiveSkill] = useState<Skill | null>(null);
  const handleDraftChange = (value: string) => {
    setSlashDismissed(false);
    // Typing a space after a complete "/known-skill" promotes it to the badge.
    if (!activeSkill) {
      const m = value.match(/^\/([a-z0-9:_-]+)\s([\s\S]*)$/i);
      const sk = m && skills.find((s) => s.name.toLowerCase() === m[1].toLowerCase());
      if (sk) {
        setActiveSkill(sk);
        setDraft(m![2]);
        return;
      }
    }
    setDraft(value);
  };
  // The menu opens only while typing a bare "/slug" (no space yet).
  const slashMatch = draft.match(/^\/([a-z0-9:_-]*)$/i);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const slashSkills =
    slashQuery !== null
      ? skills.filter((s) => s.name.toLowerCase().includes(slashQuery)).slice(0, 8)
      : [];
  const slashOpen = slashQuery !== null && !slashDismissed && slashSkills.length > 0;
  const [indexForQuery, setIndexForQuery] = useState(slashQuery);
  if (indexForQuery !== slashQuery) {
    setIndexForQuery(slashQuery);
    setSlashIndex(0);
  }
  // Keep the keyboard-highlighted skill scrolled into view.
  useEffect(() => {
    slashItemRef.current?.scrollIntoView({ block: "nearest" });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Re-run this DOM/reset lifecycle when its explicit trigger changes, even when the callback reads refs.
  }, [slashIndex]);
  const pickSkill = (skill: Skill) => {
    setActiveSkill(skill);
    setDraft("");
    setSlashDismissed(true);
    inputRef.current?.focus();
  };

  // Attach context: the multi-selection wins; otherwise the open conversation
  // (cache hit — the reader fetched it). Both are pointer-only; the agent
  // reads the bodies itself.
  const accountsQuery = useAccounts();
  const accountEmailById = (id: string | undefined) =>
    accountsQuery.data?.find((a) => a.id === id)?.email ?? id ?? "";
  const openMessage = useMessage(accountId, messageId);
  const multiSelected = selectedRows && selectedRows.length > 0;
  // A highlighted excerpt wins over any auto-derived context.
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
  const contextLabelSets: string[][] = multiSelected
    ? selectedRows.map((r) => r.labelIds)
    : openMessage.data
      ? [openMessage.data.labelIds]
      : [];
  const attachKind: ContextKind = quote
    ? "quote"
    : projectOnly
      ? "project"
      : contextKind(contextLabelSets);

  // A fresh quote re-arms the attach toggle so it isn't silently dropped.
  const [attachedQuote, setAttachedQuote] = useState(quote);
  if (attachedQuote !== quote) {
    setAttachedQuote(quote);
    if (quote) setAttach(true);
  }

  // Stream events land in their originating conversation (not necessarily the
  // active one); the listener mounts once and reads the stream via a ref.
  const storeRef = useLatest(store);
  const runsRef = useLatest(runs);
  const activeIdRef = useLatest(activeId);
  const endRun = (requestId: string) =>
    setRuns((all) => {
      const entry = Object.values(all).find((r) => r.requestId === requestId);
      if (!entry) return all;
      const next = { ...all };
      delete next[entry.convoId];
      return next;
    });
  const endRunForEffect = useLatest(endRun);
  useEffect(() => {
    const unsub = window.desktopBridge.on("agent:chatEvent", (raw: unknown) => {
      const event = raw as ChatEvent;
      const s = event
        ? Object.values(runsRef.current).find((r) => r.requestId === event.requestId)
        : undefined;
      if (!event || !s) return;
      // Approvals live beside the transcript, not in it.
      if (event.type === "approval") {
        setApprovals((list) => [...list, { requestId: event.requestId, approval: event.approval }]);
        return;
      }
      if (event.type === "approvalResolved") {
        setApprovals((list) => list.filter((a) => a.approval.id !== event.approvalId));
        return;
      }
      if (event.type === "done" || event.type === "error")
        setApprovals((list) => list.filter((a) => a.requestId !== event.requestId));
      setStore((prev) => ({
        ...prev,
        conversations: prev.conversations.map((c) => {
          if (c.id !== s.convoId) return c;
          // The provider opened a session for this chat: bind it for the next turns.
          if (event.type === "session")
            return { ...c, sessionId: event.sessionId, sessionOwned: true };
          const nextTurns = [...c.turns];
          const turn = nextTurns[nextTurns.length - 1];
          if (!turn || turn.role !== "assistant") return c;
          const items = [...itemsOf(turn)];
          const updated: ChatTurn = { ...turn, items };
          const last = items[items.length - 1];
          if (event.type === "change") {
            updated.changes = mergeChatChanges([...(turn.changes ?? []), event.change]);
          } else if (event.type === "delta") {
            // Text continues the text before it; after a step it starts anew.
            if (last?.kind === "text")
              items[items.length - 1] = { ...last, text: last.text + event.text };
            else items.push({ kind: "text", text: event.text });
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
          return {
            ...c,
            turns: nextTurns,
            lastResponseId,
            sessionId,
            updatedAt: Date.now(),
          };
        }),
      }));
      if (event.type === "done" || event.type === "error") {
        endRunForEffect.current(event.requestId);
        if (s.convoId !== activeIdRef.current) setUnseen((u) => new Set(u).add(s.convoId));
      }
      // A steer the agent never got to: it goes first in line.
      if (event.type === "steerReturned")
        setQueue((q) => [
          {
            id: crypto.randomUUID(),
            convoId: s.convoId,
            question: event.text,
            input: event.text,
            title: clampTitle(event.text),
          },
          ...q,
        ]);
    });
    return unsub;
  }, [activeIdRef, endRunForEffect, runsRef]);

  const patchConversation = (id: string, fn: (c: Conversation) => Conversation) => {
    setStore((s) => ({
      ...s,
      conversations: s.conversations.map((c) => (c.id === id ? fn(c) : c)),
    }));
  };

  // Chats saved before turns kept their steps in order: the first time one
  // opens, its agent turns are read back from the agent's own session.
  const upgraded = useRef(new Set<string>());
  const patchConversationForEffect = useLatest(patchConversation);
  useEffect(() => {
    const c = active;
    if (!c?.sessionId || runs[c.id] || upgraded.current.has(c.id)) return;
    if (!c.turns.some((t) => t.role === "assistant" && !t.items)) return;
    const host = providersState?.providers.find((p) => p.kind === c.provider);
    if (!host?.sessions || !isProviderUsable(host)) return;
    upgraded.current.add(c.id);
    gmailApi.agentSessionMessages(c.provider, c.sessionId).then(
      (messages) => {
        const fresh = turnsFromMessages(messages).filter((t) => t.role === "assistant");
        patchConversationForEffect.current(c.id, (current) => {
          // Only when the session lines up with the chat, turn for turn.
          if (fresh.length !== current.turns.filter((t) => t.role === "assistant").length)
            return current;
          let i = 0;
          const turns = current.turns.map((t) => {
            if (t.role !== "assistant") return t;
            const items = fresh[i++].items;
            return t.items ? t : { ...t, items };
          });
          return { ...current, turns };
        });
      },
      (error) => console.log("[AgentChat:upgrade] failed", { error: String(error) }),
    );
  }, [active, runs, providersState, patchConversationForEffect, upgraded]);

  /** Consumes the composer (text, skill, attached context) into a message. */
  const compose = (): Outgoing | null => {
    const question = draft.trim();
    if ((!question && !activeSkill && files.count === 0) || !usable || !active) return null;
    if (files.staging) {
      toast.info("Attachments are still being added");
      return null;
    }
    const { staged, sent } = files.take();
    const attached = attach && context ? context : null;
    const skill = activeSkill ?? undefined;
    setDraft("");
    setActiveSkill(null);
    // A quote is one-shot — release it once it's been sent.
    if (attached && quote) onClearQuote?.();
    return {
      id: crypto.randomUUID(),
      convoId: active.id,
      question,
      input: attached ? buildHandoffText(question, attached, providerKind) : question,
      skill,
      title: clampTitle(
        skill ? `/${skill.name} ${question}` : question || sent[0]?.name || "Attachment",
      ),
      attachments: staged.length > 0 ? staged : undefined,
      sent: sent.length > 0 ? sent : undefined,
      context: attached
        ? {
            count: attached.conversations.length || 1,
            subjects: quote
              ? [quote.text]
              : projectOnly && attached.project
                ? [attached.project.name]
                : attached.conversations.map((x) => x.subject),
            kind: attachKind,
          }
        : undefined,
    };
  };

  /** The user bubble + an empty agent turn that the stream fills in. */
  const appendExchange = (
    convoId: string,
    msg: Outgoing,
    requestKey: string,
    intent?: ChatTurn["intent"],
  ) =>
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

  /** Starts a new turn in the message's conversation. */
  const startTurn = (msg: Outgoing, intent?: ChatTurn["intent"]) => {
    const convo = storeRef.current.conversations.find((c) => c.id === msg.convoId);
    if (!convo) return;
    const requestId = crypto.randomUUID();
    const kind = convo.turns.length > 0 ? convo.provider : providerKind;
    const firstTurn = convo.turns.length === 0;
    console.log("[AgentChat:send]", {
      requestId,
      provider: kind,
      attached: Boolean(msg.context),
      skill: msg.skill?.name,
      session: convo.sessionId ?? "new",
    });
    patchConversation(msg.convoId, (c) => ({
      ...c,
      // The first turn pins the chat to the provider it was sent with.
      provider: firstTurn ? kind : c.provider,
      title: firstTurn ? msg.title : c.title,
    }));
    appendExchange(msg.convoId, msg, requestId, intent);
    const started: Run = { requestId, convoId: msg.convoId, provider: kind };
    runsRef.current = { ...runsRef.current, [msg.convoId]: started };
    setRuns((all) => ({ ...all, [msg.convoId]: started }));
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
              ? {
                  ...t,
                  error: friendlyError("unreachable", kind),
                  finishedAt: Date.now(),
                }
              : t,
          ),
        }));
        endRun(requestId);
      });
  };

  /**
   * Steers the message into the running turn (Codex turn/steer, Claude's live
   * prompt, Hermes' run steer). Refused → it goes (back) to the queue.
   */
  const steer = (msg: Outgoing, intent: "steer" | "promoted" = "steer") => {
    const target = runsRef.current[msg.convoId];
    if (!target) return startTurn(msg);
    console.log("[AgentChat:steer]", { provider: target.provider, intent });
    const key = `${target.requestId}-${msg.id}`;
    appendExchange(msg.convoId, msg, key, intent);
    const refused = () => {
      undoExchange(msg.convoId, key);
      setQueue((q) => [msg, ...q]);
    };
    gmailApi
      .agentSteer(target.provider, target.requestId, msg.input)
      .then(({ accepted }) => !accepted && refused(), refused);
  };

  /** Removes an optimistic steer exchange that the agent refused. */
  const undoExchange = (convoId: string, requestKey: string) =>
    patchConversation(convoId, (c) => ({
      ...c,
      turns: c.turns.filter((t) => t.id !== `u-${requestKey}` && t.id !== `a-${requestKey}`),
    }));

  /**
   * Otter Code's dispatch modes: idle → start; running → queue or steer per
   * the follow-up setting, ⌘↩ / ⌘-click does the opposite for one message.
   * Editing a queued message, send updates it in place instead.
   */
  const send = (alternate = false) => {
    if (editing) {
      saveQueuedEdit();
      return;
    }
    const msg = compose();
    if (!msg) return;
    if (!runsRef.current[msg.convoId]) return startTurn(msg);
    // Steering sends text only; a message with files waits for its own turn.
    if ((followUp === "queue") !== alternate || msg.attachments) setQueue((q) => [...q, msg]);
    else steer(msg);
  };

  /** Promote a queued message to steer the active run (Otter Code's "Steer"). */
  const steerQueued = (id: string) => {
    const msg = queue.find((m) => m.id === id);
    if (!msg || !runsRef.current[msg.convoId]) return;
    setQueue((q) => q.filter((m) => m.id !== id));
    steer(msg, "promoted");
  };

  /** Drag / arrow-key reorder: move `id` before `beforeId` (null = to the end). */
  const moveQueued = (id: string, beforeId: string | null) =>
    setQueue((q) => {
      const moving = q.find((m) => m.id === id);
      if (!moving || id === beforeId) return q;
      const rest = q.filter((m) => m.id !== id);
      const at = beforeId === null ? rest.length : rest.findIndex((m) => m.id === beforeId);
      return at < 0 ? q : [...rest.slice(0, at), moving, ...rest.slice(at)];
    });

  const removeQueued = (id: string) => {
    if (editing?.id === id) cancelQueuedEdit();
    setQueue((q) => q.filter((m) => m.id !== id));
  };

  // Editing a queued message borrows the composer; the user's own draft is
  // set aside and comes back when the edit ends (Otter Code's queued-edit draft).
  const [editing, setEditing] = useState<{
    id: string;
    savedDraft: string;
  } | null>(null);
  const editQueued = (id: string) => {
    const msg = queue.find((m) => m.id === id);
    if (!msg) return;
    setEditing({ id, savedDraft: editing ? editing.savedDraft : draft });
    setDraft(msg.question);
    inputRef.current?.focus();
  };
  const cancelQueuedEdit = () => {
    if (!editing) return;
    setDraft(editing.savedDraft);
    setEditing(null);
  };
  const saveQueuedEdit = () => {
    if (!editing) return;
    const text = draft.trim();
    if (!text) return;
    setQueue((q) =>
      q.map((m) =>
        m.id === editing.id
          ? {
              ...m,
              question: text,
              // Keep the attached context block, swap the question above it.
              input: m.input === m.question ? text : m.input.replace(m.question, text),
              title: clampTitle(text),
            }
          : m,
      ),
    );
    cancelQueuedEdit();
  };
  // The edited message left the queue (it started, or was removed): keep a
  // dirty edit in the composer, otherwise restore the user's draft.
  const cancelQueuedEditForEffect = useLatest(cancelQueuedEdit);
  useEffect(() => {
    if (!editing || queue.some((m) => m.id === editing.id)) return;
    const original = draft.trim();
    if (original && !editing.savedDraft.trim()) {
      // oxlint-disable-next-line react/set-state-in-effect -- Coordinate queue consumption and editing with the external agent turn lifecycle.
      setEditing(null);
      toast.info("Queued message is no longer queued", {
        description: "Your unsaved edit was kept in the composer.",
      });
    } else {
      cancelQueuedEditForEffect.current();
    }
  }, [queue, cancelQueuedEditForEffect, draft, editing]);

  /** Resumes a session persisted on the provider (e.g. started in Hermes' WebUI) in the panel. */
  const openServerSession = (session: ChatSession) => {
    setHistoryOpen(false);
    const existing = conversations.find(
      (c) => c.sessionId === session.id && c.provider === providerKind,
    );
    if (existing) {
      switchTo(existing.id);
      return;
    }
    console.log("[AgentChat:openServerSession]", {
      provider: providerKind,
      sessionId: session.id,
      source: session.source,
    });
    const convo: Conversation = {
      id: crypto.randomUUID(),
      title: clampTitle(session.title || session.preview || `${providerName} session`),
      turns: [],
      provider: providerKind,
      sessionId: session.id,
      sessionOwned: false,
      lastResponseId: null,
      updatedAt: session.lastActive,
    };
    setStore((s) => {
      // A new tab, like any chat opened from history (an empty tab is reused).
      const at = s.tabs.indexOf(s.activeId);
      const current = s.conversations.find((c) => c.id === s.activeId);
      const tabs =
        current && current.turns.length === 0 && !runsRef.current[s.activeId]
          ? s.tabs.map((t) => (t === s.activeId ? convo.id : t))
          : [...s.tabs.slice(0, at + 1), convo.id, ...s.tabs.slice(at + 1)];
      return { conversations: pruned([convo, ...s.conversations], tabs), activeId: convo.id, tabs };
    });
    setHydrating(convo.id);
    gmailApi
      .agentSessionMessages(providerKind, session.id)
      .then(
        (messages) => {
          const hydrated = turnsFromMessages(messages);
          patchConversation(convo.id, (c) =>
            c.turns.length > 0 ? c : { ...c, turns: hydrated, updatedAt: Date.now() },
          );
        },
        (error) =>
          console.log("[AgentChat:hydrate] failed", {
            error: String(error),
          }),
      )
      .finally(() => setHydrating((cur) => (cur === convo.id ? null : cur)));
    inputRef.current?.focus();
  };

  const respondApproval = (approvalId: string, decision: ApprovalDecision) => {
    const pending = approvals.find((a) => a.approval.id === approvalId);
    const owner = pending && Object.values(runs).find((r) => r.requestId === pending.requestId);
    if (!owner) return;
    const { provider: kind, requestId } = owner;
    console.log("[AgentChat:approval]", { kind, decision });
    setRespondingApproval(approvalId);
    gmailApi
      .agentRespondApproval({
        provider: kind,
        requestId,
        approvalId,
        decision,
      })
      .then(
        () => setApprovals((list) => list.filter((a) => a.approval.id !== approvalId)),
        (error: unknown) =>
          console.log("[AgentChat:approval] failed", {
            error: String(error),
          }),
      )
      .finally(() => setRespondingApproval(null));
  };

  /** Interrupts the active run; the queue stays and its next message starts (Otter Code). */
  const stop = () => {
    if (run) void gmailApi.agentCancel(run.provider, run.requestId);
  };

  const activeQueue = queue.filter((m) => m.convoId === activeId);
  // This chat's approvals (other tabs' runs wait in their own tab).
  const activeApprovals = run ? approvals.filter((a) => a.requestId === run.requestId) : [];
  // Steer needs a running turn in this chat that isn't waiting on an approval.
  const canSteer = run != null && activeApprovals.length === 0;
  useCommandHandlers({
    "agent.sendQueuedNow": () => {
      const next = activeQueue[0];
      if (!next || !canSteer) return false;
      steerQueued(next.id);
    },
    "agent.editQueued": () => {
      const latest = activeQueue[activeQueue.length - 1];
      const caretAtStart = (inputRef.current?.selectionStart ?? 0) === 0;
      if (!latest || editing || !caretAtStart) return false;
      editQueued(latest.id);
    },
  });

  // A chat's queued message starts once no turn is running in it (after
  // completion, an error, or Stop) — never at a tool boundary; that's what
  // Steer is for. Each chat drains its own queue.
  const nextQueued = queue.find((m) => !runs[m.convoId] && editing?.id !== m.id);
  const startTurnForEffect = useLatest(startTurn);
  useEffect(() => {
    if (!nextQueued) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Coordinate queue consumption and editing with the external agent turn lifecycle.
    setQueue((q) => q.filter((m) => m.id !== nextQueued.id));
    startTurnForEffect.current(nextQueued, "queued");
  }, [nextQueued, startTurnForEffect]);

  /** Empty chats that aren't open anywhere are dropped (no litter). */
  const pruned = (conversations: Conversation[], tabs: string[]) =>
    conversations.filter((c) => c.turns.length > 0 || tabs.includes(c.id));

  /** A fresh chat, in a new tab beside the current one. */
  const newChat = (reuseEmpty = true) => {
    selectTab(null);
    setHistoryOpen(false);
    // An already-empty active session just refocuses — no empty duplicates.
    if (reuseEmpty && active && active.turns.length === 0) {
      inputRef.current?.focus();
      return;
    }
    console.log("[AgentChat:newChat]");
    const fresh = newConversation(selectedKind);
    setStore((s) => {
      const at = s.tabs.indexOf(s.activeId);
      const tabs = [...s.tabs.slice(0, at + 1), fresh.id, ...s.tabs.slice(at + 1)];
      return {
        conversations: pruned([fresh, ...s.conversations], tabs),
        activeId: fresh.id,
        tabs,
      };
    });
    inputRef.current?.focus();
  };
  useEffect(() => {
    if (!newTabRef) return;
    newTabRef.current = newChat;
    return () => {
      newTabRef.current = null;
    };
  });

  /** Shows a chat: its tab if open, else a new tab. */
  const switchTo = (id: string) => {
    selectTab(null);
    setHistoryOpen(false);
    setUnseen((u) => {
      if (!u.has(id)) return u;
      const next = new Set(u);
      next.delete(id);
      return next;
    });
    setStore((s) => {
      // Opens in a new tab beside the current one (an empty "New chat" tab
      // is simply reused).
      const at = s.tabs.indexOf(s.activeId);
      const current = s.conversations.find((c) => c.id === s.activeId);
      const tabs = s.tabs.includes(id)
        ? s.tabs
        : current && current.turns.length === 0 && !runsRef.current[s.activeId]
          ? s.tabs.map((t) => (t === s.activeId ? id : t))
          : [...s.tabs.slice(0, at + 1), id, ...s.tabs.slice(at + 1)];
      return { conversations: pruned(s.conversations, tabs), activeId: id, tabs };
    });
  };

  /**
   * Closes a chat or page, returning to the last viewed tab. Chats stay in history
   * (a running turn finishes there).
   * The last tab closes the panel, leaving a fresh "New chat" for next time.
   */
  const closeTab = (id: string) => {
    const s = storeRef.current;
    const browser = useBrowser.getState();
    const pages = features.browser ? browser.tabs : [];
    const tabs = orderedPanelTabs(panelTabsRef.current, [...s.tabs, ...pages.map((tab) => tab.id)]);
    if (!tabs.includes(id)) return;
    const shown = (features.browser ? browser.activeId : null) ?? s.activeId;
    const next = mostRecentTab(tabs, id, recentTabsRef.current);
    if (tabs.length < 2) onClosePanel?.();
    if (pages.some((tab) => tab.id === id)) {
      closeBrowserTab(id);
      if (shown === id && next) showPanelTab(next);
      return;
    }
    setStore((s) => {
      if (s.tabs.length < 2 && pages.length === 0) {
        const current = s.conversations.find((c) => c.id === id);
        if (!current || current.turns.length === 0) return s;
        const fresh = newConversation(selectedKind);
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
    if (shown === id && next) showPanelTab(next);
  };

  const deleteConversation = (id: string) => {
    const running = runsRef.current[id];
    if (running) {
      void gmailApi.agentCancel(running.provider, running.requestId);
      endRun(running.requestId);
    }
    // Sessions this app created go with the chat; ones opened from the provider only unlink.
    const target = conversations.find((c) => c.id === id);
    if (target?.sessionId && target.sessionOwned) {
      void gmailApi.agentDeleteSession(target.provider, target.sessionId).catch(() => {});
    }
    setStore((s) => {
      const remaining = s.conversations.filter((c) => c.id !== id);
      const openTabs = s.tabs.filter((t) => t !== id);
      if (s.activeId !== id) return { ...s, conversations: remaining, tabs: openTabs };
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
      const fresh = newConversation(selectedKind);
      return { conversations: [fresh, ...remaining], activeId: fresh.id, tabs: [fresh.id] };
    });
  };

  const focusPanelTab = () => {
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  };
  const showPanelTab = (id: string) => {
    if (useBrowser.getState().tabs.some((tab) => tab.id === id)) selectTab(id);
    else switchTo(id);
    focusPanelTab();
  };
  const previousTab = () => {
    const s = storeRef.current;
    const browser = useBrowser.getState();
    const tabs = orderedPanelTabs(panelTabsRef.current, [
      ...s.tabs,
      ...(features.browser ? browser.tabs.map((tab) => tab.id) : []),
    ]);
    const shown = (features.browser ? browser.activeId : null) ?? s.activeId;
    const id = mostRecentTab(tabs, shown, recentTabsRef.current);
    if (!id) return false;
    showPanelTab(id);
    return true;
  };
  useCommandHandlers({
    "agent.newChat": () => newChat(),
    "agent.previousTab": (event) => {
      if (!(event.target instanceof Node) || !panelRef.current?.contains(event.target))
        return false;
      return previousTab();
    },
  });
  useEffect(() => {
    if (!features.browser) return;
    return window.desktopBridge.on("browser:previousTab", previousTab);
  });

  const closeActiveTab = () => {
    const page = useBrowser.getState().activeId;
    if (features.browser && page) {
      closeTab(page);
      return true;
    }
    closeTab(storeRef.current.activeId);
    return true;
  };
  useEffect(() => {
    if (!closeTabRef) return;
    closeTabRef.current = closeActiveTab;
    return () => {
      closeTabRef.current = null;
    };
  });

  // Each tab keeps its own unsent draft.
  const draftsRef = useRef<Record<string, string>>({});
  const draftRef = useLatest(draft);
  const shownIdRef = useRef(activeId);
  useEffect(() => {
    const prev = shownIdRef.current;
    if (prev === activeId) return;
    draftsRef.current[prev] = draftRef.current;
    setDraft(draftsRef.current[activeId] ?? "");
    setActiveSkill(null);
    setEditing(null);
    shownIdRef.current = activeId;
  }, [activeId, draftRef]);

  useKeybindingContext("agentOpen", browserTabId === null);

  const updateSettings = (patch: AgentSettingsPatch) => {
    console.log("[AgentChat:updateSettings]", patch);
    gmailApi.updateAgentSettings(patch).then(setProvidersState, () => {});
  };

  /** Where composer menus return focus when they close. */
  const focusComposer = () => inputRef.current?.focus();

  /** A model from the picker becomes the default for its provider (and new chats). */
  const pickModel = (kind: ProviderKind, slug: string) => {
    updateSettings({ selected: kind, [kind]: { model: slug } });
  };

  /** Setup fallback: switch new chats to another provider. */
  const pickProvider = (kind: ProviderKind) => updateSettings({ selected: kind });

  // Hermes' and OpenClaw's approval modes are server-side config; Codex / Claude pick it per turn.
  const runtimeMode =
    providerKind === "hermes" || providerKind === "openclaw"
      ? null
      : (providersState?.settings[providerKind].runtimeMode ?? null);
  const pendingApproval = activeApprovals[0];

  // Reasoning / Service Tier of the model in use, with the saved choices.
  const currentModel = provider?.models.find((m) => m.slug === provider.model);
  const traitOptions = currentModel?.options ?? [];
  // OpenClaw's agents bring their own model settings.
  const traitSettings =
    providerKind === "openclaw" ? undefined : providersState?.settings[providerKind];
  const traitValues = {
    reasoningEffort: traitSettings?.reasoningEffort ?? "",
    serviceTier: traitSettings?.serviceTier ?? "",
  };

  // An empty chat whose provider can't run yet shows setup instead of a composer.
  const needsSetup = Boolean(providersState) && !usable && turns.length === 0;
  const setupSummary = providerSummary(provider);
  const fallback = providersState?.providers.find(
    (p) => p.kind !== providerKind && isProviderUsable(p) && p.checkedAt !== null,
  );

  // An empty chat shows a centered headline above the pinned composer (Codex).
  const hero = turns.length === 0 && hydrating !== activeId;
  const heroHeadline = quote
    ? "What should we do with this excerpt?"
    : projectOnly && project
      ? `What should we do for “${clampTitle(project.name)}”?`
      : multiSelected
        ? `What should we do with these ${selectedRows.length} conversations?`
        : openMessage.data
          ? `What should we do with “${clampTitle(openMessage.data.subject || "this conversation")}”?`
          : "What should we do in your inbox?";

  // Send button (Otter Code's ComposerPrimaryActions): queue vs steer while a
  // turn runs; holding ⌘ flips it for one message.
  const hasDraft = Boolean(draft.trim() || activeSkill || files.count > 0);
  const alternateAction = followUp === "queue" ? "steer" : "queue";
  const submitMode: "send" | "queue" | "steer" = run
    ? modHeld
      ? alternateAction
      : followUp
    : "send";
  const submitLabel = editing
    ? "Update queued message"
    : submitMode === "queue"
      ? "Queue message"
      : submitMode === "steer"
        ? "Steer message"
        : "Send message";
  const submitTooltip =
    submitMode === "send" || editing
      ? submitLabel
      : `Click to ${followUp}, ${modKeyName}-click or ${shortcutText("mod+enter")} to ${alternateAction}`;

  // Only the active conversation drives the "working…" / stop UI.
  const streamingActive = run != null;
  const busy = run != null;

  return (
    <div
      ref={panelRef}
      className="relative flex h-full min-w-0 flex-col"
      {...(needsSetup ? {} : drop.handlers)}
    >
      {drop.active ? <DropOverlay /> : null}
      {/* Header: chat actions on the left; the panel toggle stays at the
          window's top-right, exactly where it sits while the panel is closed. */}
      <div
        className={cn(
          "drag-region flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 px-3",
          // Filling the window, the strip starts by the traffic lights (with none,
          // a browser tab's or Linux's, it keeps its own inset).
          expanded &&
            "pl-[max(--spacing(3),calc(var(--workspace-controls-left)-var(--workspace-rail-width)))]",
        )}
      >
        <AgentTabs
          tabs={panelTabs.map((id) => {
            const page = features.browser ? browserTabs.find((tab) => tab.id === id) : null;
            if (page) return page;
            const convo = conversations.find((c) => c.id === id);
            const tabRun = runs[id];
            return {
              id,
              title: convo && convo.turns.length > 0 ? convo.title : "New chat",
              state: tabRun
                ? approvals.some((a) => a.requestId === tabRun.requestId)
                  ? "approval"
                  : "working"
                : unseen.has(id)
                  ? "unseen"
                  : "idle",
            };
          })}
          activeId={browserTabId ?? activeId}
          onSelect={showPanelTab}
          onClose={closeTab}
          onReorder={setTabOrder}
        />
        {/* Right after the tabs, like a browser's new-tab button: with the
            browser, its start page (which offers a new chat too). */}
        {features.browser ? (
          <HintTooltip label="New tab" shortcut="agent.newTab" side="bottom">
            <IconBtn label="New tab" className="size-8 shrink-0" onClick={newTab}>
              <PlusIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        ) : (
          <HintTooltip label="New chat" shortcut="agent.newChat" side="bottom">
            <IconBtn label="New chat" className="size-8 shrink-0" onClick={() => newChat()}>
              <PlusIcon className="size-4" />
            </IconBtn>
          </HintTooltip>
        )}
        <span className="min-w-0 flex-1" />
        <HintTooltip label="Chat history" side="bottom">
          <IconBtn
            label="Chat history"
            active={historyOpen}
            className="size-8 shrink-0"
            onClick={() => setHistoryOpen((o) => !o)}
          >
            <HistoryIcon className="size-4" />
          </IconBtn>
        </HintTooltip>
        {onToggleExpanded ? (
          <HintTooltip
            label={expanded ? "Collapse panel" : "Expand panel"}
            shortcut="agent.toggleExpanded"
            side="bottom"
          >
            <IconBtn
              label={expanded ? "Collapse panel" : "Expand panel"}
              active={expanded}
              className="size-8 shrink-0"
              onClick={onToggleExpanded}
            >
              {expanded ? (
                <Minimize2Icon className="size-4" />
              ) : (
                <Maximize2Icon className="size-4" />
              )}
            </IconBtn>
          </HintTooltip>
        ) : null}
        {/* The pinned agent toggle (home view) sits here. */}
        <PanelControlSlot />
      </div>

      {features.browser ? <BrowserPages onNewChat={newChat} /> : null}

      {historyOpen ? (
        <HistoryList
          conversations={conversations}
          activeId={activeId}
          onPick={switchTo}
          onDelete={deleteConversation}
          onClose={() => setHistoryOpen(false)}
          serverSessions={
            sessionsAvailable && serverSessionsQuery.data
              ? serverSessionsQuery.data.filter(
                  (s) => s.messageCount > 0 && !conversations.some((c) => c.sessionId === s.id),
                )
              : undefined
          }
          serverLoading={sessionsAvailable && serverSessionsQuery.isPending}
          onPickServer={openServerSession}
          providerName={providerName}
        />
      ) : null}

      {needsSetup ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <ProviderIcon kind={providerKind} className="mb-1 size-6" />
          <span className="text-sm font-medium text-foreground">
            {providerName}: {setupSummary.headline}
          </span>
          {setupSummary.detail ? (
            <span className="text-sm text-muted-foreground">{setupSummary.detail}</span>
          ) : null}
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void gmailApi.openSettings({ pane: "agents" })}
              className={buttonClass("outline", "sm")}
            >
              Open Settings
            </button>
            {fallback ? (
              <button
                type="button"
                onClick={() => pickProvider(fallback.kind)}
                className={buttonClass("ghost", "sm")}
              >
                Use {fallback.displayName}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <MessageScroller.Provider autoScroll defaultScrollPosition="end">
          <MessageScroller.Root className="relative min-h-0 flex-1">
            <ScrollArea
              className="h-full"
              viewportClassName="topbar-scroll-fade px-3 pb-3 pt-(--workspace-titlebar-scroll-fade-height)"
              render={<MessageScroller.Viewport />}
            >
              <MessageScroller.Content className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-2">
                {turns.length === 0 && hydrating === activeId ? (
                  <div className="px-2 pt-6 text-center text-sm text-placeholder">
                    Loading this session from {providerName}…
                  </div>
                ) : null}
                {turns.map((turn) => {
                  if (turn.role === "user") {
                    return (
                      <MessageScroller.Item key={turn.id} messageId={turn.id} scrollAnchor>
                        <div className="group flex flex-col items-end gap-1 py-3">
                          {turn.intent ? <IntentMarker intent={turn.intent} /> : null}
                          {turn.context ? <ContextRecap context={turn.context} /> : null}
                          <div className="relative max-w-[80%] select-text whitespace-pre-wrap rounded-2xl bg-message px-4 py-2.5 text-sm leading-relaxed text-message-foreground">
                            {turn.skill ? (
                              <span className="mb-1 mr-1.5 inline-flex align-middle">
                                <SkillBadge name={turn.skill} onAccent />
                              </span>
                            ) : null}
                            {turn.attachments ? (
                              <SentAttachments attachments={turn.attachments} />
                            ) : null}
                            {turn.text}
                          </div>
                          {turn.text ? <CopyMessageButton text={turn.text} /> : null}
                        </div>
                      </MessageScroller.Item>
                    );
                  }
                  const isLast = turn.id === turns[turns.length - 1]?.id;
                  const live = streamingActive && isLast && !turn.finishedAt && !turn.error;
                  // ChatGPT's fold: the commentary and steps up to the last step
                  // fold away once the turn is done; the answer after them stays.
                  const items = itemsOf(turn).filter(
                    (item) => item.kind === "step" || item.text.trim(),
                  );
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
                        {showWork ? <WorkLog items={work} /> : null}
                        {answer ? (
                          <div className="group min-w-0 px-1 py-2">
                            <ChatMarkdown text={answer} />
                            {!live ? (
                              <div className="mt-1">
                                <CopyMessageButton text={answer} />
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {live ? <WorkingRow startedAt={turn.startedAt} /> : null}
                        {turn.error ? (
                          <ErrorRow message={turn.error} providerName={providerName} />
                        ) : null}
                        {!live && turn.changes?.length ? (
                          <ChatChanges changes={turn.changes} onOpen={onOpenChange} />
                        ) : null}
                      </div>
                    </MessageScroller.Item>
                  );
                })}
              </MessageScroller.Content>
            </ScrollArea>
            <MessageScroller.Button
              direction="end"
              render={(props, state) =>
                state.active ? (
                  <button
                    {...props}
                    type="button"
                    aria-label="Jump to latest"
                    className="surface-glass absolute bottom-3 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border/40 text-muted-foreground shadow-sm hover:text-foreground"
                  >
                    <ArrowDownIcon className="size-3.5" />
                  </button>
                ) : null
              }
            />
            {/* An empty chat shows its headline in the middle of the column. */}
            {hero ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
                <MailIcon
                  aria-hidden
                  strokeWidth={1.25}
                  className="size-10 text-muted-foreground"
                />
                <h1 className="w-full max-w-3xl text-balance text-center text-2xl font-normal tracking-tight text-foreground">
                  {heroHeadline}
                </h1>
              </div>
            ) : null}
          </MessageScroller.Root>

          {/* Composer: glass card with the prompt on top and controls below,
              pinned to the bottom like Codex's. */}
          <div className="relative shrink-0 px-3 pb-3 pt-1">
            <div className="relative mx-auto w-full max-w-3xl">
              {slashOpen ? (
                <div className="dropdown-glass absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-xl p-1.5 shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)] dark:shadow-[0_18px_44px_-18px_rgb(0_0_0/80%)]">
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    Skills
                  </div>
                  {slashSkills.map((s, i) => (
                    <button
                      key={s.name}
                      type="button"
                      ref={i === slashIndex ? slashItemRef : undefined}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pickSkill(s);
                      }}
                      onMouseEnter={() => setSlashIndex(i)}
                      className={cn(
                        "flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left",
                        i === slashIndex && "bg-accent-surface",
                      )}
                    >
                      <span className="text-sm font-medium text-foreground">/{s.name}</span>
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {s.description}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <QueuedRunsControl
                items={activeQueue}
                editingId={editing?.id ?? null}
                canSteer={canSteer}
                onEdit={editQueued}
                onCancelEdit={cancelQueuedEdit}
                onSteer={steerQueued}
                onRemove={removeQueued}
                onMove={moveQueued}
              />
              {pendingApproval && streamingActive ? (
                <ApprovalCard
                  key={pendingApproval.approval.id}
                  agent={providerName}
                  approval={pendingApproval.approval}
                  pendingCount={activeApprovals.length}
                  responding={respondingApproval === pendingApproval.approval.id}
                  onRespond={(decision) => respondApproval(pendingApproval.approval.id, decision)}
                  onCancel={stop}
                />
              ) : (
                <div className={cn("relative", COMPOSER_SURFACE)}>
                  <ComposerAttachments items={files.items} onRemove={files.remove}>
                    {/* The mail this message is about; click to leave it out. */}
                    {context ? (
                      <AttachmentChip
                        name={
                          quote
                            ? `“${quote.text}”`
                            : projectOnly && project
                              ? project.name
                              : context.conversations.length > 1
                                ? `${context.conversations.length} conversations`
                                : context.conversations[0].subject || "(no subject)"
                        }
                        detail={
                          quote
                            ? "Quote"
                            : projectOnly
                              ? "Project"
                              : context.conversations.length > 1
                                ? context.conversations
                                    .slice(0, 3)
                                    .map((c) => c.subject || "(no subject)")
                                    .join(" · ")
                                : context.conversations[0].from
                        }
                        title={attach ? "Attached to this message" : "Not attached"}
                        tile={<ContextKindIcon kind={attachKind} />}
                        off={!attach}
                        onClick={() => setAttach((a) => !a)}
                      />
                    ) : null}
                  </ComposerAttachments>
                  {activeSkill ? (
                    <div className="px-4 pt-3">
                      <SkillBadge name={activeSkill.name} onRemove={() => setActiveSkill(null)} />
                    </div>
                  ) : null}
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => handleDraftChange(e.target.value)}
                    onPaste={(e) => {
                      const pasted = filesFromPaste(e.clipboardData);
                      if (pasted.length === 0) return;
                      e.preventDefault();
                      void files.add(pasted);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Backspace" && draft === "" && activeSkill && !slashOpen) {
                        e.preventDefault();
                        setActiveSkill(null);
                        return;
                      }
                      if (slashOpen) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setSlashIndex((i) => Math.min(slashSkills.length - 1, i + 1));
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashIndex((i) => Math.max(0, i - 1));
                          return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          pickSkill(slashSkills[slashIndex]);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setSlashDismissed(true);
                          return;
                        }
                      }
                      if (e.key === "Escape" && editing) {
                        e.preventDefault();
                        cancelQueuedEdit();
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        send(e.metaKey || e.ctrlKey);
                      }
                    }}
                    placeholder="Ask anything, / for skills"
                    aria-label={`Message ${providerName}`}
                    rows={2}
                    className="w-full resize-none bg-transparent px-4.5 pb-1 pt-4 text-sm leading-relaxed text-foreground outline-none placeholder:text-placeholder"
                  />
                  <div className="flex min-w-0 items-center gap-1 px-3 pb-3">
                    <HintTooltip label="Attach files">
                      <IconBtn
                        label="Attach files"
                        className="-ms-0.5 size-8 rounded-full"
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => filePickerRef.current?.click()}
                      >
                        <PlusIcon className="size-4.5" />
                      </IconBtn>
                    </HintTooltip>
                    <input
                      ref={filePickerRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const picked = Array.from(e.currentTarget.files ?? []);
                        e.currentTarget.value = "";
                        void files.add(picked);
                        focusComposer();
                      }}
                    />
                    <div className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      {runtimeMode ? (
                        <RuntimeModePicker
                          returnFocus={focusComposer}
                          value={runtimeMode}
                          onChange={(mode) => {
                            updateSettings({
                              [providerKind]: { runtimeMode: mode },
                            });
                          }}
                        />
                      ) : null}
                    </div>
                    {/* Codex's "Model Effort ⌄": the model reads as plain text,
                        the traits follow it muted and carry the chevron, and
                        one pill wraps both, as a single control. */}
                    <div className="ms-auto flex min-w-0 shrink items-center rounded-full hover:bg-accent-surface has-[[data-state=open]]:bg-accent-surface">
                      <ProviderModelPicker
                        providers={providersState?.providers ?? []}
                        activeKind={providerKind}
                        lockedKind={active && active.turns.length > 0 ? active.provider : null}
                        onPick={pickModel}
                        returnFocus={focusComposer}
                        chevron={traitOptions.length === 0}
                        className={cn(
                          "hover:bg-transparent data-[state=open]:bg-transparent",
                          traitOptions.length > 0 && "pe-1",
                        )}
                      />
                      {traitOptions.length > 0 ? (
                        <TraitsPicker
                          returnFocus={focusComposer}
                          options={traitOptions}
                          values={traitValues}
                          className="shrink-0 ps-1 hover:bg-transparent data-[state=open]:bg-transparent"
                          onChange={(id, value) => {
                            updateSettings({ [providerKind]: { [id]: value } });
                          }}
                        />
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center">
                      {/* Running + empty composer → Stop; with a draft the button
                          queues or steers it (Otter Code's primary actions). */}
                      {busy && !hasDraft && !editing ? (
                        <HintTooltip label="Interrupt">
                          <button
                            type="button"
                            onClick={stop}
                            aria-label="Stop generation"
                            className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-2xs inset-shadow-white/16 transition-transform duration-150 hover:scale-105 hover:bg-destructive active:shadow-none active:inset-shadow-black/8"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="currentColor"
                              aria-hidden
                            >
                              <rect x="2" y="2" width="8" height="8" rx="1.5" />
                            </svg>
                          </button>
                        </HintTooltip>
                      ) : (
                        <HintTooltip label={submitTooltip}>
                          <button
                            type="button"
                            onClick={(e) => send(e.metaKey || e.ctrlKey)}
                            disabled={!hasDraft}
                            aria-label={submitLabel}
                            className="relative isolate flex size-8 items-center justify-center overflow-hidden rounded-full bg-primary text-primary-foreground shadow-xs transition-transform duration-150 enabled:cursor-pointer enabled:shadow-primary/24 enabled:inset-shadow-2xs enabled:inset-shadow-white/16 hover:scale-105 hover:bg-primary/90 active:shadow-none active:inset-shadow-black/8 disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none"
                          >
                            {editing ? (
                              <CheckIcon className="size-4" aria-hidden />
                            ) : submitMode === "queue" ? (
                              <ListPlusIcon className="size-4" aria-hidden />
                            ) : submitMode === "steer" ? (
                              <CornerUpRightIcon className="size-4" aria-hidden />
                            ) : (
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 14 14"
                                fill="none"
                                aria-hidden
                              >
                                <path
                                  d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            )}
                          </button>
                        </HintTooltip>
                      )}
                    </div>
                  </div>
                  {providerKind === "openrouter" && usable ? (
                    <div className="flex items-center justify-between gap-2 px-4 pb-3 text-xs text-muted-foreground">
                      <span>OpenRouter</span>
                      <button
                        type="button"
                        className="cursor-pointer hover:text-foreground"
                        onClick={() =>
                          void window.desktopBridge.openExternal("https://openrouter.ai/activity")
                        }
                      >
                        Manage usage
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </MessageScroller.Provider>
      )}
    </div>
  );
}
