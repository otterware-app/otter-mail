import { ipc, task } from "~/lib/ipc";
import type { ImapSettings } from "@otter-mail/contracts";
import type { NotificationConnection } from "@otter-mail/contracts/relay";
export type { ChatChange } from "@otter-mail/contracts";
import type { AgentAccess, AgentTokens, ConnectedAgent } from "@otter-mail/contracts/agent-tokens";
import type { OpenRouterConnection } from "@otter-mail/contracts/openrouter";
import type {
  ComposeAttachment,
  ContactSuggestion,
  GmailAccount,
  GmailLabel,
  GmailMessageSummary,
  GmailMessageDetail,
  MailView,
  SyncStatus,
  ViewRule,
} from "./types";

export type ListMessagesParams = {
  accountId: string;
  labelIds?: string[];
  pageToken?: string;
  maxResults?: number;
};

export type ListMessagesResult = {
  messages: GmailMessageSummary[];
  nextPageToken?: string;
};

export type SearchMessagesParams = {
  /** May be empty when structured filters are set. */
  q: string;
  /** Omit to search every account (Combined mode / command palette). */
  accountId?: string;
  /** Restrict to messages carrying this label (view filter, account mode). */
  labelId?: string;
  /** Restrict to messages matching these rules (view filter, Combined mode). */
  rules?: ViewRule[];
  starred?: boolean;
  important?: boolean;
  hasAttachments?: boolean;
  /** Only messages newer than N days. */
  withinDays?: number;
  pageToken?: string;
  maxResults?: number;
};

export type ListCombinedMessagesParams = {
  rules: ViewRule[];
  pageToken?: string;
  maxResults?: number;
};

export type CombinedCounts = { total: number; unread: number };

export type RsvpResponse = "accepted" | "declined" | "tentative";

/** A calendar invitation found in a message (from its .ics). */
export type CalendarInvite = {
  uid: string;
  method: string;
  summary: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: { name: string; email: string } | null;
  sequence: number;
  response: RsvpResponse | "needsAction";
  /** False: this account hasn't granted calendar access (replies go by email). */
  calendarAccess: boolean;
  htmlLink: string | null;
  cancelled: boolean;
};

/** One page of Gmail's own search (conversation rows, newest first). */
export type GmailSearchResult = {
  messages: GmailMessageSummary[];
  /** Per-account cursors for the next page; undefined = no more results. */
  cursors?: Record<string, string | null>;
  /** Gmail's estimate of the total number of matches. */
  estimate: number;
  /** Gmail was unreachable: local results only. */
  offline?: boolean;
};

/** Parsed mailto: link, delivered when OtterMail is the default mail app. */
export type MailtoTarget = { to: string; cc: string; subject: string; body: string };

/**
 * An installed mailto: handler (Settings default-mail dropdown), by id: its
 * bundle identifier on macOS, its .desktop file on Linux.
 */
export type MailApp = { id: string; name: string; path: string };
export type MailAppsResult = { apps: MailApp[]; defaultId: string | null };

/*
 * Agent providers (mirrors main/services/agent/types.ts). A snapshot
 * is one provider's health; every provider streams the same ChatEvents.
 */
export type ProviderKind = "hermes" | "openclaw" | "openrouter" | "codex" | "claude";
export type ProviderState = "ready" | "warning" | "error" | "disabled";
export type ProviderOptionChoice = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
};
/** A per-model option (Codex: Reasoning, Service Tier), like T3's option descriptors. */
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
export type ProviderSnapshot = {
  kind: ProviderKind;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  status: ProviderState;
  auth: {
    status: "authenticated" | "unauthenticated" | "unknown";
    label?: string;
    email?: string;
  };
  /** Epoch ms of the last check; null while the first check runs. */
  checkedAt: number | null;
  message?: string;
  models: ProviderModel[];
  model: string | null;
  /** Chats persist on the provider and can be listed/resumed. */
  sessions: boolean;
};
/** T3 Code's runtime modes: how much an agent may do without asking. */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "full-access";

export type ApprovalDecision = "once" | "session" | "always" | "deny";

/** An agent asking permission mid-turn (run a command, edit files, …). */
export type ApprovalRequest = {
  id: string;
  kind: "command" | "fileChange" | "permission" | "tool";
  title: string;
  detail?: string;
  reason?: string;
  choices: ApprovalDecision[];
};
export type ProviderSettingsView = {
  selected: ProviderKind;
  openrouter: {
    enabled: boolean;
    model: string;
    reasoningEffort: string;
    serviceTier: string;
    runtimeMode: RuntimeMode;
  };
  hermes: {
    enabled: boolean;
    baseUrl: string;
    agentModel: string;
    /** `provider::model`; empty → the gateway default. */
    model: string;
    reasoningEffort: string;
    serviceTier: string;
    sessions?: boolean;
  };
  openclaw: {
    enabled: boolean;
    /** The gateway's WebSocket, `wss://<computer>.<tailnet>.ts.net`. */
    url: string;
    /** The gateway agent new chats use; empty → its default agent. */
    model: string;
  };
  claude: {
    enabled: boolean;
    binaryPath: string;
    homePath: string;
    model: string;
    reasoningEffort: string;
    serviceTier: string;
    runtimeMode: RuntimeMode;
  };
  codex: {
    enabled: boolean;
    binaryPath: string;
    homePath: string;
    launchArgs: string;
    model: string;
    reasoningEffort: string;
    serviceTier: string;
    runtimeMode: RuntimeMode;
  };
  hermesHasKey: boolean;
  openclawHasToken: boolean;
  /** The pairing request this device waits on (`openclaw devices approve <id>`). */
  openclawPairingRequest: string | null;
};
export type ProvidersState = {
  providers: ProviderSnapshot[];
  selected: ProviderKind;
  settings: ProviderSettingsView;
};
export type AgentSettingsPatch = {
  selected?: ProviderKind;
  hermes?: { enabled?: boolean; model?: string; reasoningEffort?: string; serviceTier?: string };
  openclaw?: { enabled?: boolean; model?: string };
  codex?: Partial<ProviderSettingsView["codex"]>;
  claude?: Partial<ProviderSettingsView["claude"]>;
  openrouter?: Partial<ProviderSettingsView["openrouter"]>;
};

/** One step an agent took, the same for every agent (core's steps.ts). */
export type ToolStep = {
  kind: "command" | "read" | "edit" | "search" | "web" | "skill" | "tool";
  title: string;
  /** Its input: the command, the path, the arguments as JSON. */
  detail?: string;
  /** The integration it came from: "Otter Mail". */
  source?: string;
};

export type ChatEvent =
  | { requestId: string; type: "session"; sessionId: string }
  | { requestId: string; type: "delta"; text: string }
  | { requestId: string; type: "tool"; id?: string; step: ToolStep }
  | { requestId: string; type: "toolResult"; id?: string; output: string }
  | { requestId: string; type: "change"; change: import("@otter-mail/contracts").ChatChange }
  | { requestId: string; type: "approval"; approval: ApprovalRequest }
  | { requestId: string; type: "approvalResolved"; approvalId: string }
  | { requestId: string; type: "steerReturned"; text: string }
  | { requestId: string; type: "done"; responseId: string | null }
  | { requestId: string; type: "error"; message: string };

/** A file attached to an agent turn (staged by the backend). */
export type ChatAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
  kind: "image" | "file";
};

/** An installed agent skill, for the composer's "/" picker. */
export type Skill = { name: string; description: string; category: string | null; path?: string };

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

/** One stored session message, flattened for the transcript. */
export type ChatSessionMessage = {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolName?: string;
  toolCalls?: ToolStep[];
};

export type ModifyMessageParams = {
  accountId: string;
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

export type ModifyThreadParams = {
  accountId: string;
  threadId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
};

export type SendMessageParams = {
  scheduledAt?: number;
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** HTML alternative body — sent as multipart/alternative when present. */
  bodyHtml?: string;
  /** Threads the sent message into an existing conversation (replies). */
  threadId?: string;
  /** Original message a reply targets; backend resolves In-Reply-To/References. */
  replyToMessageId?: string;
  attachments?: ComposeAttachment[];
};

export type SaveDraftParams = {
  accountId: string;
  draftId?: string;
  /** Stable per composer: the backend serializes its saves and remembers its
      draft id, so a timed-out first save never leads to a duplicate draft. */
  sessionKey?: string;
  /** The draft version this edit is based on: the backend refuses to
      overwrite a newer one (changed elsewhere) and reports a conflict. */
  expectMessageId?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  bodyHtml?: string;
  threadId?: string;
  attachments?: ComposeAttachment[];
};

export type SaveDraftResult =
  | { draftId: string; messageId?: string; threadId?: string }
  /** Edited elsewhere since `expectMessageId`: nothing was saved. */
  | { conflict: true; draftId: string; messageId: string }
  /** Sent or deleted elsewhere: nothing was saved. */
  | { gone: true; draftId: string };

export type GetAttachmentParams = {
  accountId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
};

/** `saved` is false when the save dialog was cancelled. */
export type GetAttachmentResult = { saved: boolean };

export type GetAttachmentDataParams = {
  accountId: string;
  messageId: string;
  attachmentId: string;
};

export type PickAttachmentsResult = { attachments: ComposeAttachment[]; error?: string };

export type AttachmentFileParams = {
  accountId: string;
  messageId: string;
  attachmentId: string;
  filename: string;
};

export type UpdateAccountParams = {
  accountId: string;
  displayName?: string;
  color?: string;
  signature?: string;
};

export type NotificationsMode = "off" | "inbox" | "all";

export type SyncSettings = {
  syncIntervalSeconds: number;
  notificationsMode: NotificationsMode;
  launchAtLogin: boolean;
  dockBadgeEnabled: boolean;
};

export type TranslationSettings = {
  /** Languages the user reads; empty until set (system languages apply). */
  readLanguages: string[];
  autoTranslate: boolean;
};

export type TranslationStatus =
  | "ok"
  | "notInstalled"
  | "needsDownload"
  | "unsupported"
  | "unavailable";

export type SaveViewParams = {
  id?: string;
  name: string;
  rules: ViewRule[];
  mailbox?: string;
  icon?: string | null;
  color?: string | null;
};

export type SettingsPane =
  | "general"
  | "appearance"
  | "keybindings"
  | "accounts"
  | "agents"
  /** The agent panel's browser (Mac): links, extensions, browsing data. */
  | "browser"
  | "integrations"
  /** The Otter account page, opened from the user button at the bottom of the nav. */
  | "otter";
/** No pane: the one Settings was last on. */
export type SettingsTarget = { pane?: SettingsPane };

export type AddImapAccountParams = {
  email: string;
  name?: string;
  password: string;
  imap: ImapSettings;
};

export const gmailApi = {
  notificationConnections: (): Promise<{
    connections: NotificationConnection[];
    providers: Record<string, boolean>;
  }> => ipc("otter:notificationConnections"),
  connectNotifications: (accountId: string): Promise<{ url: string } | { connected: true }> =>
    ipc("otter:connectNotifications", { accountId }),
  disconnectNotifications: (accountId: string): Promise<void> =>
    ipc("otter:disconnectNotifications", { accountId }),
  saveSupportReport: (contents: string, filename?: "Otter Mail diagnostics.json") =>
    task<boolean>("support:saveReport", { contents, filename }),
  listAccounts: (): Promise<GmailAccount[]> => ipc("gmail:listAccounts"),

  /** Browser sign-in; `email` signs an existing account back in. */
  /** Resolves null when the sign-in was cancelled. */
  addAccount: (email?: string): Promise<GmailAccount | null> =>
    ipc("gmail:addAccount", email ? { email } : undefined),
  /** Re-reads every account's signature from Gmail (answers at once; accounts-changed follows). */
  refreshSignatures: (): Promise<void> => ipc("gmail:refreshSignatures"),
  /** Stops waiting for the browser sign-in; the pending addAccount resolves null. */
  cancelAddAccount: (): Promise<void> => ipc("gmail:cancelAddAccount"),
  /** Microsoft's sign-in in the browser; `email` signs an Outlook mailbox back in. Null: cancelled. */
  addOutlookAccount: (email?: string): Promise<GmailAccount | null> =>
    ipc("gmail:addOutlookAccount", email ? { email } : undefined),
  /** Which kinds of mailbox this app can add besides Gmail and IMAP. */
  mailProviders: (): Promise<{ outlook: boolean }> => ipc("gmail:mailProviders"),

  /** The servers an address's mail lives on, from its domain; null when unknown. */
  discoverImap: (email: string): Promise<ImapSettings | null> =>
    ipc("gmail:discoverImap", { email }),
  /** Adds an IMAP mailbox once its login and SMTP work; rejects with a readable message. */
  addImapAccount: (params: AddImapAccountParams): Promise<GmailAccount> =>
    ipc("gmail:addImapAccount", params),
  /** Signs an IMAP mailbox in on this device (its password never syncs). */
  signInImap: (accountId: string, password: string): Promise<void> =>
    ipc("gmail:signInImap", { accountId, password }),

  removeAccount: (accountId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:removeAccount", { accountId }),

  updateAccount: (params: UpdateAccountParams): Promise<GmailAccount> =>
    ipc("gmail:updateAccount", params),

  listLabels: (accountId: string): Promise<GmailLabel[]> => ipc("gmail:listLabels", { accountId }),

  createLabel: (accountId: string, name: string): Promise<GmailLabel> =>
    ipc("gmail:createLabel", { accountId, name }),

  updateLabel: (params: {
    accountId: string;
    labelId: string;
    name?: string;
    color?: { backgroundColor: string; textColor: string };
  }): Promise<{ ok: boolean }> => ipc("gmail:updateLabel", params),

  deleteLabel: (accountId: string, labelId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:deleteLabel", { accountId, labelId }),

  listMessages: (params: ListMessagesParams): Promise<ListMessagesResult> =>
    ipc("gmail:listMessages", params),

  listCombinedMessages: (params: ListCombinedMessagesParams): Promise<ListMessagesResult> =>
    ipc("gmail:listCombinedMessages", params),

  /** How this message offers unsubscribing (List-Unsubscribe), or null. */
  getUnsubscribe: (
    accountId: string,
    messageId: string,
    fromEmail: string,
  ): Promise<{
    method: "oneClick" | "mailto" | "web";
    target: string;
    unsubscribed: boolean;
  } | null> => ipc("gmail:getUnsubscribe", { accountId, messageId, fromEmail }),

  /** Unsubscribes in place, or returns the page to open (web-only lists). */
  unsubscribe: (
    accountId: string,
    messageId: string,
  ): Promise<{ done: true } | { openUrl: string }> =>
    task("gmail:unsubscribe", { accountId, messageId }),

  /** The calendar invitation in a message, with your current answer (null: none). */
  getCalendarInvite: (accountId: string, messageId: string): Promise<CalendarInvite | null> =>
    task("calendar:getInvite", { accountId, messageId }),

  /** RSVP to an invitation (Calendar API, or an email reply to the organizer). */
  respondToInvite: (
    accountId: string,
    messageId: string,
    response: RsvpResponse,
  ): Promise<CalendarInvite | null> => task("calendar:respond", { accountId, messageId, response }),

  /** Gmail's own search (all operators, all mail) across the given accounts. */
  gmailSearch: (params: {
    q: string;
    accountIds: string[];
    cursors?: Record<string, string | null>;
  }): Promise<GmailSearchResult> => task("gmail:search", params),

  searchMessages: (params: SearchMessagesParams): Promise<ListMessagesResult> =>
    ipc("gmail:searchMessages", params),

  countCombinedMessages: (params: { rules: ViewRule[] }): Promise<CombinedCounts> =>
    ipc("gmail:countCombinedMessages", params),

  getMessage: (accountId: string, messageId: string): Promise<GmailMessageDetail> =>
    ipc("gmail:getMessage", { accountId, messageId }),

  modifyMessage: (params: ModifyMessageParams): Promise<{ ok: boolean }> =>
    ipc("gmail:modifyMessage", params),

  trashMessage: (accountId: string, messageId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:trashMessage", { accountId, messageId }),

  getThread: (accountId: string, threadId: string): Promise<GmailMessageSummary[]> =>
    ipc("gmail:getThread", { accountId, threadId }),

  modifyThread: (params: ModifyThreadParams): Promise<{ ok: boolean }> =>
    ipc("gmail:modifyThread", params),

  trashThread: (accountId: string, threadId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:trashThread", { accountId, threadId }),

  untrashThread: (accountId: string, threadId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:untrashThread", { accountId, threadId }),

  untrashMessage: (accountId: string, messageId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:untrashMessage", { accountId, messageId }),

  deleteThreadsForever: (accountId: string, threadIds: string[]): Promise<{ ok: boolean }> =>
    ipc("gmail:deleteThreadsForever", { accountId, threadIds }),
  /** Empty Junk / Empty Trash: deletes every message there forever. */
  emptyFolder: (accountId: string, labelId: "SPAM" | "TRASH"): Promise<{ deleted: number }> =>
    task("gmail:emptyFolder", { accountId, labelId }),

  listSchedules: (): Promise<import("@otter-mail/contracts").MailSchedule[]> =>
    ipc("gmail:listSchedules"),
  cancelSchedule: (id: string): Promise<void> => task("gmail:cancelSchedule", { id }),
  snoozeThread: (accountId: string, threadId: string, dueAt: number): Promise<void> =>
    task("gmail:snoozeThread", { accountId, threadId, dueAt }),
  sendMessage: (params: SendMessageParams): Promise<{ ok: boolean }> =>
    params.scheduledAt === undefined
      ? ipc("gmail:sendMessage", params)
      : task("gmail:scheduleMessage", params),

  saveDraft: (params: SaveDraftParams): Promise<SaveDraftResult> => ipc("gmail:saveDraft", params),

  /** The message backing a draft right now; null = the draft is gone. */
  getDraftVersion: (accountId: string, draftId: string): Promise<{ messageId: string | null }> =>
    ipc("gmail:getDraftVersion", { accountId, draftId }),

  /** A draft's content at a given version (also refreshes the cache). */
  loadDraftVersion: (
    accountId: string,
    draftId: string,
    messageId: string,
  ): Promise<GmailMessageDetail> =>
    ipc("gmail:loadDraftVersion", { accountId, draftId, messageId }),

  deleteDraft: (accountId: string, draftId: string): Promise<{ ok: boolean }> =>
    ipc("gmail:deleteDraft", { accountId, draftId }),

  /** Deletes a composer's draft: by id when known, else whatever its session's
      saves created (even if that id never reached the renderer). */
  deleteSessionDraft: (
    accountId: string,
    sessionKey: string,
    draftId?: string,
  ): Promise<{ ok: boolean }> => ipc("gmail:deleteDraft", { accountId, sessionKey, draftId }),

  getDraftForMessage: (
    accountId: string,
    messageId: string,
    threadId?: string,
  ): Promise<{ draftId: string | null }> =>
    ipc("gmail:getDraftForMessage", { accountId, messageId, threadId }),

  getAttachment: (params: GetAttachmentParams): Promise<GetAttachmentResult> =>
    task("gmail:getAttachment", params),

  getAttachmentData: (params: GetAttachmentDataParams): Promise<{ base64: string; size: number }> =>
    task("gmail:getAttachmentData", params),

  openComposeAttachment: (params: { name: string; base64: string }): Promise<{ ok: boolean }> =>
    ipc("gmail:openComposeAttachment", params),

  /** Fetch a remote email image server-side (bypasses the iframe's CORP block). */
  proxyImage: (url: string): Promise<{ dataUrl: string }> => ipc("gmail:proxyImage", { url }),

  openAttachment: (params: AttachmentFileParams): Promise<{ ok: boolean }> =>
    task("gmail:openAttachment", params),

  dragAttachment: (params: AttachmentFileParams): Promise<{ ok: boolean }> =>
    task("gmail:dragAttachment", params),

  pickAttachments: (existingBytes: number): Promise<PickAttachmentsResult> =>
    task("gmail:pickAttachments", { existingBytes }),

  suggestContacts: (params: { q: string; limit?: number }): Promise<ContactSuggestion[]> =>
    ipc("gmail:suggestContacts", params),

  syncAccount: (accountId: string): Promise<SyncStatus> => ipc("gmail:syncAccount", { accountId }),

  getSyncStatus: (accountId: string): Promise<SyncStatus> =>
    ipc("gmail:getSyncStatus", { accountId }),

  getSenderAvatar: (accountId: string, email: string): Promise<{ dataUrl: string | null }> =>
    ipc("gmail:getSenderAvatar", { accountId, email }),

  getSyncSettings: (): Promise<SyncSettings> => ipc("gmail:getSyncSettings"),

  setSyncSettings: (params: Partial<SyncSettings>): Promise<SyncSettings> =>
    ipc("gmail:setSyncSettings", params),

  getTranslationSettings: (): Promise<TranslationSettings> => ipc("translation:getSettings"),

  setTranslationSettings: (params: Partial<TranslationSettings>): Promise<TranslationSettings> =>
    ipc("translation:setSettings", params),

  /** Apple's on-device language detection. */
  detectLanguage: (text: string): Promise<{ language: string | null; confidence: number }> =>
    ipc("translation:detect", { text }),

  /** Apple's on-device translation, one result per segment. */
  translate: (params: {
    segments: string[];
    source: string;
    target: string;
  }): Promise<{ status: TranslationStatus; texts: string[] }> =>
    task("translation:translate", params),

  listViews: (): Promise<MailView[]> => ipc("gmail:listViews"),

  saveView: (params: SaveViewParams): Promise<MailView> => ipc("gmail:saveView", params),

  deleteView: (viewId: string): Promise<{ ok: boolean }> => ipc("gmail:deleteView", { viewId }),

  resetView: (viewId: string): Promise<{ ok: boolean }> => ipc("gmail:resetView", { viewId }),

  importViews: (views: MailView[]): Promise<MailView[]> => ipc("gmail:importViews", { views }),

  openSettings: (target?: SettingsTarget): Promise<void> => ipc("window:openSettings", target),
  closeMainWindow: (): Promise<void> => ipc("window:closeMain"),

  getSettingsTarget: (): Promise<SettingsTarget | null> => ipc("window:getSettingsTarget"),

  /** Cmd+click: open a single message in its own window. */
  /** A conversation a notification asked this window to open, if any. */
  takePendingOpenMessage: (): Promise<{ accountId: string; messageId: string } | null> =>
    ipc("window:takePendingOpenMessage"),

  takePendingMailto: (): Promise<MailtoTarget | null> => ipc("app:takePendingMailto"),

  getDefaultMailStatus: (): Promise<{ isDefault: boolean }> => ipc("app:getDefaultMailStatus"),

  /** No id = register Otter Mail itself; with one, hand the default to that app. */
  setDefaultMailApp: (id?: string): Promise<{ ok: boolean }> =>
    ipc("app:setDefaultMailApp", id ? { id } : undefined),

  listMailApps: (): Promise<MailAppsResult> => ipc("app:listMailApps"),

  /** Cached provider snapshots; stale ones re-check and arrive as `agent:providersChanged`. */
  agentProviders: (): Promise<ProvidersState> => ipc("agent:providers"),

  openrouterConnection: (): Promise<OpenRouterConnection> => ipc("agent:openrouterConnection"),
  connectOpenRouter: (apiKey: string): Promise<ProvidersState> =>
    ipc("agent:connectOpenRouter", { apiKey }),
  disconnectOpenRouter: (): Promise<ProvidersState> => ipc("agent:disconnectOpenRouter"),

  refreshAgentProviders: (): Promise<{ ok: boolean }> => ipc("agent:refreshProviders"),

  updateAgentSettings: (patch: AgentSettingsPatch): Promise<ProvidersState> =>
    ipc("agent:updateSettings", patch),

  connectHermes: (params: { baseUrl: string; apiKey: string }): Promise<ProvidersState> =>
    ipc("agent:connectHermes", params),

  connectOpenClaw: (
    params: { code: string } | { url: string; token: string },
  ): Promise<ProvidersState> => ipc("agent:connectOpenClaw", params),

  /**
   * Starts a turn and returns at once; it streams as `agent:chatEvent`.
   * Without `sessionId` the provider opens a session and reports it in a
   * `session` event; Hermes legacy chats chain via `previousResponseId`.
   */
  agentSend: (params: {
    provider: ProviderKind;
    requestId: string;
    input: string;
    sessionId?: string;
    title?: string;
    skill?: { name: string; path?: string };
    attachments?: ChatAttachment[];
    previousResponseId?: string;
  }): Promise<{ ok: boolean }> => ipc("agent:send", params),

  /** Copies dropped, picked or pasted files into the attachments folder. */
  agentStageAttachments: (
    items: { name: string; mime: string; bytes: Uint8Array }[],
  ): Promise<{ attachments: ChatAttachment[]; errors: string[] }> =>
    ipc("agent:stageAttachments", { items }),

  agentRespondApproval: (params: {
    provider: ProviderKind;
    requestId: string;
    approvalId: string;
    decision: ApprovalDecision;
  }): Promise<{ ok: boolean }> => ipc("agent:respondApproval", params),

  /** Adds a message to the running turn; `accepted: false` → queue it instead. */
  agentSteer: (
    provider: ProviderKind,
    requestId: string,
    input: string,
  ): Promise<{ accepted: boolean }> => ipc("agent:steer", { provider, requestId, input }),

  agentCancel: (provider: ProviderKind, requestId: string): Promise<{ ok: boolean }> =>
    ipc("agent:cancel", { provider, requestId }),

  agentSkills: (provider: ProviderKind): Promise<Skill[]> => ipc("agent:skills", { provider }),

  agentSessions: (provider: ProviderKind, limit = 40): Promise<ChatSession[]> =>
    ipc("agent:sessions", { provider, limit }),

  agentSessionMessages: (
    provider: ProviderKind,
    sessionId: string,
  ): Promise<ChatSessionMessage[]> => ipc("agent:sessionMessages", { provider, sessionId }),

  agentDeleteSession: (provider: ProviderKind, sessionId: string): Promise<{ ok: boolean }> =>
    ipc("agent:deleteSession", { provider, sessionId }),

  // Agents on the Mac given Otter Mail's tools with a token (the Mac only).
  connectedAgents: (): Promise<AgentTokens<ConnectedAgent>> => ipc("mcp:listAgents"),
  /** Answers the token, this once. */
  addConnectedAgent: (name: string, access: AgentAccess): Promise<string> =>
    ipc("mcp:addAgent", { name, access }),
  setConnectedAgentAccess: (id: string, access: AgentAccess): Promise<void> =>
    ipc("mcp:setAgentAccess", { id, access }),
  removeConnectedAgent: (id: string): Promise<void> => ipc("mcp:removeAgent", { id }),
};
