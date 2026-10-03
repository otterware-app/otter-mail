import { useEffect, useRef, useState } from "react";
import type { UpdateState } from "@otter-mail/contracts";
import { changelogUrl } from "@otter-mail/shared/changelog";
import { openLink } from "./browser/store";

import { ArrowDownCircleIcon, SparklesIcon, XIcon } from "lucide-react";

import { Btn } from "./gmail/ui";
import { toast } from "./gmail/toast";
import { SettingsRow, SettingsSection } from "./settings/settings-ui";
import { searchableSetting } from "./settings/settings-search";

/** Live auto-update state from the main process. */
export function useUpdateState(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    void window.desktopBridge.updates.getState().then((next) => {
      if (alive) setState(next);
    });
    const off = window.desktopBridge.updates.onState(setState);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/**
 * Feedback for the app menu's "Check for Updates…" (mounted once in the main
 * window). Updates themselves download on their own and surface in the
 * sidebar's UpdateCard.
 */
export function UpdateNotifier() {
  const state = useUpdateState();
  const manualCheck = useRef(false);

  useEffect(
    () =>
      window.desktopBridge.on("updates:checkRequested", () => {
        manualCheck.current = true;
        void window.desktopBridge.updates.check();
      }),
    [],
  );

  useEffect(() => {
    if (!state || !manualCheck.current) return;
    if (state.status === "up-to-date") {
      manualCheck.current = false;
      toast.success("Otter Mail is up to date", { description: `Version ${state.currentVersion}` });
    } else if (state.status === "disabled" || state.status === "error") {
      manualCheck.current = false;
      toast.error("Couldn't check for updates", { description: state.message ?? undefined });
    } else if (state.status === "downloading" || state.status === "downloaded") {
      manualCheck.current = false;
      toast.info(`Otter Mail ${state.availableVersion} is on its way`, {
        description: "It's downloading; the sidebar offers a restart when it's ready.",
      });
    }
  }, [state]);

  return null;
}

/**
 * ⌘K "Update Otter Mail": checks, downloads and restarts into the new version
 * in one go, a toast following along. It picks up wherever the updater is: a
 * download underway is waited for, a downloaded update installs at once.
 */
export function updateNow(): void {
  const updates = window.desktopBridge.updates;
  console.log("[Updates:updateNow]");
  const id = toast.loading("Checking for updates…");
  const fail = (title: string, s: UpdateState) => {
    off();
    const url = s.manualDownloadUrl;
    toast.update(id, "error", title, {
      description: s.message ?? undefined,
      timeout: 0,
      action: url
        ? { label: "Download", onClick: () => void window.desktopBridge.openExternal(url) }
        : { label: "Try again", onClick: updateNow },
    });
  };
  const step = (s: UpdateState) => {
    if (s.manualDownloadUrl)
      return fail(`Otter Mail ${s.availableVersion} can't install itself`, s);
    switch (s.status) {
      case "available":
        void updates.download();
        return;
      case "downloading":
        toast.update(id, "loading", `Downloading Otter Mail ${s.availableVersion}`, {
          description: `${s.downloadPercent ?? 0}% · restarts when it's done`,
          timeout: 0,
        });
        return;
      case "downloaded":
        off();
        toast.update(id, "loading", `Restarting into Otter Mail ${s.availableVersion}…`, {
          timeout: 0,
        });
        void updates.install();
        return;
      case "up-to-date":
        off();
        toast.update(id, "success", "Otter Mail is up to date", {
          description: `Version ${s.currentVersion}`,
        });
        return;
      case "error":
        return fail("Couldn't update Otter Mail", s);
      case "disabled":
        return fail("Updates are unavailable", s);
    }
  };
  const off = updates.onState(step);
  void updates.getState().then((s) => {
    if (s.status === "downloaded" || s.status === "downloading" || s.status === "available")
      step(s);
    // A download that failed goes again; otherwise ask GitHub.
    else if (s.status === "error" && s.availableVersion && !s.manualDownloadUrl)
      void updates.download();
    else void updates.check();
  });
}

/**
 * A small card at the bottom of the sidebar while an update downloads and once
 * it's ready: "Restart to update" (it also installs when the app quits).
 */
export function UpdateCard() {
  const state = useUpdateState();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!state?.availableVersion || dismissed === state.availableVersion) return null;
  const failed = state.status === "error";
  if (state.status !== "downloading" && state.status !== "downloaded" && !failed) return null;

  const version = state.availableVersion;
  const manualUrl = state.manualDownloadUrl;
  const percent = Math.min(100, Math.max(0, state.downloadPercent ?? 0));
  return (
    <div className="mx-(--sidebar-content-inset) mb-1 rounded-xl border border-border/60 bg-card/60 px-3 py-2.5 shadow-xs/5">
      <div className="flex items-start gap-2">
        {state.status === "downloaded" ? (
          <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        ) : (
          <ArrowDownCircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {state.status === "downloaded"
              ? `Otter Mail ${version} is ready`
              : failed
                ? `Couldn't update to ${version}`
                : `Downloading Otter Mail ${version}`}
          </p>
          <p className="text-2xs text-muted-foreground">
            {state.status === "downloaded"
              ? "Restart to finish updating."
              : manualUrl
                ? "Install this version by hand."
                : failed
                  ? "It will try again later."
                  : `${percent}%`}
          </p>
          {/* The site's changelog: not every release has a note, so the index rather
              than the version's page. */}
          {state.status === "downloading" || state.status === "downloaded" ? (
            <button
              type="button"
              onClick={() => openLink(changelogUrl())}
              className="cursor-pointer text-2xs text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
            >
              Changelog →
            </button>
          ) : null}
        </div>
        {state.status === "downloaded" ? (
          <button
            type="button"
            aria-label="Hide until next launch"
            onClick={() => setDismissed(version)}
            className="-mr-1 -mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:bg-accent-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <XIcon className="size-3" />
          </button>
        ) : null}
      </div>
      {state.status === "downloading" ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
      {state.status === "downloaded" ? (
        <Btn
          size="xs"
          variant="primary"
          className="mt-2 w-full"
          onClick={() => void window.desktopBridge.updates.install()}
        >
          Restart to update
        </Btn>
      ) : null}
      {manualUrl ? (
        <Btn
          size="xs"
          variant="primary"
          className="mt-2 w-full"
          onClick={() => void window.desktopBridge.openExternal(manualUrl)}
        >
          Download {version}
        </Btn>
      ) : failed ? (
        <Btn
          size="xs"
          className="mt-2 w-full"
          onClick={() => void window.desktopBridge.updates.download()}
        >
          Retry
        </Btn>
      ) : null}
    </div>
  );
}

function statusLine(state: UpdateState): string {
  switch (state.status) {
    case "disabled":
      return state.message ?? "Updates are unavailable in this build.";
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Version ${state.availableVersion} is available.`;
    case "downloading":
      return `Downloading version ${state.availableVersion}… ${state.downloadPercent ?? 0}%`;
    case "downloaded":
      return `Version ${state.availableVersion} is ready. Restart to install it.`;
    case "up-to-date":
      return "You're on the latest version.";
    case "error":
      return state.message ?? "The last update check failed.";
    default:
      return "Updates download on their own.";
  }
}

/** Settings → General: version, status, and the check / restart button. */
export function UpdatesSection() {
  const state = useUpdateState();
  if (!state) return null;

  const updates = window.desktopBridge.updates;
  const manualUrl = state.manualDownloadUrl;
  const control = manualUrl ? (
    <Btn
      variant="primary"
      size="sm"
      onClick={() => void window.desktopBridge.openExternal(manualUrl)}
    >
      Download {state.availableVersion}
    </Btn>
  ) : state.status === "available" ? (
    <Btn variant="primary" size="sm" onClick={() => void updates.download()}>
      Download
    </Btn>
  ) : state.status === "downloaded" ? (
    <Btn variant="primary" size="sm" onClick={() => void updates.install()}>
      Restart to Update
    </Btn>
  ) : state.status === "disabled" ? null : (
    <Btn
      size="sm"
      disabled={state.status === "checking" || state.status === "downloading"}
      onClick={() => void updates.check()}
    >
      Check for Updates
    </Btn>
  );

  return (
    <SettingsSection {...searchableSetting("updates")}>
      <SettingsRow
        title={`Otter Mail ${state.currentVersion}`}
        description={statusLine(state)}
        control={control}
      />
    </SettingsSection>
  );
}
