/**
 * Settings → Agents, after T3 Code's provider settings: "Checked … ago"
 * refresh by the title, the provider list (icon, name, version, status, enable
 * switch), then the selected provider's settings below it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentAccess, ConnectedAgent } from "@otter-mail/contracts/agent-tokens";
import { Field } from "~/components/ui/field";
import { Switch } from "~/components/ui/switch";
import { Text } from "~/components/ui/text";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { toast } from "../gmail/toast";
import { CheckIcon, RotateCwIcon, StarIcon } from "lucide-react";
import {
  gmailApi,
  type AgentSettingsPatch,
  type ProviderKind,
  type ProviderModel,
  type ProviderSnapshot,
  type ProvidersState,
  type RuntimeMode,
} from "../gmail/api";
import {
  PROVIDER_STATUS_DOT,
  ProviderIcon,
  providerSummary,
  providerVersionLabel,
  useAgentProviders,
  useSetProvidersState,
} from "../gmail/agent-providers";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../gmail/select";
import { Btn, cn } from "../gmail/ui";
import {
  DraftInput,
  RowSelect,
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  TextInput,
} from "./settings-ui";
import { searchableSetting } from "./settings-search";
import { AgentTokensSection, CopyButton } from "./agent-tokens-section";
import { OpenRouterConnection } from "./openrouter-connection";
import { features } from "../features";
import { osNames } from "../os-names";
import { RUNTIME_MODE_OPTIONS } from "../gmail/model-picker";
import {
  modelKey,
  resetModelPrefs,
  setHidden,
  toggleAllHidden,
  toggleFavorite,
  useModelPrefs,
} from "../gmail/model-prefs";
import {
  setFollowUpBehavior,
  useFollowUpBehavior,
  type FollowUpBehavior,
} from "../gmail/chat-queue";
import { shortcutText } from "../keybindings/keys";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function StatusDot({ status }: { status: ProviderSnapshot["status"] }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", PROVIDER_STATUS_DOT[status])}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function ProviderListRow({
  provider,
  selected,
  isDefault,
  onSelect,
  onToggle,
}: {
  provider: ProviderSnapshot;
  selected: boolean;
  isDefault: boolean;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const summary = providerSummary(provider);
  const version = providerVersionLabel(provider.version);
  const needsAttention = provider.status === "warning" || provider.status === "error";
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "group flex min-h-[60px] items-center gap-3 px-4 py-2.5",
        selected ? "bg-foreground/[0.04]" : "hover:bg-foreground/[0.03]",
      )}
    >
      <div
        className={cn(
          "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left",
          !provider.enabled && !selected && "opacity-60 group-hover:opacity-100",
        )}
      >
        <button
          type="button"
          className="pointer-events-auto absolute inset-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onClick={onSelect}
          aria-label={`Select ${provider.displayName}`}
          aria-pressed={selected}
        />
        <span className="flex h-5 shrink-0 items-center">
          <ProviderIcon kind={provider.kind} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm text-foreground">{provider.displayName}</span>
            {version ? (
              <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                {version}
              </code>
            ) : null}
            {isDefault ? (
              <span className="shrink-0 rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">
                Default
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[18px] text-muted-foreground">
            {needsAttention ? (
              <span className="flex h-[18px] shrink-0 items-center">
                <StatusDot status={provider.status} />
              </span>
            ) : null}
            <span className="line-clamp-2 [overflow-wrap:anywhere]">{summary.headline}</span>
          </span>
        </span>
      </div>
      <span className="flex h-5 shrink-0 items-center gap-2">
        {!provider.enabled ? (
          <SettingResetButton
            label={`${provider.displayName} enabled`}
            onClick={() => onToggle(true)}
          />
        ) : null}
        <Switch
          checked={provider.enabled}
          onCheckedChange={(checked: boolean) => onToggle(Boolean(checked))}
          aria-label={`Enable ${provider.displayName}`}
        />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function StatusLine({ provider }: { provider: ProviderSnapshot }) {
  const summary = providerSummary(provider);
  if (provider.enabled && provider.auth.status === "authenticated" && provider.auth.email) {
    return (
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span>Authenticated as</span>
        <span className="text-foreground/80">{provider.auth.email}</span>
        {provider.auth.label ? <span>· {provider.auth.label}</span> : null}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
      <StatusDot status={provider.status} />
      <span>{summary.headline}</span>
      {summary.detail ? (
        <span className="min-w-0 [overflow-wrap:anywhere]">· {summary.detail}</span>
      ) : null}
    </div>
  );
}

/** T3's capability summary for a row: "Reasoning · Fast". */
function capabilityLabels(model: ProviderModel): string[] {
  return (model.options ?? []).map((o) => (o.id === "serviceTier" ? "Fast" : o.label));
}

/**
 * Models, as T3 Code's ProviderModelsSection: favorites and picker visibility
 * (stored on this device), a filter for long catalogs, and Enable / Disable all.
 * Clicking a name makes it the provider's default model.
 */
function ModelsSection({
  provider,
  onPick,
  selectedModel,
}: {
  provider: ProviderSnapshot;
  selectedModel: string;
  onPick?: (slug: string) => void;
}) {
  const { favorites, hidden } = useModelPrefs();
  const [filter, setFilter] = useState("");
  const key = (slug: string) => modelKey(provider.kind, slug);
  const favoriteSet = new Set(favorites);
  const hiddenSet = new Set(hidden);
  const groupOf = (m: ProviderModel) =>
    favoriteSet.has(key(m.slug)) ? "favorite" : hiddenSet.has(key(m.slug)) ? "hidden" : "visible";
  const rank = { favorite: 0, visible: 1, hidden: 2 } as const;
  const models = provider.models;
  const query = filter.trim().toLowerCase();
  const visible = models
    .filter(
      (m) =>
        !query ||
        m.name.toLowerCase().includes(query) ||
        m.slug.toLowerCase().includes(query) ||
        (m.subProvider ?? "").toLowerCase().includes(query),
    )
    .sort((a, b) => rank[groupOf(a)] - rank[groupOf(b)]);
  const favoriteCount = models.filter((m) => favoriteSet.has(key(m.slug))).length;
  const hiddenCount = models.filter((m) => hiddenSet.has(key(m.slug))).length;
  const allKeys = models.map((m) => key(m.slug));
  const allHidden = allKeys.length > 0 && allKeys.every((k) => hiddenSet.has(k));

  const groupLabel = (label: string, isFirst: boolean) => (
    <div className={cn("px-2 pb-1.5 text-2xs text-muted-foreground", isFirst ? "pt-1" : "pt-5")}>
      {label}
    </div>
  );

  return (
    <SettingsSection
      {...searchableSetting("agent-models")}
      headerAction={
        selectedModel ||
        favorites.some((key) => key.startsWith(`${provider.kind}:`)) ||
        hidden.some((key) => key.startsWith(`${provider.kind}:`)) ? (
          <SettingResetButton
            label={`${provider.displayName} models`}
            onClick={() => {
              onPick?.("");
              resetModelPrefs(provider.kind);
            }}
          />
        ) : null
      }
      description={`Favorites and visibility are saved on this device.${
        onPick ? " Click a model to make it the default for new chats." : ""
      }`}
    >
      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {models.length > 8 ? (
            <TextInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter models"
              spellCheck={false}
              aria-label="Filter models"
              className="w-56 max-w-full"
            />
          ) : null}
          <div className="flex items-center gap-2">
            {models.length > 0 ? (
              <Btn size="xs" variant="ghost-muted" onClick={() => toggleAllHidden(allKeys)}>
                {allHidden ? "Enable all" : "Disable all"}
              </Btn>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {models.length} model{models.length === 1 ? "" : "s"}
              {favoriteCount > 0
                ? ` · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}`
                : ""}
              {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
            </span>
          </div>
        </div>
        <div className="-mx-2 mt-2 max-h-72 overflow-y-auto">
          {visible.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {query ? "No models match." : "No models reported for this provider yet."}
            </p>
          ) : null}
          {visible.map((m, index) => {
            const group = groupOf(m);
            const previous = visible[index - 1];
            const startsGroup = !previous || groupOf(previous) !== group;
            const isHidden = hiddenSet.has(key(m.slug));
            const isFavorite = group === "favorite";
            const isDefault = m.slug === provider.model;
            const caps = capabilityLabels(m);
            return (
              <div key={m.slug}>
                {startsGroup && favoriteCount > 0 && group === "favorite"
                  ? groupLabel("Favorites", index === 0)
                  : null}
                {startsGroup && favoriteCount > 0 && group === "visible"
                  ? groupLabel("All", index === 0)
                  : null}
                {startsGroup && group === "hidden"
                  ? groupLabel("Hidden from picker", index === 0)
                  : null}
                <div
                  data-model-slug={m.slug}
                  className={cn(
                    "grid h-8 grid-cols-[1.5rem_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg px-2 hover:bg-foreground/[0.04]",
                    isHidden && "opacity-50",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleFavorite(key(m.slug))}
                    aria-label={`${isFavorite ? "Remove" : "Add"} ${m.name} ${isFavorite ? "from" : "to"} favorites`}
                    title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                    className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent-surface hover:text-foreground"
                  >
                    <StarIcon
                      className={cn("size-3", isFavorite && "fill-current text-yellow-500")}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={!onPick}
                    onClick={() => onPick?.(m.slug)}
                    className="flex min-w-0 items-baseline gap-2 text-left enabled:cursor-pointer"
                  >
                    <span
                      className={cn(
                        "truncate text-xs",
                        isHidden ? "text-muted-foreground" : "text-foreground/90",
                      )}
                    >
                      {m.name}
                    </span>
                    {m.subProvider ? (
                      <span className="truncate text-2xs text-muted-foreground/70">
                        {m.subProvider}
                      </span>
                    ) : m.name !== m.slug && m.slug ? (
                      <code className="truncate font-mono text-2xs text-muted-foreground/70">
                        {m.slug}
                      </code>
                    ) : null}
                    {isDefault ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs text-foreground/80">
                        <CheckIcon className="size-3" />
                        default
                      </span>
                    ) : null}
                  </button>
                  <span className="text-2xs text-muted-foreground/70">
                    {caps.length > 0 ? (
                      <span className="hidden sm:inline">{caps.join(" · ")}</span>
                    ) : null}
                  </span>
                  <span
                    className="flex shrink-0 items-center"
                    title={isHidden ? "Hidden from the model picker" : "Shown in the model picker"}
                  >
                    <Switch
                      checked={!isHidden}
                      onCheckedChange={(checked: boolean) => setHidden(key(m.slug), !checked)}
                      aria-label={`Show ${m.name} in the model picker`}
                    />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </SettingsSection>
  );
}

function EditorHeader({
  provider,
  isDefault,
  onMakeDefault,
  children,
}: {
  provider: ProviderSnapshot;
  isDefault: boolean;
  onMakeDefault: () => void;
  children?: ReactNode;
}) {
  const version = providerVersionLabel(provider.version);
  return (
    <SettingsSection
      title={provider.displayName}
      icon={<ProviderIcon kind={provider.kind} className="size-4" />}
      headerAction={
        version ? <code className="text-xs text-muted-foreground">{version}</code> : null
      }
    >
      <SettingsRow
        title="Status"
        status={<StatusLine provider={provider} />}
        control={
          isDefault ? (
            <span className="text-xs text-muted-foreground">Used for new chats</span>
          ) : (
            <Btn size="sm" disabled={!provider.enabled} onClick={onMakeDefault}>
              Use for new chats
            </Btn>
          )
        }
      />
      {children}
    </SettingsSection>
  );
}

/** Where Hermes' URL comes from, for the field's description. */
export const HERMES_URL_HINT =
  window.desktopBridge.platform === "web"
    ? `Hermes' built-in API server (port 8642), over HTTPS. Allow ${location.origin} in its API_SERVER_CORS_ORIGINS.`
    : "Hermes' built-in API server (port 8642), reached over Tailscale.";

/**
 * Connecting Hermes (Settings and the setup): the URL and key as typed, and
 * `connect`, which checks them against the server, then saves them. Resolves
 * true once connected.
 */
export function useConnectHermes(state: ProvidersState) {
  const setState = useSetProvidersState();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const connect = async (): Promise<boolean> => {
    const url = baseUrl.trim() || state.settings.hermes.baseUrl;
    if (!url || !apiKey.trim()) {
      toast.error("API base URL and key are both required");
      return false;
    }
    setSaving(true);
    console.log("[Settings:connectHermes]");
    try {
      setState(await gmailApi.connectHermes({ baseUrl: url, apiKey: apiKey.trim() }));
      setBaseUrl("");
      setApiKey("");
      toast.success("Hermes connected");
      return true;
    } catch (error) {
      toast.error(`Could not connect: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { baseUrl, setBaseUrl, apiKey, setApiKey, saving, connect };
}

function HermesEditor({
  state,
  provider,
  update,
}: {
  state: ProvidersState;
  provider: ProviderSnapshot;
  update: (patch: AgentSettingsPatch) => void;
}) {
  const { baseUrl, setBaseUrl, apiKey, setApiKey, saving, connect } = useConnectHermes(state);
  const connected = Boolean(state.settings.hermes.baseUrl && state.settings.hermesHasKey);
  const device = window.desktopBridge.platform === "web" ? "browser" : osNames.computer;

  return (
    <>
      {provider.status === "ready" ? null : (
        <SettingsSection
          title="Set up"
          description={`Run these on the computer where Hermes runs. This ${device} reaches it over Tailscale, so it needs Tailscale too, on the same tailnet.`}
        >
          <SettingsRow
            title="1. Turn on its API server"
            description="Skip this if Hermes already serves its API on port 8642. This makes a new key."
          >
            <Command value="hermes config set API_SERVER_ENABLED true" />
            <Command value={'hermes config set API_SERVER_KEY "$(openssl rand -hex 32)"'} />
            <Command value="hermes gateway restart" />
          </SettingsRow>
          <SettingsRow
            title="2. Serve it on your tailnet"
            description="Its address becomes https://<computer>.<tailnet>.ts.net:8642."
          >
            <Command value="tailscale serve --bg --https=8642 http://127.0.0.1:8642" />
          </SettingsRow>
          <SettingsRow
            title="3. Copy the API key"
            description="Paste it below with the address. It stays on this device."
          >
            <Command value={`sed -n 's/^API_SERVER_KEY=//p' "$(hermes config env-path)"`} />
          </SettingsRow>
          {SITE_ORIGIN ? (
            <SettingsRow
              title="4. Allow Otter Mail on the web"
              description="Browsers may only call Hermes from sites it allows. Separate sites with commas, and keep any you allowed before."
            >
              <Command value={`hermes config set API_SERVER_CORS_ORIGINS ${SITE_ORIGIN}`} />
              <Command value="hermes gateway restart" />
            </SettingsRow>
          ) : null}
        </SettingsSection>
      )}
      <SettingsSection {...searchableSetting("hermes-connection")}>
        <SettingsRow
          title="Base URL"
          description="Its address on your tailnet: https://<computer>.<tailnet>.ts.net:8642."
          control={
            <TextInput
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={state.settings.hermes.baseUrl || "https://<host>:8642"}
              aria-label="Hermes API base URL"
              className="@min-[32rem]/settings-row:w-56"
            />
          }
        />
        <SettingsRow
          title="API key"
          description="The server's API_SERVER_KEY. Kept on this device only."
          control={
            <TextInput
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={state.settings.hermesHasKey ? "Replace API key" : "API key"}
              aria-label="Hermes API key"
              className="@min-[32rem]/settings-row:w-56"
            />
          }
        />
        <SettingsRow
          title={connected ? "Reconnect" : "Connect"}
          description="Verifies the URL and key against the server, then saves them."
          control={
            <Btn size="sm" variant="primary" disabled={saving} onClick={() => void connect()}>
              {saving ? "Connecting…" : connected ? "Reconnect" : "Connect"}
            </Btn>
          }
        />
      </SettingsSection>
      <ModelsSection
        provider={provider}
        selectedModel={state.settings.hermes.model}
        onPick={(model) => update({ hermes: { model } })}
      />
    </>
  );
}

/** A command to run on the gateway's computer, with Copy. */
function Command({ value }: { value: string }) {
  return (
    <div className="mt-2 mb-1.5 flex items-start gap-2 rounded-lg bg-input/40 py-1.5 pr-1 pl-3">
      <code className="min-w-0 flex-1 py-0.5 font-mono text-xs break-all select-all">{value}</code>
      <CopyButton value={value} label="Copy command" />
    </div>
  );
}

/** Where the web app runs, which the gateway must allow (the Mac app needs no origin). */
const SITE_ORIGIN = window.desktopBridge.platform === "web" ? location.origin : null;

/** `wss://computer.tailnet.ts.net` or a bare host → `computer.tailnet.ts.net`. */
const gatewayHost = (address: string) =>
  address
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/:].*$/, "");

/** The gateway address inside a setup code (base64url JSON), for the allow-this-site step. */
function setupCodeUrl(code: string): string {
  try {
    const json = JSON.parse(atob(code.trim().replace(/-/g, "+").replace(/_/g, "/"))) as {
      url?: unknown;
    };
    return typeof json.url === "string" ? json.url : "";
  } catch {
    return "";
  }
}

/**
 * OpenClaw: the minimum setup on the gateway's computer, step by step, then a
 * setup code from `openclaw qr` (or, failing that, the address and token).
 * Connecting makes this install a device the gateway must approve once;
 * Settings waits for that and says how.
 */
function OpenClawEditor({
  state,
  provider,
  update,
}: {
  state: ProvidersState;
  provider: ProviderSnapshot;
  update: (patch: AgentSettingsPatch) => void;
}) {
  const setState = useSetProvidersState();
  const [code, setCode] = useState("");
  const [useToken, setUseToken] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const { openclaw, openclawPairingRequest } = state.settings;
  const connected = provider.status === "ready";
  const device = window.desktopBridge.platform === "web" ? "browser" : osNames.computer;
  const host = gatewayHost(url || setupCodeUrl(code) || openclaw.url);

  // Waiting for approval: look again every few seconds, so it connects once approved.
  useEffect(() => {
    if (!openclawPairingRequest) return;
    const timer = setInterval(() => void gmailApi.refreshAgentProviders().catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [openclawPairingRequest]);

  const connect = async () => {
    const address = url.trim() || openclaw.url;
    if (useToken ? !address || !token.trim() : !code.trim()) {
      toast.error(useToken ? "Gateway address and token are both required" : "Paste a setup code");
      return;
    }
    setSaving(true);
    console.log("[Settings:connectOpenClaw]", useToken ? "token" : "setup code");
    try {
      setState(
        await gmailApi.connectOpenClaw(
          useToken ? { url: address, token: token.trim() } : { code: code.trim() },
        ),
      );
      setCode("");
      setUrl("");
      setToken("");
    } catch (error) {
      toast.error(`Could not connect: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {connected ? null : (
        <SettingsSection
          title="Set up"
          description={`Run these on the computer where OpenClaw runs. This ${device} reaches it over Tailscale, so it needs Tailscale too, on the same tailnet.`}
        >
          <SettingsRow
            title="1. Serve the gateway on your tailnet"
            description="Skip this if it already runs with Tailscale Serve. Its address becomes wss://<computer>.<tailnet>.ts.net."
          >
            <Command value="openclaw config set gateway.tailscale.mode serve" />
            <Command value="openclaw gateway restart" />
          </SettingsRow>
          {SITE_ORIGIN ? (
            <SettingsRow
              title="2. Allow Otter Mail on the web"
              description="Browsers may only connect from sites the gateway allows. This keeps the gateway's own Control UI allowed; add any other sites you allowed before."
            >
              <Command
                value={`openclaw config set gateway.controlUi.allowedOrigins '${JSON.stringify([
                  `https://${host || "<computer>.<tailnet>.ts.net"}`,
                  SITE_ORIGIN,
                ])}'`}
              />
            </SettingsRow>
          ) : null}
          <SettingsRow
            title={`${SITE_ORIGIN ? 3 : 2}. Make a setup code`}
            description="Paste it below. It holds the gateway's address and works once, for 10 minutes."
          >
            <Command value="openclaw qr --setup-code-only --limited" />
          </SettingsRow>
        </SettingsSection>
      )}
      <SettingsSection {...searchableSetting("openclaw-connection")}>
        {openclaw.url ? (
          <SettingsRow
            title="Gateway"
            description={<span className="font-mono text-xs">{openclaw.url}</span>}
          />
        ) : null}
        {useToken ? (
          <>
            <SettingsRow
              title="Gateway address"
              description="wss://<computer>.<tailnet>.ts.net"
              control={
                <TextInput
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={openclaw.url ? "Change address" : "computer.tailnet.ts.net"}
                  aria-label="OpenClaw gateway address"
                  className="@min-[32rem]/settings-row:w-56"
                />
              }
            />
            <SettingsRow
              title="Gateway token"
              description="gateway.auth.token, which this prints on the gateway's computer. It stays on this device."
              control={
                <TextInput
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Token"
                  aria-label="OpenClaw gateway token"
                  className="@min-[32rem]/settings-row:w-56"
                />
              }
            >
              {/* `openclaw config get` redacts secrets, so read the config file itself. */}
              <Command value={`node -p "require('$(openclaw config file)').gateway.auth.token"`} />
            </SettingsRow>
          </>
        ) : (
          <SettingsRow
            title="Setup code"
            description="From openclaw qr --setup-code-only."
            control={
              <TextInput
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Paste setup code"
                aria-label="OpenClaw setup code"
                className="@min-[32rem]/settings-row:w-56"
              />
            }
          />
        )}
        <SettingsRow
          title={openclaw.url ? "Reconnect" : "Connect"}
          description={
            <>
              Connects this {device} to the gateway. The first time, you approve it there.{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => setUseToken(!useToken)}
              >
                {useToken ? "Use a setup code instead" : "Use the gateway token instead"}
              </button>
            </>
          }
          control={
            <Btn size="sm" variant="primary" disabled={saving} onClick={() => void connect()}>
              {saving ? "Connecting…" : openclaw.url ? "Reconnect" : "Connect"}
            </Btn>
          }
        />
        {openclawPairingRequest ? (
          <SettingsRow
            title={`Approve this ${device}`}
            description={`The gateway is waiting for you to approve this ${device}. Run this on its computer; Otter Mail connects as soon as you do.`}
          >
            <Command value={`openclaw devices approve ${openclawPairingRequest}`} />
          </SettingsRow>
        ) : null}
      </SettingsSection>
      {connected ? (
        <ModelsSection
          provider={provider}
          selectedModel={openclaw.model}
          onPick={(model) => update({ openclaw: { model } })}
        />
      ) : null}
    </>
  );
}

/** Runtime fields of the CLI-backed agents, per T3's provider settings. */
const AGENT_RUNTIME = {
  codex: {
    name: "Codex",
    binary: "codex",
    home: {
      title: "CODEX_HOME path",
      description: "Custom Codex home and config directory.",
      placeholder: "~/.codex",
    },
    launchArgs: "Additional CLI arguments passed to codex app-server on session start.",
  },
  claude: {
    name: "Claude",
    binary: "claude",
    home: {
      title: "CLAUDE_CONFIG_DIR path",
      description: "Custom Claude config directory.",
      placeholder: "~/.claude",
    },
    launchArgs: null,
  },
} as const;

function AgentEditor({
  kind,
  state,
  provider,
  update,
}: {
  kind: "codex" | "claude";
  state: ProvidersState;
  provider: ProviderSnapshot;
  update: (patch: AgentSettingsPatch) => void;
}) {
  const meta = AGENT_RUNTIME[kind];
  const settings = state.settings[kind];
  const set = (patch: Record<string, string>) => update({ [kind]: patch });
  return (
    <>
      <SettingsSection title="Runtime">
        <SettingsRow
          {...searchableSetting("agent-binary-path")}
          resetAction={
            settings.binaryPath ? (
              <SettingResetButton
                label={`${meta.name} binary path`}
                onClick={() => set({ binaryPath: "" })}
              />
            ) : null
          }
          description={`Path to the ${meta.name} binary. Empty uses \`${meta.binary}\` from your shell's PATH.`}
          control={
            <DraftInput
              value={settings.binaryPath}
              onCommit={(binaryPath) => set({ binaryPath })}
              placeholder={meta.binary}
              aria-label={`${meta.name} binary path`}
              className="font-mono @min-[32rem]/settings-row:w-56"
            />
          }
        />
        <SettingsRow
          title={meta.home.title}
          resetAction={
            settings.homePath ? (
              <SettingResetButton label={meta.home.title} onClick={() => set({ homePath: "" })} />
            ) : null
          }
          description={meta.home.description}
          control={
            <DraftInput
              value={settings.homePath}
              onCommit={(homePath) => set({ homePath })}
              placeholder={meta.home.placeholder}
              aria-label={meta.home.title}
              className="font-mono @min-[32rem]/settings-row:w-56"
            />
          }
        />
        {meta.launchArgs && kind === "codex" ? (
          <SettingsRow
            title="Launch arguments"
            resetAction={
              state.settings.codex.launchArgs ? (
                <SettingResetButton
                  label="launch arguments"
                  onClick={() => set({ launchArgs: "" })}
                />
              ) : null
            }
            description={meta.launchArgs}
            control={
              <DraftInput
                value={state.settings.codex.launchArgs}
                onCommit={(launchArgs) => set({ launchArgs })}
                placeholder="e.g. -c key=value"
                aria-label={`${meta.name} launch arguments`}
                className="font-mono @min-[32rem]/settings-row:w-56"
              />
            }
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("agent-access")}
          resetAction={
            settings.runtimeMode !== "full-access" ? (
              <SettingResetButton
                label={`${meta.name} access`}
                onClick={() => set({ runtimeMode: "full-access" })}
              />
            ) : null
          }
          description={`Default for new turns; also switchable from the composer (${shortcutText("mod+shift+a")}).`}
          control={
            <Select
              value={settings.runtimeMode}
              onValueChange={(value) => set({ runtimeMode: value as RuntimeMode })}
            >
              <SelectTrigger variant="pill" aria-label={`${meta.name} access`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RUNTIME_MODE_OPTIONS.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>
      <ModelsSection
        provider={provider}
        selectedModel={settings.model}
        onPick={(model) => set({ model })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pane
// ---------------------------------------------------------------------------

export function ProvidersPane() {
  const query = useAgentProviders();
  const setState = useSetProvidersState();
  const state = query.data;
  const [selectedKind, setSelectedKind] = useState<ProviderKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(1000);

  const update = (patch: AgentSettingsPatch) => {
    console.log("[Settings:updateAgent]", patch);
    gmailApi
      .updateAgentSettings(patch)
      .then(setState, (error: unknown) =>
        toast.error(`Could not save: ${error instanceof Error ? error.message : String(error)}`),
      );
  };

  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void gmailApi.refreshAgentProviders().catch(() => {});
    // Results arrive as broadcasts; keep the spinner up while the probes run.
    setTimeout(() => setRefreshing(false), 1500);
  };

  if (!state) {
    return (
      <SettingsPageContainer title="Agents">
        <p className="text-sm text-muted-foreground">
          {query.isError ? "Provider settings are unavailable." : "Loading provider settings…"}
        </p>
      </SettingsPageContainer>
    );
  }

  const providers = state.providers;
  const current =
    providers.find((p) => p.kind === (selectedKind ?? state.selected)) ?? providers[0];
  const lastChecked = Math.max(0, ...providers.map((p) => p.checkedAt ?? 0));

  return (
    <SettingsPageContainer
      title="Agents"
      description="The agents behind chat. Turn them on, pick one for new chats, and set it up."
      action={
        <Btn
          size="sm"
          variant="ghost-muted"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={refresh}
          title="Refresh provider status"
        >
          <RotateCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
          <span className="sr-only">Refresh provider status</span>
          <span className="hidden min-w-0 truncate sm:inline">
            {refreshing ? (
              "Refreshing providers"
            ) : lastChecked ? (
              <>
                Checked{" "}
                <span className="font-mono tabular-nums">{formatAgo(now - lastChecked)}</span>
              </>
            ) : (
              "Checking…"
            )}
          </span>
        </Btn>
      }
    >
      <SettingsSection
        {...searchableSetting("agent-providers")}
        headerAction={
          state.selected !== "openrouter" ? (
            <SettingResetButton
              label="default agent"
              onClick={() => update({ selected: "openrouter" })}
            />
          ) : null
        }
      >
        {providers.map((p) => (
          <ProviderListRow
            key={p.kind}
            provider={p}
            selected={p.kind === current.kind}
            isDefault={p.kind === state.selected}
            onSelect={() => setSelectedKind(p.kind)}
            onToggle={(enabled) => update({ [p.kind]: { enabled } })}
          />
        ))}
      </SettingsSection>
      <EditorHeader
        provider={current}
        isDefault={current.kind === state.selected}
        onMakeDefault={() => update({ selected: current.kind })}
      />
      {current.kind === "hermes" ? (
        <HermesEditor state={state} provider={current} update={update} />
      ) : current.kind === "openclaw" ? (
        <OpenClawEditor state={state} provider={current} update={update} />
      ) : current.kind === "openrouter" ? (
        <>
          <OpenRouterConnection provider={current} />
          <SettingsSection title="Access">
            <SettingsRow
              title="Tool approval"
              description="Choose how much the agent may do without asking. You can also change this in the composer."
              control={
                <Select
                  value={state.settings.openrouter.runtimeMode}
                  onValueChange={(value) =>
                    update({ openrouter: { runtimeMode: value as RuntimeMode } })
                  }
                >
                  <SelectTrigger variant="pill" aria-label="OpenRouter access">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RUNTIME_MODE_OPTIONS.map((mode) => (
                      <SelectItem key={mode.value} value={mode.value}>
                        {mode.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SettingsSection>
          <ModelsSection
            provider={current}
            selectedModel={state.settings.openrouter.model}
            onPick={(model) => update({ openrouter: { model } })}
          />
        </>
      ) : (
        <AgentEditor kind={current.kind} state={state} provider={current} update={update} />
      )}
      <FollowUpSection />
      {features.localAgents ? <ConnectedAgentsSection /> : null}
    </SettingsPageContainer>
  );
}

/** T3's "Follow-up behavior": what Enter does while the agent is working. */
function FollowUpSection() {
  const behavior = useFollowUpBehavior();
  return (
    <SettingsSection title="Chat">
      <SettingsRow
        {...searchableSetting("follow-up-behavior")}
        resetAction={
          behavior !== "queue" ? (
            <SettingResetButton
              label="follow-up behavior"
              onClick={() => setFollowUpBehavior("queue")}
            />
          ) : null
        }
        description={`Queue follow-ups while the agent runs or steer the current run. Press ${shortcutText("mod+enter")} to do the opposite for one message.`}
        control={
          <Select
            value={behavior}
            onValueChange={(value) => setFollowUpBehavior(value as FollowUpBehavior)}
          >
            <SelectTrigger variant="pill" aria-label="Follow-up behavior">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="queue">Queue</SelectItem>
              <SelectItem value="steer">Steer</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SettingsSection>
  );
}

const AGENT_ACCESS: { value: AgentAccess; label: string; description: string }[] = [
  {
    value: "read-only",
    label: "Read only",
    description: "Reads your mail, calendars and projects. Changes nothing.",
  },
  {
    value: "safe",
    label: "Safe",
    description:
      "Anything you can undo: archive, label, trash, drafts, projects. Never sends or deletes for good.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Anything, sending mail and calendar invitations included.",
  },
];

/**
 * One line to paste in Terminal that adds the server, with a new token, to
 * each agent: Claude Code's own command; for Codex, whose `mcp add` takes no
 * header, the server in its config.toml (replacing an older one); Cursor's
 * install link (cursor.com/docs/mcp/install-links), which asks first.
 */
const AGENT_COMMANDS: { agent: string; text: (url: string, token: string) => string }[] = [
  {
    agent: "Claude Code",
    text: (url, token) =>
      `claude mcp add --scope user --transport http otter-mail ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    agent: "Codex",
    text: (url, token) =>
      `codex mcp remove otter-mail >/dev/null 2>&1; printf '\\n[mcp_servers.otter-mail]\\nurl = "${url}"\\nhttp_headers = { Authorization = "Bearer ${token}" }\\n' >> ~/.codex/config.toml`,
  },
  {
    agent: "Cursor",
    text: (url, token) =>
      `open 'cursor://anysphere.cursor-deeplink/mcp/install?name=otter-mail&config=${btoa(JSON.stringify({ url, headers: { Authorization: `Bearer ${token}` } }))}'`,
  },
];

/**
 * Agents on this Mac that Otter Mail doesn't run (Claude Code, Cursor, …) get
 * its tools at the Mac app's MCP server with a token made here, each with as
 * much access as it's given. Nothing asks again: making the token was the
 * user's say.
 */
function ConnectedAgentsSection() {
  const qc = useQueryClient();
  const [access, setAccess] = useState<AgentAccess>("safe");
  const change = useMutation({
    mutationFn: ({ id, access }: { id: string; access: AgentAccess }) =>
      gmailApi.setConnectedAgentAccess(id, access),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["mcp:agents"] }),
    onError: (error) =>
      toast.error(`Could not save: ${error instanceof Error ? error.message : String(error)}`),
  });
  return (
    <AgentTokensSection<ConnectedAgent>
      {...searchableSetting("connected-agents")}
      description="Claude Code, Codex, Cursor or any agent that speaks MCP can use your mail, calendars, projects and views while Otter Mail is open."
      queryKey="mcp:agents"
      list={gmailApi.connectedAgents}
      create={(name) => gmailApi.addConnectedAgent(name, access)}
      revoke={gmailApi.removeConnectedAgent}
      defaultName="Claude Code"
      newTokenFields={
        <Field label="Access" orientation="vertical">
          <ToggleGroup
            aria-label="Access"
            className="w-full"
            value={[access]}
            onValueChange={(next) => {
              if (next[0]) setAccess(next[0] as AgentAccess);
            }}
          >
            {AGENT_ACCESS.map((option) => (
              <Toggle key={option.value} value={option.value} className="flex-1">
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <Text variant="small" color="secondary">
            {AGENT_ACCESS.find((o) => o.value === access)?.description}
          </Text>
        </Field>
      }
      renderControl={(agent) => (
        <RowSelect
          value={agent.access}
          onValueChange={(next) => change.mutate({ id: agent.id, access: next as AgentAccess })}
          options={AGENT_ACCESS}
          ariaLabel={`${agent.name}'s access`}
        />
      )}
      commands={AGENT_COMMANDS}
    />
  );
}
