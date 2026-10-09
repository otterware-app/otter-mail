/**
 * Provider settings (assistant-providers.json) plus the Hermes API key and the
 * OpenClaw gateway token, which are full agent control: kept in the platform's
 * secrets, never sent to the renderer, never logged.
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
  type OpenClawSettings,
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

const DEFAULT_OPENCLAW: OpenClawSettings = {
  enabled: true,
  url: "",
  model: "",
};

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
const OPENCLAW_TOKEN_SECRET = "openclaw-gateway-token";
/** A setup code's one-time bootstrap token (`openclaw qr`), until the gateway issues a device token. */
const OPENCLAW_BOOTSTRAP_SECRET = "openclaw-bootstrap-token";
/** This device's Ed25519 key (JWK) and the device token the gateway issued it. */
const OPENCLAW_DEVICE_KEY_SECRET = "openclaw-device-key";
const OPENCLAW_DEVICE_TOKEN_SECRET = "openclaw-device-token";

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
    openclaw: { ...DEFAULT_OPENCLAW, ...stored?.openclaw },
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

const secret = async (name: string): Promise<string> =>
  (await platform()
    .secrets.get(name)
    .catch(() => null)) ?? "";

export const getOpenClawToken = () => secret(OPENCLAW_TOKEN_SECRET);
export const setOpenClawToken = (token: string) =>
  platform().secrets.set(OPENCLAW_TOKEN_SECRET, token);
export const clearOpenClawToken = () => platform().secrets.delete(OPENCLAW_TOKEN_SECRET);
export const getOpenClawBootstrapToken = () => secret(OPENCLAW_BOOTSTRAP_SECRET);
export const setOpenClawBootstrapToken = (token: string) =>
  platform().secrets.set(OPENCLAW_BOOTSTRAP_SECRET, token);
export const clearOpenClawBootstrapToken = () =>
  platform().secrets.delete(OPENCLAW_BOOTSTRAP_SECRET);
export const getOpenClawDeviceKey = () => secret(OPENCLAW_DEVICE_KEY_SECRET);
export const setOpenClawDeviceKey = (jwk: string) =>
  platform().secrets.set(OPENCLAW_DEVICE_KEY_SECRET, jwk);
export const getOpenClawDeviceToken = () => secret(OPENCLAW_DEVICE_TOKEN_SECRET);
export const setOpenClawDeviceToken = (record: string) =>
  platform().secrets.set(OPENCLAW_DEVICE_TOKEN_SECRET, record);
export const clearOpenClawDeviceToken = () =>
  platform().secrets.delete(OPENCLAW_DEVICE_TOKEN_SECRET);
