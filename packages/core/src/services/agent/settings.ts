/**
 * Provider settings (assistant-providers.json) plus the Hermes API key, which
 * is full agent control: kept in the platform's secrets, never sent to the
 * renderer, never logged.
 */

import { readJson, writeJson } from "../../json-file.js";
import { platform } from "../../platform.js";
import {
  PROVIDER_KINDS,
  RUNTIME_MODES,
  type ClaudeSettings,
  type RuntimeMode,
  type CodexSettings,
  type HermesSettings,
  type ProviderKind,
  type ProviderSettings,
} from "./types.js";

const DEFAULT_HERMES: HermesSettings = {
  enabled: true,
  baseUrl: "",
  agentModel: "hermes-agent",
  model: "",
  reasoningEffort: "",
  serviceTier: "",
};

/** Before model choice existed, `model` held the agent id (now `agentModel`). */
function migrateHermes(stored: Partial<HermesSettings>): Partial<HermesSettings> {
  if (stored.model && !stored.model.includes("::") && !stored.agentModel)
    return { ...stored, agentModel: stored.model, model: "" };
  return stored;
}

const DEFAULT_CODEX: CodexSettings = {
  enabled: true,
  binaryPath: "",
  homePath: "",
  launchArgs: "",
  model: "",
  reasoningEffort: "",
  serviceTier: "",
  runtimeMode: "full-access",
};

const DEFAULT_CLAUDE: ClaudeSettings = {
  enabled: true,
  binaryPath: "",
  homePath: "",
  model: "",
  reasoningEffort: "",
  serviceTier: "",
  runtimeMode: "full-access",
};

/** Runtime modes from before T3's set ("read-only") fall back to supervised. */
function migrateRuntimeMode<T extends { runtimeMode: RuntimeMode }>(settings: T): T {
  return RUNTIME_MODES.includes(settings.runtimeMode)
    ? settings
    : { ...settings, runtimeMode: "approval-required" };
}

// Stored under names from when agents were "assistants"; renaming them would lose them.
const HERMES_KEY_SECRET = "assistant-hermes-key";

let cache: ProviderSettings | null = null;

export async function getProviderSettings(): Promise<ProviderSettings> {
  if (cache) return cache;
  const stored = await readJson<ProviderSettings>("assistant-providers.json");
  // Before providers existed, Hermes' connection lived in assistant-chat.json.
  const legacyHermes = stored ? null : await readJson<HermesSettings>("assistant-chat.json");
  const selected = PROVIDER_KINDS.includes(stored?.selected as ProviderKind)
    ? (stored?.selected as ProviderKind)
    : legacyHermes?.baseUrl
      ? "hermes"
      : "openrouter";
  cache = {
    selected,
    hermes: {
      ...DEFAULT_HERMES,
      ...migrateHermes({ ...legacyHermes, ...stored?.hermes }),
    },
    codex: migrateRuntimeMode({ ...DEFAULT_CODEX, ...stored?.codex }),
    claude: migrateRuntimeMode({ ...DEFAULT_CLAUDE, ...stored?.claude }),
    openrouter: migrateRuntimeMode({
      enabled: true,
      model: "",
      reasoningEffort: "",
      serviceTier: "",
      runtimeMode: "approval-required",
      ...stored?.openrouter,
    }),
  };
  return cache;
}

export async function saveProviderSettings(next: ProviderSettings): Promise<void> {
  cache = next;
  await writeJson("assistant-providers.json", next);
}

export async function getHermesKey(): Promise<string> {
  return (
    (await platform()
      .secrets.get(HERMES_KEY_SECRET)
      .catch(() => null)) ?? ""
  );
}

export async function setHermesKey(key: string): Promise<void> {
  await platform().secrets.set(HERMES_KEY_SECRET, key);
}

export async function clearHermesKey(): Promise<void> {
  await platform().secrets.delete(HERMES_KEY_SECRET);
}
