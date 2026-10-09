/**
 * Agent provider contracts shared by the backend and (mirrored in
 * renderer/main/gmail/api.ts) the renderer. Modelled on T3 Code's provider
 * layer: a *snapshot* describes a provider's health, a *provider* runs chat
 * turns, and every provider streams the same canonical {@link ChatEvent}s.
 */

export type ProviderKind = "hermes" | "openclaw" | "openrouter" | "codex" | "claude";

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  "openrouter",
  "hermes",
  "openclaw",
  "codex",
  "claude",
];

export type ProviderState = "ready" | "warning" | "error" | "disabled";

export type ProviderAuth = {
  status: "authenticated" | "unauthenticated" | "unknown";
  /** e.g. the connected provider or the Hermes model id. */
  label?: string;
  email?: string;
};

/** One choice of a model option (a reasoning effort, a service tier). */
export type ProviderOptionChoice = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
};

/** A per-model option the composer offers, like T3's option descriptors. */
export type ProviderModelOption = {
  id: "reasoningEffort" | "serviceTier";
  label: string;
  choices: ProviderOptionChoice[];
};

export type ProviderModel = {
  slug: string;
  name: string;
  /** Upstream provider behind an aggregating agent (Hermes: "OpenRouter"). */
  subProvider?: string;
  isDefault?: boolean;
  options?: ProviderModelOption[];
};

/** Health snapshot of one provider, as shown in Settings and the composer. */
export type ProviderSnapshot = {
  kind: ProviderKind;
  displayName: string;
  enabled: boolean;
  /** The CLI could be started / the server answered. */
  installed: boolean;
  version: string | null;
  status: ProviderState;
  auth: ProviderAuth;
  /** Epoch ms of the last check; null while the first check runs. */
  checkedAt: number | null;
  message?: string;
  models: ProviderModel[];
  /** Model new turns use (settings choice, else the provider default). */
  model: string | null;
  /** Chats persist on the provider and can be listed/resumed. */
  sessions: boolean;
};

/** Everything the renderer needs for the provider picker and settings. */
export type ProvidersState = {
  providers: ProviderSnapshot[];
  /** Provider new chats start with. */
  selected: ProviderKind;
  settings: ProviderSettingsView;
};

/** T3 Code's runtime modes: how much an agent may do without asking. */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export const RUNTIME_MODES: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
];

/** How the user answers an approval: once, for the rest of the chat, always, or no. */
export type ApprovalDecision = "once" | "session" | "always" | "deny";

/** An agent asking permission mid-turn (run a command, edit files, …). */
export type ApprovalRequest = {
  id: string;
  kind: "command" | "fileChange" | "permission" | "tool";
  title: string;
  /** The command / paths / tool input, shown verbatim. */
  detail?: string;
  reason?: string;
  choices: ApprovalDecision[];
};

export type HermesSettings = {
  enabled: boolean;
  baseUrl: string;
  /** The agent's virtual model id from /v1/models (Responses API). */
  agentModel: string;
  /** Chosen `provider::model`; empty → the gateway's default model. */
  model: string;
  /** Empty → the gateway's configured default. */
  reasoningEffort: string;
  /** Empty / "default" → standard speed. */
  serviceTier: string;
  /** Whether the server exposes the native Sessions API (probed at connect). */
  sessions?: boolean;
};

export type OpenClawSettings = {
  enabled: boolean;
  /** The gateway's WebSocket, `wss://<machine>.<tailnet>.ts.net`. */
  url: string;
  /** The gateway agent new chats use; empty → its default agent. */
  model: string;
};

export type CodexSettings = {
  enabled: boolean;
  /** Empty → `codex` on the login shell's PATH. */
  binaryPath: string;
  /** Empty → Codex's default (~/.codex). */
  homePath: string;
  /** Extra arguments after `codex app-server`. */
  launchArgs: string;
  /** Empty → the model Codex marks as default. */
  model: string;
  /** Empty → the model's default effort. */
  reasoningEffort: string;
  /** Empty / "default" → standard speed. */
  serviceTier: string;
  runtimeMode: RuntimeMode;
};

export type ClaudeSettings = {
  enabled: boolean;
  /** Empty → `claude` on the login shell's PATH. */
  binaryPath: string;
  /** Empty → Claude's default config dir (CLAUDE_CONFIG_DIR). */
  homePath: string;
  /** Empty → Claude Code's default model. */
  model: string;
  /** Empty → the model's default effort. */
  reasoningEffort: string;
  /** "fast" → fast mode; empty / "default" → standard. */
  serviceTier: string;
  runtimeMode: RuntimeMode;
};

export type OpenRouterSettings = {
  enabled: boolean;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  runtimeMode: RuntimeMode;
};

export type ProviderSettings = {
  selected: ProviderKind;
  hermes: HermesSettings;
  openclaw: OpenClawSettings;
  codex: CodexSettings;
  claude: ClaudeSettings;
  openrouter: OpenRouterSettings;
};

/** Settings as the renderer sees them: Hermes' key and OpenClaw's token never leave the backend. */
export type ProviderSettingsView = ProviderSettings & {
  hermesHasKey: boolean;
  openclawHasToken: boolean;
  /** The pairing request this device waits on (`openclaw devices approve <id>`). */
  openclawPairingRequest: string | null;
};

/**
 * One step an agent took, described the same way whichever agent took it
 * (steps.ts), like Otter Code's canonical tool items: the chat shows
 * `title`, groups a `source`'s steps, and opens to `detail` and the output.
 */
export type ToolStep = {
  kind: "command" | "read" | "edit" | "search" | "web" | "skill" | "tool";
  /** What it did, in words: "Search mail", "Read Chris Google Accounts skill", "Ran git status". */
  title: string;
  /** Its input: the command, the path, the arguments as JSON. */
  detail?: string;
  /** The integration (MCP server) it came from: "Otter Mail", "Linear". */
  source?: string;
};

/** Canonical stream events, one contract for every provider. */
export type ChatEvent =
  | { requestId: string; type: "session"; sessionId: string }
  | { requestId: string; type: "delta"; text: string }
  /** `id` pairs a step with its result. */
  | { requestId: string; type: "tool"; id?: string; step: ToolStep }
  | { requestId: string; type: "toolResult"; id?: string; output: string }
  | { requestId: string; type: "change"; change: import("@otter-mail/contracts").ChatChange }
  | { requestId: string; type: "approval"; approval: ApprovalRequest }
  | { requestId: string; type: "approvalResolved"; approvalId: string }
  /** A steer the agent didn't get to before finishing: send it as the next message. */
  | { requestId: string; type: "steerReturned"; text: string }
  | { requestId: string; type: "done"; responseId: string | null }
  | { requestId: string; type: "error"; message: string };

export type Emit = (event: ChatEvent) => void;

export type Skill = {
  name: string;
  description: string;
  category: string | null;
  /** Codex invokes skills by path. */
  path?: string;
};

/** A persisted provider-side chat (Hermes session / Codex thread). */
export type ChatSession = {
  id: string;
  title: string | null;
  source: string;
  /** Epoch ms. */
  lastActive: number;
  messageCount: number;
  preview: string | null;
};

/** One transcript row of a session, flattened for the panel. */
export type ChatSessionMessage = {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  toolCalls?: ToolStep[];
};

/** A file attached to a turn, staged in the app's assistant-attachments folder. */
export type ChatAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** The staged copy, in the app's files (`assistant-attachments/…`). */
  path: string;
  kind: "image" | "file";
};

export type SendTurnInput = {
  requestId: string;
  input: string;
  /** Provider-side session to continue; omitted → the provider starts one and emits `session`. */
  sessionId?: string;
  /** Title for a new session. */
  title?: string;
  skill?: { name: string; path?: string };
  attachments?: ChatAttachment[];
  /** Hermes legacy chats: chain via the Responses API. */
  previousResponseId?: string;
};

/**
 * One provider. `checkStatus` probes health; the session methods exist only
 * when the provider keeps chats server-side.
 */
export interface ChatProvider {
  readonly kind: ProviderKind;
  readonly displayName: string;
  checkStatus(settings: ProviderSettings): Promise<Omit<ProviderSnapshot, "checkedAt" | "enabled">>;
  /** Runs one turn to completion, reporting progress through `emit`. */
  sendTurn(input: SendTurnInput, settings: ProviderSettings, emit: Emit): Promise<void>;
  cancel(requestId: string): void;
  /** Adds a message to the running turn; false when it can't (then queue it). */
  steer(requestId: string, input: string): Promise<boolean>;
  /** Answers an approval the turn is waiting on. */
  respondApproval(requestId: string, approvalId: string, decision: ApprovalDecision): Promise<void>;
  listSkills(settings: ProviderSettings): Promise<Skill[]>;
  listSessions(settings: ProviderSettings, limit: number): Promise<ChatSession[]>;
  readSession(settings: ProviderSettings, sessionId: string): Promise<ChatSessionMessage[]>;
  deleteSession(settings: ProviderSettings, sessionId: string): Promise<void>;
  /** Stop background processes (settings changed, app quitting). */
  shutdown(): void;
}
