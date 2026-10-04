/**
 * Agent handlers: provider state/settings plus chat routing. Every call
 * answers well inside the 5s IPC budget — health checks and turns run in the
 * background and report via `agent:providersChanged` / `agent:chatEvent`.
 */

import { handle } from "../ipc.js";
import { ATTACHMENTS_DIR, stageAttachment } from "../services/agent/attachments.js";
import {
  connectOpenRouter,
  disconnectOpenRouter,
  openRouterConnection,
} from "../services/agent/openrouter.js";
import * as agent from "../services/agent/service.js";
import { preferenceChanged } from "../services/preferences.js";
import {
  PROVIDER_KINDS,
  RUNTIME_MODES,
  type ApprovalDecision,
  type ProviderKind,
  type RuntimeMode,
  type ChatAttachment,
} from "../services/agent/types.js";

type Params = Record<string, unknown> | undefined;

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

function providerOf(p: Params): ProviderKind {
  const kind = p?.provider;
  if (typeof kind === "string" && PROVIDER_KINDS.includes(kind as ProviderKind))
    return kind as ProviderKind;
  throw new Error("Unknown agent provider.");
}

function sessionIdOf(p: Params): string {
  const sessionId = str(p?.sessionId);
  if (!sessionId) throw new Error("A session id is required.");
  return sessionId;
}

/** Codex / Claude settings: enabled, model choices, launch paths, runtime mode. */
function agentPatch<K extends string>(
  raw: Record<string, unknown>,
  launchKeys: readonly K[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (bool(raw.enabled) !== undefined) out.enabled = bool(raw.enabled);
  for (const key of [...launchKeys, "model", "reasoningEffort", "serviceTier"]) {
    if (typeof raw[key] === "string") out[key] = str(raw[key]);
  }
  if (RUNTIME_MODES.includes(raw.runtimeMode as RuntimeMode)) out.runtimeMode = raw.runtimeMode;
  return out;
}

/** Only known fields of the right type make it into the patch. */
function settingsPatch(p: Params): agent.SettingsPatch {
  const patch: agent.SettingsPatch = {};
  if (typeof p?.selected === "string" && PROVIDER_KINDS.includes(p.selected as ProviderKind))
    patch.selected = p.selected as ProviderKind;
  const hermes = p?.hermes as Params;
  if (hermes) {
    const h: NonNullable<agent.SettingsPatch["hermes"]> = {};
    if (bool(hermes.enabled) !== undefined) h.enabled = bool(hermes.enabled);
    for (const key of ["model", "reasoningEffort", "serviceTier"] as const) {
      if (typeof hermes[key] === "string") h[key] = str(hermes[key]);
    }
    patch.hermes = h;
  }
  const codex = p?.codex as Params;
  if (codex) patch.codex = agentPatch(codex, ["binaryPath", "homePath", "launchArgs"]);
  const claude = p?.claude as Params;
  if (claude) patch.claude = agentPatch(claude, ["binaryPath", "homePath"]);
  const openrouter = p?.openrouter as Params;
  if (openrouter) patch.openrouter = agentPatch(openrouter, []);
  return patch;
}

const MAX_ATTACHMENTS = 10;

/** Only staged files (inside the attachments folder) are passed to agents. */
function attachmentsOf(raw: unknown): ChatAttachment[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Params[])
    .filter(
      (a): a is Params & ChatAttachment =>
        typeof a?.path === "string" &&
        a.path.startsWith(`${ATTACHMENTS_DIR}/`) &&
        !a.path.includes("..") &&
        typeof a.name === "string" &&
        typeof a.mime === "string" &&
        (a.kind === "image" || a.kind === "file"),
    )
    .slice(0, MAX_ATTACHMENTS)
    .map((a) => ({
      id: str(a.id),
      name: a.name,
      mime: a.mime,
      size: Number(a.size) || 0,
      path: a.path,
      kind: a.kind,
    }));
}

export function registerAgentHandlers(): void {
  agent.watchAgentAccount();
  handle("agent:providers", async () => agent.providersState());

  handle("agent:refreshProviders", async () => {
    void agent.refreshProviders();
    return { ok: true };
  });

  handle("agent:updateSettings", async (params: unknown) => {
    const state = await agent.updateProviderSettings(settingsPatch(params as Params));
    preferenceChanged("assistant");
    return state;
  });

  handle("agent:openrouterConnection", () => openRouterConnection());
  handle("agent:connectOpenRouter", async (params: unknown) => {
    const key = str((params as Params)?.apiKey);
    await connectOpenRouter(key);
    await agent.updateProviderSettings({ selected: "openrouter", openrouter: { enabled: true } });
    await agent.refreshProvider("openrouter");
    preferenceChanged("assistant");
    return agent.providersState();
  });
  handle("agent:disconnectOpenRouter", async () => {
    await disconnectOpenRouter();
    await agent.refreshProvider("openrouter");
    return agent.providersState();
  });

  handle("agent:connectHermes", async (params: unknown) => {
    const p = params as Params;
    const baseUrl = str(p?.baseUrl);
    const apiKey = str(p?.apiKey);
    if (!baseUrl || !apiKey) throw new Error("Base URL and API key are both required.");
    const state = await agent.connectHermes(baseUrl, apiKey);
    preferenceChanged("assistant");
    preferenceChanged("hermesKey");
    return state;
  });

  handle("agent:send", async (params: unknown) => {
    const p = params as Params;
    const requestId = str(p?.requestId);
    const input = typeof p?.input === "string" ? p.input : "";
    const skill = p?.skill as Params;
    const skillName = str(skill?.name);
    const attachments = attachmentsOf(p?.attachments);
    if (!requestId || (!input.trim() && !skillName && attachments.length === 0))
      throw new Error("Nothing to send.");
    await agent.sendTurn(providerOf(p), {
      requestId,
      input,
      sessionId: str(p?.sessionId) || undefined,
      title: str(p?.title) || undefined,
      previousResponseId: str(p?.previousResponseId) || undefined,
      skill: skillName ? { name: skillName, path: str(skill?.path) || undefined } : undefined,
      attachments,
    });
    return { ok: true };
  });

  // Dropped, picked or pasted files are copied into the attachments folder;
  // the renderer sends the returned records with a turn.
  handle("agent:stageAttachments", async (params: unknown) => {
    const p = params as Params;
    const items = Array.isArray(p?.items) ? (p.items as Params[]) : [];
    const staged: ChatAttachment[] = [];
    const errors: string[] = [];
    for (const item of items.slice(0, MAX_ATTACHMENTS)) {
      try {
        if (item?.bytes instanceof Uint8Array)
          staged.push(
            await stageAttachment(str(item.name) || "Pasted image.png", str(item.mime), item.bytes),
          );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { attachments: staged, errors };
  });

  handle("agent:respondApproval", async (params: unknown) => {
    const p = params as Params;
    const decision = p?.decision as ApprovalDecision;
    if (!["once", "session", "always", "deny"].includes(decision))
      throw new Error("Unknown decision.");
    await agent.respondApproval(providerOf(p), str(p?.requestId), str(p?.approvalId), decision);
    return { ok: true };
  });

  handle("agent:steer", async (params: unknown) => {
    const p = params as Params;
    const input = typeof p?.input === "string" ? p.input : "";
    if (!input.trim()) throw new Error("Nothing to send.");
    return {
      accepted: await agent.steerTurn(providerOf(p), str(p?.requestId), input),
    };
  });

  handle("agent:cancel", async (params: unknown) => {
    const p = params as Params;
    agent.cancelTurn(providerOf(p), str(p?.requestId));
    return { ok: true };
  });

  handle("agent:skills", async (params: unknown) => agent.listSkills(providerOf(params as Params)));

  handle("agent:sessions", async (params: unknown) => {
    const p = params as Params;
    const limit = typeof p?.limit === "number" && Number.isFinite(p.limit) ? p.limit : 40;
    return agent.listSessions(providerOf(p), limit);
  });

  handle("agent:sessionMessages", async (params: unknown) => {
    const p = params as Params;
    return agent.readSession(providerOf(p), sessionIdOf(p));
  });

  handle("agent:deleteSession", async (params: unknown) => {
    const p = params as Params;
    await agent.deleteSession(providerOf(p), sessionIdOf(p));
    return { ok: true };
  });
}
