/**
 * @otter-mail/core: the mail backend. The desktop app runs it in an Electron
 * utility process, the web app in a Web Worker; each hands `startCore` its
 * Platform (platform.ts) and serves `registeredHandlers()` to the renderer.
 */

import { registerTodoistHandlers } from "./handlers/todoist.js";
import { registerAgentHandlers } from "./handlers/agent.js";
import { registerCalendarHandlers } from "./handlers/calendar.js";
import { registerGmailHandlers } from "./handlers/gmail.js";
import { registerImapAccountHandlers } from "./handlers/imap-accounts.js";
import { registerOtterAccountHandlers } from "./handlers/otter-account.js";
import { registerProjectHandlers } from "./handlers/projects.js";
import { registerSearchHandlers } from "./handlers/search.js";
import { registerTranslationHandlers } from "./handlers/translation.js";
import { registerSupportHandlers } from "./handlers/support.js";
import { broadcast, handle } from "./ipc.js";
import { setPlatform, type Platform } from "./platform.js";
import { pruneAttachmentCache } from "./services/attachment-cache.js";
import { loadImapPasswords } from "./services/imap-passwords.js";
import { readKeybindings, writeKeybindings } from "./services/keybindings-store.js";
import {
  configureAutoSync,
  followMailboxArrangement,
  syncAllAccounts,
} from "./services/mail-sync.js";
import { loadOtterAccount } from "./services/otter-account.js";
import { getUiPreferences, preferenceChanged, setUiPreference } from "./services/preferences.js";
import { getSettings, onSettingsChanged } from "./services/settings-store.js";
import { refreshProfiles } from "./services/google-profile.js";
import { startMailSchedule } from "./services/mail-schedule.js";
import { refreshSignatures } from "./services/signatures.js";

/** Starts the backend: restores sign-ins, registers every handler, and syncs. */
export async function startCore(platform: Platform): Promise<void> {
  setPlatform(platform);
  await platform.google.load();
  await loadImapPasswords();
  await loadOtterAccount();

  registerGmailHandlers();
  startMailSchedule();
  registerImapAccountHandlers();
  registerSearchHandlers();
  registerCalendarHandlers();
  registerOtterAccountHandlers();
  registerTranslationHandlers();
  registerAgentHandlers();
  registerSupportHandlers();
  registerProjectHandlers();
  registerTodoistHandlers();
  handle("keybindings:read", async () => readKeybindings());
  handle("preferences:getUi", async (params: unknown) =>
    getUiPreferences((params as { initialize?: unknown } | undefined)?.initialize === true),
  );
  handle("preferences:setUi", async (params: unknown) => {
    const { key, value } = (params ?? {}) as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "string")
      throw new Error("key and value are required.");
    await setUiPreference(key, value);
  });
  onSettingsChanged(() => preferenceChanged("settings"));
  handle("keybindings:write", async (params: unknown) => {
    const result = await writeKeybindings((params as { rules?: unknown } | undefined)?.rules);
    broadcast("keybindings:updated");
    preferenceChanged("keybindings");
    return result;
  });

  // Warm the local cache for every connected account (turned-off ones stay cold).
  followMailboxArrangement((await getUiPreferences())["mail:mailboxes"]);
  void syncAllAccounts({ force: true });
  configureAutoSync((await getSettings()).syncIntervalSeconds);
  void pruneAttachmentCache();
  void refreshSignatures();
  void refreshProfiles();
}

export { broadcast, handle, registeredHandlers, type Handler } from "./ipc.js";
export { fromBase64, toBase64 } from "./bytes.js";
export { SIGNED_OUT_MESSAGE, SignInCancelledError } from "./google.js";
export { readJson, writeJson } from "./json-file.js";
export { logger } from "./logger.js";
export type * from "./platform.js";
export * as accountStore from "./services/account-store.js";
export * as mailStore from "./services/mail-store.js";
export { runAsTask } from "./handlers/ipc-budget.js";
export { ATTACHMENTS_DIR, dataUrl, readAttachment } from "./services/agent/attachments.js";
export { shutdownProviders } from "./services/agent/service.js";
export { TOOL_OUTPUT_CHARS, claudeStep, codexStep } from "./services/agent/steps.js";
export {
  OTTER_TOOLS_SERVER,
  agentTools,
  cancelToolApprovals,
  runAgentTool,
  type AgentTool,
  type ToolCaller,
  type ToolFiles,
} from "./services/agent/tools/index.js";
export * from "./services/agent/types.js";
export { getAttachmentBytes } from "./services/attachment-cache.js";
export { addDemoMailboxes } from "./services/demo-mailboxes.js";
export { KEYBINDINGS_FILE } from "./services/keybindings-store.js";
export { syncAllAccounts, turnedOffMailboxes } from "./services/mail-sync.js";
export {
  getSettings,
  onSettingsChanged,
  updateSettings,
  type AppSettings,
} from "./services/settings-store.js";
export type * from "./types.js";

export { signInWithSession, clearOtterSession } from "./services/otter-account.js";
