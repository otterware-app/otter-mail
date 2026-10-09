/**
 * Renderer side of the agent providers: the live provider state, icons,
 * and the status wording shared by Settings and the chat composer (ported
 * from T3 Code's providerStatus / providerDriverMeta).
 */

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gmailApi, type ProviderKind, type ProviderSnapshot, type ProvidersState } from "./api";
import { cn } from "./ui";
import hermesIconUrl from "../assets/hermes-agent-icon.png";

const PROVIDERS_KEY = ["agent-providers"] as const;

/** Provider snapshots + settings, kept live by `agent:providersChanged`. */
export function useAgentProviders() {
  const qc = useQueryClient();
  useEffect(
    () =>
      window.desktopBridge.on("agent:providersChanged", (state: unknown) =>
        qc.setQueryData(PROVIDERS_KEY, state as ProvidersState),
      ),
    [qc],
  );
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => gmailApi.agentProviders(),
    staleTime: 30_000,
  });
}

/** Writes the state an update call returns, so the UI doesn't wait for the broadcast. */
export function useSetProvidersState() {
  const qc = useQueryClient();
  return (state: ProvidersState) => qc.setQueryData(PROVIDERS_KEY, state);
}

/** OpenAI mark, as T3 Code draws Codex. */
function OpenAIIcon({ className }: { className?: string }) {
  return (
    <svg
      preserveAspectRatio="xMidYMid"
      viewBox="0 0 256 260"
      className={cn("fill-black dark:fill-white", className)}
      aria-hidden
    >
      <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
    </svg>
  );
}

/**
 * The Hermes Agent mark (the Nous mascot), as T3 Code's HermesIcon draws it.
 * Black-on-white art in a rounded tile, so it doesn't follow currentColor.
 */
function HermesIcon({ className }: { className?: string }) {
  return <img src={hermesIconUrl} alt="" aria-hidden draggable={false} className={className} />;
}

/** The OpenClaw lobster, from openclaw.ai's favicon. */
function OpenClawIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="openclaw-lobster" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="100%" stopColor="#991b1b" />
        </linearGradient>
      </defs>
      <path
        d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
        fill="url(#openclaw-lobster)"
      />
      <path
        d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
        fill="url(#openclaw-lobster)"
      />
      <path
        d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
        fill="url(#openclaw-lobster)"
      />
      <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="35" r="6" fill="#050810" />
      <circle cx="75" cy="35" r="6" fill="#050810" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
    </svg>
  );
}

/** Anthropic's Claude mark, as T3 Code draws Claude. */
function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg
      preserveAspectRatio="xMidYMid"
      viewBox="0 0 256 257"
      className={cn("fill-[#d97757]", className)}
      aria-hidden
    >
      <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
    </svg>
  );
}

export function ProviderIcon({ kind, className }: { kind: ProviderKind; className?: string }) {
  if (kind === "openrouter")
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className={cn("size-4", className)}
        aria-hidden
      >
        <path d="M3 12h5c3 0 3-7 6-7h6M8 12c3 0 3 7 6 7h6M17 2l3 3-3 3M17 16l3 3-3 3" />
      </svg>
    );
  if (kind === "codex") return <OpenAIIcon className={cn("size-4", className)} />;
  if (kind === "claude") return <ClaudeIcon className={cn("size-4", className)} />;
  if (kind === "openclaw") return <OpenClawIcon className={cn("size-4", className)} />;
  return <HermesIcon className={cn("size-4", className)} />;
}

export const PROVIDER_STATUS_DOT: Record<ProviderSnapshot["status"], string> = {
  disabled: "bg-muted-foreground/50",
  error: "bg-destructive",
  ready: "bg-success",
  warning: "bg-warning",
};

/** `1.2.3` → `v1.2.3`. */
export function providerVersionLabel(version: string | null): string | null {
  if (!version) return null;
  return /^\d+\.\d+/.test(version) ? `v${version}` : version;
}

/** Headline + detail for a provider, in T3 Code's precedence order. */
export function providerSummary(p: ProviderSnapshot | undefined): {
  headline: string;
  detail?: string;
} {
  if (!p || (p.checkedAt === null && p.enabled))
    return {
      headline: "Checking provider status",
      detail: "Waiting for installation and authentication details.",
    };
  if (!p.enabled || p.status === "disabled")
    return {
      headline: "Disabled",
      detail: `${p.displayName} is turned off for new chats.`,
    };
  if (!p.installed)
    return {
      headline: p.kind === "hermes" || p.kind === "openclaw" ? "Not connected" : "Not found",
      detail: p.message ?? (p.kind === "codex" ? "CLI not detected on PATH." : undefined),
    };
  if (p.auth.status === "unauthenticated")
    return { headline: "Not authenticated", detail: p.message };
  if (p.status === "warning")
    return {
      headline: "Needs attention",
      detail: p.message ?? "The provider could not be fully verified.",
    };
  if (p.status === "error")
    return {
      headline: "Unavailable",
      detail: p.message ?? "The provider failed its startup checks.",
    };
  // OpenClaw's label is who the gateway takes this device for: a person, or its shared owner.
  if (p.auth.status === "authenticated" && p.kind === "openclaw" && p.auth.label)
    return { headline: `Connected as ${p.auth.label}`, detail: p.message };
  if (p.auth.status === "authenticated")
    return {
      headline: p.auth.label ? `Authenticated · ${p.auth.label}` : "Authenticated",
      detail: p.message,
    };
  return { headline: "Available", detail: p.message };
}

/** A provider that can take a turn right now. */
export function isProviderUsable(p: ProviderSnapshot | undefined): boolean {
  if (p?.kind === "openrouter" && p.auth.status !== "authenticated") return false;
  return Boolean(p && p.enabled && p.status !== "error" && (p.installed || p.checkedAt === null));
}
