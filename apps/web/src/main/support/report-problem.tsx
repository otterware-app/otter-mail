import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FileJsonIcon,
  ImagePlusIcon,
  TerminalIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  buildSupportIssue,
  buildSupportPrompt,
  MAX_SUPPORT_BODY,
  SUPPORT_PLATFORMS,
  SUPPORT_TYPES,
  parseSupportDraft,
  supportError,
  supportIssueUrl,
  type SupportAgent,
  type SupportDiagnostics,
  type SupportDraft,
  type SupportError,
  type SupportReport,
  type SupportSession,
  type SupportTerminals,
} from "@otter-mail/shared/support";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { features } from "../features";
import { Btn } from "../mail/ui";
import { mailApi } from "../mail/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../mail/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuTrigger,
} from "../mail/menu";
import { toast } from "../mail/toast";

export function requestProblemReport(): void {
  // Let the originating menu close before Radix transfers focus to the sheet.
  setTimeout(() => window.dispatchEvent(new Event("otter:report-problem")), 0);
}

const TEXTAREA =
  "w-full resize-y rounded-lg border border-border/70 bg-surface-raised/60 px-3 py-2 text-sm leading-5 outline-none placeholder:text-placeholder focus-visible:border-focus-ring/60 focus-visible:ring-[3px] focus-visible:ring-focus-ring/16";
const currentPlatform: keyof typeof SUPPORT_PLATFORMS =
  window.desktopBridge.platform === "web"
    ? "web"
    : window.desktopBridge.platform === "linux"
      ? "linux"
      : "mac";
const emptyReport: SupportReport = {
  kind: "bug",
  platform: currentPlatform,
  title: "",
  happened: "",
  expected: "",
  steps: "",
};

/** One report, reviewed before it leaves the app; investigations live in the user's terminal. */
export function ReportProblemDialog() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"describe" | "review">("describe");
  const [report, setReport] = useState<SupportReport>(emptyReport);
  const [diagnostics, setDiagnostics] = useState<SupportDiagnostics | null>(null);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<SupportAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [terminals, setTerminals] = useState<SupportTerminals | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "launch" | "github" | null>(null);
  const [screenshot, setScreenshot] = useState<{ file: File; url: string } | null>(null);
  const [session, setSession] = useState<SupportSession | null>(null);
  const [draftStatus, setDraftStatus] = useState<"waiting" | "ready" | null>(null);
  const [draftKind, setDraftKind] = useState<SupportDraft["kind"]>("issue");
  const [pendingDraft, setPendingDraft] = useState<SupportDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const draftBase = useRef<{ title: string; body: string } | null>(null);
  const seenDraft = useRef("");
  const edited = useRef(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLInputElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const rendererErrors = useRef<SupportError[]>([]);

  useEffect(() => {
    const show = () => {
      setLoading(true);
      setDiagnostics(null);
      setAgents([]);
      setAgentsLoading(features.externalAgent);
      setOpen(true);
      setError(null);
    };
    window.addEventListener("otter:report-problem", show);
    const pullRequest = () => {
      void window.desktopBridge
        .invoke<boolean>("support:takeRequested")
        .then((requested) => {
          if (requested) show();
        })
        .catch(() => {});
    };
    const off = window.desktopBridge.on("support:open", pullRequest);
    let active = true;
    if (features.externalAgent) {
      pullRequest();
      void window.desktopBridge
        .invoke<SupportSession | null>("support:resumeSession")
        .then((saved) => {
          if (!active || !saved || edited.current) return;
          draftBase.current = { title: saved.report.title, body: saved.body };
          setSession(saved);
          setReport({ ...emptyReport, ...saved.report });
          setBody(saved.body);
          setIncludeDiagnostics(!!saved.diagnostics);
          setStep("review");
          setDraftStatus("waiting");
        })
        .catch(() => {});
    }
    const record = (text: string) => {
      const summary = supportError(new Date().toISOString(), "renderer", text);
      if (summary) rendererErrors.current = [...rendererErrors.current, summary].slice(-10);
    };
    const onError = (event: ErrorEvent) =>
      record(event.error instanceof Error ? (event.error.stack ?? event.message) : event.message);
    const onRejection = (event: PromiseRejectionEvent) =>
      record(
        event.reason instanceof Error
          ? (event.reason.stack ?? event.reason.message)
          : String(event.reason),
      );
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      active = false;
      window.removeEventListener("otter:report-problem", show);
      off();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    if (screenshot) return () => URL.revokeObjectURL(screenshot.url);
  }, [screenshot]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.desktopBridge
      .invoke<SupportDiagnostics>("support:diagnostics")
      .then(
        (snapshot) => {
          if (active)
            setDiagnostics({
              ...snapshot,
              errors: [...snapshot.errors, ...rendererErrors.current].slice(-50),
            });
        },
        () => {
          if (active)
            setError("Diagnostics couldn't be collected. You can still report the problem.");
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    if (features.externalAgent) {
      void window.desktopBridge
        .invoke<SupportTerminals>("support:terminals")
        .then((available) => {
          if (active) setTerminals(available);
        })
        .catch(() => {});
      void window.desktopBridge
        .invoke<SupportAgent[]>("support:agents")
        .then((available) => {
          if (!active) return;
          setAgents(available);
        })
        .catch(() => {
          /* The portable download remains available. */
        })
        .finally(() => {
          if (active) setAgentsLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    if (!session) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const draft = await window.desktopBridge.invoke<SupportDraft | null>("support:readDraft", {
          id: session.id,
        });
        if (!active) return;
        setDraftError(null);
        if (draft) {
          const version = JSON.stringify(draft);
          if (version !== seenDraft.current) {
            seenDraft.current = version;
            if (draftBase.current?.title === report.title && draftBase.current.body === body) {
              draftBase.current = draft;
              setBody(draft.body);
              setReport((current) => ({ ...current, title: draft.title }));
              setDraftKind(draft.kind);
              setPendingDraft(null);
              setDraftStatus("ready");
              if (!open)
                toast.success(
                  "Your agent's findings are ready. Open Send feedback to review them.",
                );
            } else {
              setPendingDraft(draft);
            }
          }
        }
      } catch (err) {
        if (active)
          setDraftError(err instanceof Error ? err.message : "Couldn't read the agent draft.");
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [session, report.title, body, open]);

  const change = <K extends keyof SupportReport>(key: K, value: SupportReport[K]) => {
    edited.current = true;
    setReport((current) => ({ ...current, [key]: value }));
  };
  const feedbackKind = report.kind ?? "bug";
  const affectedPlatform = report.platform ?? currentPlatform;
  const reportDiagnostics = session
    ? session.diagnostics
    : includeDiagnostics && affectedPlatform === currentPlatform
      ? diagnostics
      : null;
  const describedReport = () => ({
    ...report,
    kind: feedbackKind,
    platform: affectedPlatform,
    title:
      report.title.trim() ||
      report.happened.trim().split(/\r?\n/, 1)[0]?.slice(0, 120) ||
      "Otter Mail problem",
  });
  const describedBody = () =>
    buildSupportIssue(report, reportDiagnostics) +
    (screenshot
      ? "\n\n### Screenshot\nA screenshot was selected. Attach it on GitHub when submitting this report."
      : "");
  const review = () => {
    edited.current = true;
    setBody(describedBody());
    setReport(describedReport());
    setDraftKind("issue");
    setError(null);
    setStep("review");
  };
  const run = async (kind: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const github = () =>
    run("github", async () => {
      let url = supportIssueUrl(report.title, body, feedbackKind);
      if (!url) {
        await navigator.clipboard.writeText(body);
        toast.success("Report copied. Paste it into the GitHub description.");
        url = supportIssueUrl(
          report.title,
          "Paste the report copied from Otter Mail here.",
          feedbackKind,
        )!;
      }
      await window.desktopBridge.openExternal(url);
      if (reportDiagnostics || screenshot || session?.hasScreenshot)
        toast.success(
          "Attach your diagnostics file and any screenshot on GitHub before submitting.",
        );
    });
  const save = (contents = body) =>
    run("save", async () => {
      const saved = await mailApi.saveSupportReport(
        buildSupportPrompt(`# ${describedReport().title}\n\n${contents}`, false, describedReport()),
      );
      if (saved) toast.success("Report saved. Open it in your coding agent to investigate.");
    });
  const saveDiagnostics = () =>
    run("save", async () => {
      if (!reportDiagnostics) return;
      const saved = await mailApi.saveSupportReport(
        JSON.stringify(reportDiagnostics, null, 2),
        "Otter Mail diagnostics.json",
      );
      if (saved) toast.success("Diagnostics saved. Attach the file on GitHub before submitting.");
    });
  const useDraft = (draft: SupportDraft) => {
    edited.current = true;
    draftBase.current = draft;
    setBody(draft.body);
    setReport((current) => ({ ...current, title: draft.title }));
    setDraftKind(draft.kind);
    setPendingDraft(null);
    setDraftStatus("ready");
    setStep("review");
  };
  const leaveSession = (newReport: boolean) =>
    run("launch", async () => {
      if (session) await window.desktopBridge.invoke("support:forgetSession", { id: session.id });
      setSession(null);
      setPendingDraft(null);
      setDraftStatus(null);
      setDraftError(null);
      setDraftKind("issue");
      draftBase.current = null;
      seenDraft.current = "";
      if (newReport) {
        setReport(emptyReport);
        setBody("");
        setScreenshot(null);
        setStep("describe");
      }
    });
  const investigate = (agent: SupportAgent["id"]) =>
    run("launch", async () => {
      const sendingReport = describedReport();
      const sendingBody = step === "describe" ? describedBody() : body;
      const image = screenshot
        ? { mime: screenshot.file.type, bytes: new Uint8Array(await screenshot.file.arrayBuffer()) }
        : undefined;
      const launched = await window.desktopBridge.invoke<SupportSession>("support:launchAgent", {
        agent,
        report: sendingReport,
        body: sendingBody,
        diagnostics: reportDiagnostics,
        screenshot: image,
      });
      edited.current = true;
      draftBase.current = { title: sendingReport.title, body: sendingBody };
      seenDraft.current = "";
      setSession(launched);
      setReport(sendingReport);
      setBody(sendingBody);
      setStep("review");
      setPendingDraft(null);
      setDraftError(null);
      setDraftKind("issue");
      setDraftStatus("waiting");
      toast.success("Investigation opened in your terminal. Its findings will return here.");
    });
  const terminalName = terminals?.apps.find((item) => item.id === terminals.selectedId)?.name;
  const chooseTerminal = (id: string | null) =>
    run("save", async () => {
      setTerminals(
        await window.desktopBridge.invoke<SupportTerminals>("support:setTerminal", { id }),
      );
    });

  const hasDescription =
    [report.title, report.happened, report.expected, report.steps].some((value) => value.trim()) ||
    !!screenshot;
  const canContinue =
    !busy &&
    (step === "describe"
      ? !loading && hasDescription
      : !!report.title.trim() && !!body.trim() && draftStatus !== "waiting" && !pendingDraft);
  const continueReport = () => {
    if (!canContinue) return;
    if (step === "describe") review();
    else if (draftKind === "findings") setOpen(false);
    else void github();
  };

  const agentMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Btn
          variant="primary"
          className="rounded-l-none border-l-primary-foreground/20 px-2"
          aria-label="Report actions"
          disabled={!!busy || loading}
        >
          <ChevronDownIcon />
        </Btn>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        {!session ? (
          <>
            <DropdownMenuLabel>
              {feedbackKind === "feature" ? "Refine with an agent" : "Investigate first"}
            </DropdownMenuLabel>
            {agents.map((item) => (
              <DropdownMenuItem
                key={item.id}
                icon={<TerminalIcon />}
                onSelect={() => void investigate(item.id)}
              >
                Send to {item.label}
              </DropdownMenuItem>
            ))}
            {features.externalAgent && agents.length === 0 ? (
              <DropdownMenuLabel>
                {agentsLoading ? "Checking local agents…" : "No local Claude or Codex found"}
              </DropdownMenuLabel>
            ) : null}
            <DropdownMenuItem
              icon={<DownloadIcon />}
              onSelect={() => void save(step === "describe" ? describedBody() : body)}
            >
              Download for another agent
            </DropdownMenuItem>
            <DropdownMenuLabel className="max-w-64 whitespace-normal font-normal">
              {features.externalAgent && agents.length > 0
                ? "Your report and files go to the agent’s AI provider. Its draft returns here for review."
                : "Open the download in your coding agent, then import its draft here."}
            </DropdownMenuLabel>
          </>
        ) : (
          <DropdownMenuItem onSelect={() => void leaveSession(true)}>New report</DropdownMenuItem>
        )}
        {terminals ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub label={"Terminal: " + (terminalName ?? "System default")}>
              <DropdownMenuCheckboxItem
                checked={!terminals.selectedId}
                onSelect={() => void chooseTerminal(null)}
              >
                System default{terminals.defaultName ? " (" + terminals.defaultName + ")" : ""}
              </DropdownMenuCheckboxItem>
              {terminals.apps.map((item) => (
                <DropdownMenuCheckboxItem
                  key={item.id}
                  checked={terminals.selectedId === item.id}
                  onSelect={() => void chooseTerminal(item.id)}
                >
                  {item.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSub>
          </>
        ) : null}
        {step === "describe" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<UploadIcon />} onSelect={() => draftInput.current?.click()}>
              Import agent draft
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogContent
        size="xl"
        className="max-w-[40rem]"
        showCloseButton
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          messageInput.current?.focus();
        }}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            continueReport();
          }
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between pr-7">
            <DialogTitle>Send feedback</DialogTitle>
            {step === "review" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Btn
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={!!busy}
                    aria-label="More report options"
                  >
                    <EllipsisIcon />
                  </Btn>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    icon={<CopyIcon />}
                    onSelect={() =>
                      void navigator.clipboard.writeText(body).then(
                        () => toast.success("Report copied."),
                        () =>
                          setError(
                            "Couldn't copy the report. Select the preview text and copy it.",
                          ),
                      )
                    }
                  >
                    Copy report
                  </DropdownMenuItem>
                  <DropdownMenuItem icon={<DownloadIcon />} onSelect={() => void save()}>
                    Download for an agent
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    icon={<UploadIcon />}
                    onSelect={() => draftInput.current?.click()}
                  >
                    Import agent draft
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {session ? (
                    <DropdownMenuItem
                      onSelect={() =>
                        void run("save", async () => {
                          await window.desktopBridge.invoke("support:showFiles", {
                            id: session.id,
                          });
                        })
                      }
                    >
                      Show report files
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => void leaveSession(true)}>
                    New report
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
          <DialogDescription>
            {step === "describe"
              ? "Share a bug or an idea. You’ll review it before sending."
              : SUPPORT_TYPES[feedbackKind] +
                " · " +
                SUPPORT_PLATFORMS[affectedPlatform] +
                ". Review before continuing to GitHub."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-1">
          {step === "describe" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <fieldset className="flex rounded-lg bg-surface-raised/60 p-1" disabled={!!busy}>
                  <legend className="sr-only">Feedback type</legend>
                  {(["bug", "feature"] as const).map((kind) => (
                    <label key={kind} className="cursor-pointer">
                      <input
                        type="radio"
                        name="support-feedback-type"
                        value={kind}
                        checked={feedbackKind === kind}
                        className="peer sr-only"
                        onChange={() => {
                          change("kind", kind);
                          setIncludeDiagnostics(
                            kind === "bug" && affectedPlatform === currentPlatform,
                          );
                        }}
                      />
                      <span className="block rounded-md px-3 py-1 text-[13px] text-muted-foreground peer-checked:bg-accent-surface peer-checked:text-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-focus-ring peer-disabled:opacity-64">
                        {SUPPORT_TYPES[kind]}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Platform</span>
                  <Select
                    disabled={!!busy}
                    value={affectedPlatform}
                    onValueChange={(value) => {
                      change("platform", value as NonNullable<SupportReport["platform"]>);
                      setIncludeDiagnostics(feedbackKind === "bug" && value === currentPlatform);
                    }}
                  >
                    <SelectTrigger variant="pill" aria-label="Affected platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(SUPPORT_PLATFORMS).map(([platform, label]) => (
                        <SelectItem key={platform} value={platform}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Field label="Message">
                <textarea
                  ref={messageInput}
                  disabled={!!busy}
                  className={TEXTAREA + " min-h-44"}
                  rows={7}
                  maxLength={6_000}
                  value={report.happened}
                  placeholder={
                    feedbackKind === "feature"
                      ? "What would you like to see? Tell us what it would help you do."
                      : "What went wrong? Include what you expected and how to reproduce it, if you can."
                  }
                  onChange={(event) => change("happened", event.target.value)}
                />
              </Field>
              {affectedPlatform === currentPlatform ? (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={!!busy || !diagnostics}
                      checked={includeDiagnostics}
                      onChange={(event) => {
                        edited.current = true;
                        setIncludeDiagnostics(event.target.checked);
                      }}
                      className="size-4 accent-primary"
                    />
                    Include diagnostics
                  </label>
                  <Btn
                    size="xs"
                    variant="ghost-muted"
                    disabled={!!busy || !diagnostics}
                    aria-expanded={showDiagnostics}
                    aria-controls="support-diagnostic-details"
                    onClick={() => setShowDiagnostics((current) => !current)}
                  >
                    {loading
                      ? "Collecting…"
                      : diagnostics
                        ? showDiagnostics
                          ? "Hide"
                          : "View"
                        : "Unavailable"}
                  </Btn>
                </div>
              ) : null}
              {affectedPlatform === currentPlatform && showDiagnostics && diagnostics ? (
                <div
                  id="support-diagnostic-details"
                  className="rounded-lg bg-surface-raised/60 p-3 text-xs text-muted-foreground"
                >
                  <p>
                    Otter Mail {diagnostics.version} · {diagnostics.mailboxes.length} anonymous
                    mailboxes · {diagnostics.errors.length} error summaries
                  </p>
                  <p className="mt-1">
                    Mail, addresses, credentials, and raw log messages are excluded.
                  </p>
                  <Btn
                    size="xs"
                    className="mt-2"
                    disabled={!!busy || !includeDiagnostics}
                    onClick={() => void saveDiagnostics()}
                  >
                    <DownloadIcon />
                    Download diagnostics
                  </Btn>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {session || draftKind === "findings" ? (
                <div className="flex flex-col gap-2 text-[13px] text-muted-foreground">
                  <p role="status" className="flex items-center gap-2">
                    <TerminalIcon className="size-4 shrink-0" />
                    {pendingDraft
                      ? "An agent draft is ready. Your edits have been kept."
                      : draftStatus === "waiting"
                        ? "Continue in your terminal. The agent’s draft will appear here."
                        : draftKind === "findings"
                          ? "The agent recommends no new issue."
                          : "The agent’s draft is ready to review."}
                  </p>
                  {pendingDraft ? (
                    <div className="flex gap-2">
                      <Btn size="sm" disabled={!!busy} onClick={() => useDraft(pendingDraft)}>
                        Use agent draft
                      </Btn>
                      <Btn
                        size="sm"
                        disabled={!!busy}
                        onClick={() => {
                          setPendingDraft(null);
                          setDraftStatus("ready");
                        }}
                      >
                        Keep my edits
                      </Btn>
                    </div>
                  ) : draftStatus === "waiting" ? (
                    <div>
                      <Btn
                        size="xs"
                        variant="ghost-muted"
                        disabled={!!busy}
                        onClick={() => void leaveSession(false)}
                      >
                        Use current report
                      </Btn>
                    </div>
                  ) : draftKind === "findings" && session ? (
                    <div>
                      <Btn
                        size="xs"
                        variant="ghost-muted"
                        disabled={!!busy}
                        onClick={() =>
                          useDraft({
                            title: session.report.title,
                            body: session.body,
                            kind: "issue",
                          })
                        }
                      >
                        Use original report
                      </Btn>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <Field label="Title">
                <Input
                  disabled={!!busy}
                  value={report.title}
                  maxLength={160}
                  onChange={(event) => change("title", event.target.value)}
                />
              </Field>
              <Field label={draftKind === "findings" ? "Findings" : "Description"}>
                <textarea
                  ref={messageInput}
                  disabled={!!busy}
                  className={TEXTAREA + " min-h-44"}
                  rows={8}
                  maxLength={MAX_SUPPORT_BODY}
                  value={body}
                  onChange={(event) => {
                    edited.current = true;
                    setBody(event.target.value);
                  }}
                />
              </Field>
              {reportDiagnostics ? (
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <FileJsonIcon className="size-4" />
                    Diagnostics file
                  </span>
                  <Btn
                    size="xs"
                    variant="ghost-muted"
                    disabled={!!busy}
                    onClick={() => void saveDiagnostics()}
                  >
                    <DownloadIcon />
                    Download
                  </Btn>
                </div>
              ) : null}
              {draftKind === "issue" ? (
                <p className="text-xs text-muted-foreground">
                  GitHub issues are public.
                  {reportDiagnostics || screenshot || session?.hasScreenshot
                    ? " Attach selected files in GitHub before submitting."
                    : ""}
                </p>
              ) : null}
            </>
          )}
          <input
            ref={draftInput}
            type="file"
            accept=".md,.markdown,text/markdown,text/plain"
            disabled={!!busy}
            aria-label="Choose agent draft"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void run("save", async () => {
                if (file.size > MAX_SUPPORT_BODY * 4)
                  throw new Error("The agent draft is too large.");
                useDraft(
                  parseSupportDraft(
                    await file.text(),
                    file.name === "findings.md" ? "findings" : "issue",
                  ),
                );
              });
            }}
          />
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={!!busy}
            aria-label="Choose screenshot"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
                setError("Choose a PNG, JPEG, or WebP screenshot under 5 MB.");
                return;
              }
              edited.current = true;
              setScreenshot({ file, url: URL.createObjectURL(file) });
              setError(null);
            }}
          />
          {screenshot ? (
            <div className="flex items-center gap-3">
              <img
                src={screenshot.url}
                alt="Selected screenshot"
                className="max-h-16 max-w-24 rounded-lg border border-border/60 object-contain"
              />
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                <p className="truncate">{screenshot.file.name}</p>
                <p className="mt-1">Check for private mail before sharing.</p>
              </div>
              {step === "describe" ? (
                <Btn
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={!!busy}
                  aria-label="Remove screenshot"
                  onClick={() => setScreenshot(null)}
                >
                  <XIcon />
                </Btn>
              ) : null}
            </div>
          ) : null}
          {error || draftError ? (
            <p role="alert" className="text-sm text-destructive">
              {error ?? draftError}
            </p>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          {step === "describe" ? (
            <Btn
              variant="ghost-muted"
              disabled={!!busy}
              onClick={() => imageInput.current?.click()}
            >
              <ImagePlusIcon />
              {screenshot ? "Change screenshot" : "Attach screenshot"}
            </Btn>
          ) : (
            <Btn
              variant="ghost-muted"
              disabled={!!busy}
              onClick={() => (session ? setOpen(false) : setStep("describe"))}
            >
              {session ? "Close" : "Back"}
            </Btn>
          )}
          <div className="flex justify-end">
            <Btn
              variant="primary"
              className="rounded-r-none"
              disabled={!canContinue}
              onClick={continueReport}
            >
              {busy === "launch"
                ? "Opening agent…"
                : busy === "github"
                  ? "Opening GitHub…"
                  : step === "describe"
                    ? "Review feedback"
                    : draftKind === "findings"
                      ? "Done"
                      : "Continue on GitHub"}
            </Btn>
            {agentMenu}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
