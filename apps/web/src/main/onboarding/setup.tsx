import { useLatest } from "../use-latest";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  InboxIcon,
  KeyboardIcon,
  LayersIcon,
  ListIcon,
  LoaderIcon,
  MousePointer2Icon,
  ServerIcon,
  ZapIcon,
} from "lucide-react";
import { Switch } from "~/components/ui/switch";
import {
  gmailApi,
  type NotificationsMode,
  type ProvidersState,
  type SyncSettings,
} from "../gmail/api";
import {
  ImapAccountDialog,
  MicrosoftMark,
  readableError,
  useAddOutlook,
} from "../gmail/add-mailbox";
import { getAccountDisplayName } from "../gmail/account-style";
import { AccountPicture } from "../gmail/account-picture";
import {
  getAdvanceDirection,
  setAdvanceDirection,
  type AdvanceDirection,
} from "../gmail/advance-direction";
import {
  PROVIDER_STATUS_DOT,
  ProviderIcon,
  isProviderUsable,
  providerSummary,
  useAgentProviders,
  useSetProvidersState,
} from "../gmail/agent-providers";
import {
  syncLabel,
  useAccountSync,
  useAccounts,
  useAddAccount,
  useGlobalSyncStatus,
  useMailProviders,
} from "../gmail/hooks";
import { toast } from "../gmail/toast";
import type { GmailAccount } from "../gmail/types";
import { Btn, cn } from "../gmail/ui";
import { WindowTitle } from "../gmail/top-bar";
import { OtterSignInOnboardingLink } from "../settings/otter-account-pane";
import {
  FontSizeRow,
  ReadingWidthRow,
  SchemeCard,
  ThemeCard,
  useColorScheme,
} from "../settings/appearance-pane";
import { SettingsGroup, SettingsRow, TextInput } from "../settings/settings-ui";
import { HERMES_URL_HINT, useConnectHermes } from "../settings/providers-pane";
import {
  setThemeForAppearance,
  themeColors,
  useAppThemes,
  useThemeChoice,
} from "../theme/apply-theme";
import { features } from "../features";
import { shortcutText } from "../keybindings/keys";
import { osNames } from "../os-names";
import { KEY_DRILL_COUNT, KeyTrainer } from "./key-trainer";
import { MailField } from "./mail-field";
import { ShortcutKeys } from "./keycap";
import {
  finishSetup,
  getSavedStep,
  getSetupStage,
  requestTour,
  saveStep,
  startSetup,
} from "./onboarding";
import otterIconUrl from "../assets/otter-mail-icon.png";

/**
 * First run: a mailbox, then the choices worth making up front (the look,
 * notifications, the agent) and the keys, each step doing the real thing.
 * It stands in for the mail view until it's finished or skipped, and its
 * last step offers the tour of the app.
 */

const STEPS = ["welcome", "mailbox", "look", "habits", "agent", "keys", "done"] as const;
type Step = (typeof STEPS)[number];

/** The steps the progress names (welcome and done frame them). */
const PROGRESS: { step: Step; label: string }[] = [
  { step: "mailbox", label: "Mail" },
  { step: "look", label: "Look" },
  { step: "habits", label: "Habits" },
  { step: "agent", label: "Agent" },
  { step: "keys", label: "Keys" },
];

const isStep = (value: string | null): value is Step => STEPS.includes(value as Step);

export function SetupFlow() {
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  // Run again with mail already here, the setup changes only what's clicked.
  const [firstRun] = useState(() => accounts.length === 0);
  // Asked now, so the agent step opens with its list rather than growing into it.
  useAgentProviders();
  const [step, setStep] = useState<Step>(() => {
    const saved = getSavedStep();
    if (isStep(saved)) return saved;
    // Every mailbox was removed after setting up: straight to adding one.
    return getSetupStage() === "done" ? "mailbox" : "welcome";
  });
  // Stays up once started, so adding the first mailbox doesn't end it.
  useEffect(() => {
    if (getSetupStage() !== "setup") startSetup(step);
  }, [step]);

  const go = (next: Step) => {
    console.log("[Setup:step]", { step: next });
    saveStep(next);
    setStep(next);
  };
  const index = STEPS.indexOf(step);
  const next = () => go(STEPS[Math.min(STEPS.length - 1, index + 1)]);
  const back = () => go(STEPS[Math.max(0, index - 1)]);

  const framed = step !== "welcome" && step !== "done";
  const canContinue = step !== "mailbox" || accounts.length > 0;

  return (
    <div className="surface-grain flex h-full flex-col bg-sidebar-surface text-foreground">
      <div className="flex shrink-0">
        <WindowTitle className="flex-1" />
      </div>
      <div className="relative isolate mx-1 mb-1 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-canvas">
        <MailField />
        <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-5 pt-4">
          <span />
          {framed ? <Progress step={step} /> : <span />}
          <div className="flex justify-end">
            {accounts.length > 0 && step !== "done" ? (
              <Btn variant="ghost-muted" size="sm" onClick={finishSetup}>
                Skip setup
              </Btn>
            ) : null}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Clips the step's slide in, which would otherwise overflow for a
              moment and bring in a scrollbar that nudges the page sideways. */}
          <div className="flex min-h-full overflow-clip">
            <div
              key={step}
              className="mx-auto flex w-full max-w-[48rem] flex-col justify-center px-8 py-10 motion-safe:animate-[onboarding-in_360ms_var(--ease-drawer)]"
            >
              {step === "welcome" ? <WelcomeStep onStart={next} /> : null}
              {step === "mailbox" ? <MailboxStep accounts={accounts} /> : null}
              {step === "look" ? <LookStep /> : null}
              {step === "habits" ? <HabitsStep /> : null}
              {step === "agent" ? <AgentStep firstRun={firstRun} /> : null}
              {step === "keys" ? <KeysStep /> : null}
              {step === "done" ? <DoneStep /> : null}
            </div>
          </div>
        </div>

        {framed ? (
          <footer className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-t border-border/50 px-5 py-3">
            <div>
              <Btn variant="ghost-muted" onClick={back}>
                <ArrowLeftIcon />
                Back
              </Btn>
            </div>
            <SyncNote accounts={accounts} />
            <div className="flex justify-end">
              <Btn variant="primary" disabled={!canContinue} onClick={next}>
                {step === "keys" ? "Finish" : "Continue"}
                <ArrowRightIcon />
              </Btn>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function Progress({ step }: { step: Step }) {
  const at = STEPS.indexOf(step);
  return (
    <ol className="flex items-center gap-1" aria-label="Setup progress">
      {PROGRESS.map((p, i) => {
        const done = STEPS.indexOf(p.step) < at;
        const current = p.step === step;
        return (
          <li key={p.step} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden className="h-px w-5 bg-border" /> : null}
            <span
              aria-current={current ? "step" : undefined}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[13px]",
                current
                  ? "bg-accent-surface text-foreground"
                  : done
                    ? "text-foreground/80"
                    : "text-muted-foreground",
              )}
            >
              {done ? <CheckIcon className="size-3.5 text-success" /> : null}
              {p.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** First sync keeps going while the rest of the setup runs; say so. */
function SyncNote({ accounts }: { accounts: GmailAccount[] }) {
  const sync = useGlobalSyncStatus(accounts.map((a) => a.id));
  if (!sync.syncing) return <span />;
  return (
    <span className="flex min-w-0 items-center gap-2 text-[13px] text-muted-foreground">
      <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate tabular-nums">{sync.label}</span>
    </span>
  );
}

function StepHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col items-center gap-2 text-center text-balance">
      <h1 className="text-[28px] font-medium leading-9 tracking-[-0.015em] text-foreground">
        {title}
      </h1>
      {description ? (
        <p className="max-w-[34rem] text-[15px] leading-6 text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 px-1 text-sm font-medium text-foreground">{children}</h2>;
}

/** A large selectable tile: icon, title, one line. */
function ChoiceCard({
  icon,
  title,
  description,
  selected,
  disabled,
  onClick,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-3 rounded-xl border bg-card p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default",
        selected
          ? "border-focus-ring ring-1 ring-focus-ring"
          : "border-border/60 hover:border-input enabled:hover:bg-accent-surface/40",
      )}
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent-surface text-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description ? (
          <span className="text-[13px] leading-[18px] text-muted-foreground">{description}</span>
        ) : null}
      </span>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

const PILLARS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <ZapIcon />,
    title: "Instant, even offline",
    body: "Your mail is kept on this device, so every folder, conversation and search opens at once.",
  },
  {
    icon: <KeyboardIcon />,
    title: "Made for the keyboard",
    body: `Gmail's shortcuts out of the box, each one yours to remap, and ${shortcutText("mod+k")} for everything else.`,
  },
  {
    icon: <MousePointer2Icon />,
    title: "An agent beside your mail",
    body: "Ask about a conversation, have it find that one email, or let it draft the reply.",
  },
  {
    icon: <LayersIcon />,
    title: "Every mailbox in one place",
    body: "Gmail and IMAP side by side, with views that cut across all of them.",
  },
];

function WelcomeStep({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center">
      <img
        src={otterIconUrl}
        alt=""
        className="mb-6 size-20 rounded-[22%] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.5)]"
      />
      <StepHeader
        title="Welcome to Otter Mail"
        description="Calm, fast email for Gmail and any IMAP mailbox. A minute of setup and you're in."
      />
      <div className="grid w-full grid-cols-2 gap-3">
        {PILLARS.map((p) => (
          <div
            key={p.title}
            className="flex gap-3 rounded-xl border border-border/60 bg-card p-4 [&_svg]:size-4"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-surface text-foreground">
              {p.icon}
            </span>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{p.title}</span>
              <span className="text-[13px] leading-[18px] text-muted-foreground">{p.body}</span>
            </div>
          </div>
        ))}
      </div>
      <Btn variant="primary" className="mt-9 h-10 px-5 text-[15px]" onClick={onStart}>
        Get started
        <ArrowRightIcon />
      </Btn>
      {/* Its line is kept while the account state loads, so nothing shifts. */}
      <div className="mt-5 h-5">
        <OtterSignInOnboardingLink />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2A11.9 11.9 0 0 1 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.1H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"
      />
    </svg>
  );
}

function MailboxStep({ accounts }: { accounts: GmailAccount[] }) {
  const addAccount = useAddAccount();
  const outlook = useAddOutlook();
  const hasOutlook = useMailProviders().data?.outlook ?? false;
  const waitingFor = addAccount.isPending ? "Google" : outlook.pending ? "Microsoft" : null;
  const [imapOpen, setImapOpen] = useState(false);
  const addGmail = async () => {
    console.log("[Setup:addGmail]");
    try {
      await addAccount.mutateAsync();
    } catch (err) {
      toast.error("Couldn't add the account", { description: readableError(err) });
    }
  };

  return (
    <>
      <StepHeader
        title={accounts.length > 0 ? "Your mail is connected" : "Connect your mail"}
        description="Otter Mail talks to your mail provider directly and keeps a copy on this device. If you use an agent, the mail and calendar data its tools return are shared with that agent."
      />
      <div className={cn("grid gap-3", hasOutlook ? "grid-cols-3" : "grid-cols-2")}>
        <ChoiceCard
          icon={<GoogleMark />}
          title="Gmail"
          description={
            addAccount.isPending
              ? "Finish signing in with Google…"
              : "Sign in with Google. Labels, categories and push included."
          }
          disabled={waitingFor !== null}
          onClick={() => void addGmail()}
        />
        {hasOutlook ? (
          <ChoiceCard
            icon={<MicrosoftMark />}
            title="Outlook"
            description={
              outlook.pending
                ? "Finish signing in with Microsoft…"
                : "Sign in with Microsoft. Folders, categories, calendar and push included."
            }
            disabled={waitingFor !== null}
            onClick={outlook.start}
          />
        ) : null}
        <ChoiceCard
          icon={<ServerIcon />}
          title="Other mail"
          description={
            hasOutlook
              ? "iCloud, Fastmail or any IMAP server, found from your address."
              : "iCloud, Fastmail, Outlook or any IMAP server, found from your address."
          }
          onClick={() => setImapOpen(true)}
        />
      </div>
      {waitingFor ? (
        <p className="mt-3 text-center text-[13px] text-muted-foreground">
          <LoaderIcon className="mr-1.5 inline size-3.5 animate-spin align-[-2px]" />
          Waiting for {waitingFor}.{" "}
          <button
            type="button"
            className="cursor-pointer text-foreground underline-offset-2 hover:underline"
            onClick={() => void gmailApi.cancelAddAccount()}
          >
            Cancel
          </button>
        </p>
      ) : null}

      {accounts.length > 0 ? (
        <div className="mt-8">
          <SectionTitle>Connected</SectionTitle>
          <SettingsGroup>
            {accounts.map((account) => (
              <ConnectedMailbox key={account.id} account={account} />
            ))}
          </SettingsGroup>
          <p className="mt-3 px-1 text-[13px] text-muted-foreground">
            Add as many as you like: they show side by side, and together under All mailboxes.
          </p>
        </div>
      ) : (
        <div className="mt-6 flex h-5 justify-center">
          <OtterSignInOnboardingLink />
        </div>
      )}
      <ImapAccountDialog open={imapOpen} onOpenChange={setImapOpen} />
    </>
  );
}

function ConnectedMailbox({ account }: { account: GmailAccount }) {
  // Starts its sync, and follows it.
  const status = useAccountSync(account.id);
  const busy = !!status && (status.syncing || status.download != null);
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <AccountPicture account={account} className="size-7 text-xs" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{getAccountDisplayName(account)}</div>
        <div className="truncate text-[13px] text-muted-foreground">{account.email}</div>
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums text-muted-foreground">
        {status?.error ? (
          <span className="text-destructive">{status.error}</span>
        ) : busy ? (
          <>
            <LoaderIcon className="size-3.5 animate-spin" />
            {syncLabel(status)}
          </>
        ) : status ? (
          <>
            <CheckIcon className="size-3.5 text-success" />
            Ready
          </>
        ) : (
          "Connecting…"
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

function LookStep() {
  const choice = useThemeChoice();
  const themes = useAppThemes();
  const [scheme, setScheme] = useColorScheme();
  const light = themeColors(choice.light, "light");
  const dark = themeColors(choice.dark, "dark");
  return (
    <>
      <StepHeader
        title="Make it yours"
        description="Everything changes as you click. Pick a theme for both, or just its light or dark half, then the text size and how wide mail reads."
      />
      <div className="grid grid-cols-3 gap-3">
        {(["system", "light", "dark"] as const).map((s) => (
          <SchemeCard
            key={s}
            scheme={s}
            selected={scheme === s}
            light={light}
            dark={dark}
            onSelect={() => void setScheme(s)}
          />
        ))}
      </div>
      <div className="mt-6 grid grid-cols-4 gap-3">
        {themes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            pickedModes={(["light", "dark"] as const).filter((m) => choice[m] === theme.id)}
            onPick={(modes) => {
              for (const mode of modes) setThemeForAppearance(mode, theme.id);
            }}
          />
        ))}
      </div>
      <SettingsGroup className="mt-6">
        <FontSizeRow />
        <ReadingWidthRow />
      </SettingsGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

const NOTIFY_CHOICES: {
  value: NotificationsMode;
  icon: ReactNode;
  title: string;
  description: string;
}[] = [
  {
    value: "inbox",
    icon: <InboxIcon />,
    title: "Inbox only",
    description: "New mail that lands in your inbox.",
  },
  {
    value: "all",
    icon: <BellIcon />,
    title: "All new mail",
    description: "Every label and folder, too.",
  },
  {
    value: "off",
    icon: <BellOffIcon />,
    title: "Off",
    description: "Check in when you're ready.",
  },
];

const ADVANCE_CHOICES: {
  value: AdvanceDirection;
  icon: ReactNode;
  title: string;
  description: string;
}[] = [
  {
    value: "next",
    icon: <ArrowDownIcon />,
    title: "The next one",
    description: "Work down the list.",
  },
  {
    value: "previous",
    icon: <ArrowUpIcon />,
    title: "The previous one",
    description: "Work up from the oldest.",
  },
  {
    value: "none",
    icon: <ListIcon />,
    title: "Back to the list",
    description: "Pick what's next yourself.",
  },
];

function HabitsStep() {
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [advance, setAdvance] = useState<AdvanceDirection>(getAdvanceDirection);
  const [isDefaultMail, setIsDefaultMail] = useState<boolean | null>(null);

  const refreshDefaultMail = () => {
    if (!features.defaultMailApp) return;
    gmailApi.getDefaultMailStatus().then(
      (s) => setIsDefaultMail(s.isDefault),
      () => {},
    );
  };
  const refreshDefaultMailForEffect = useLatest(refreshDefaultMail);
  useEffect(() => {
    gmailApi
      .getSyncSettings()
      .then(setSettings, (error: unknown) =>
        toast.error(`Failed to load settings: ${String(error)}`),
      );
    refreshDefaultMailForEffect.current();
  }, [refreshDefaultMailForEffect]);

  const update = async (patch: Partial<SyncSettings>) => {
    console.log("[Setup:setSyncSettings]", patch);
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      setSettings(await gmailApi.setSyncSettings(patch));
    } catch (error) {
      toast.error(`Failed to save: ${String(error)}`);
    }
  };

  const onComputer = features.launchAtLogin || features.defaultMailApp;

  return (
    <>
      <StepHeader
        title="How you work"
        description="A few choices worth making now. Everything here lives in Settings → General later."
      />
      <SectionTitle>Tell me about new mail</SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {NOTIFY_CHOICES.map((c) => (
          <ChoiceCard
            key={c.value}
            icon={c.icon}
            title={c.title}
            description={c.description}
            selected={settings?.notificationsMode === c.value}
            onClick={() => void update({ notificationsMode: c.value })}
          />
        ))}
      </div>

      <div className="mt-8">
        <SectionTitle>After archiving or deleting, open</SectionTitle>
        <div className="grid grid-cols-3 gap-3">
          {ADVANCE_CHOICES.map((c) => (
            <ChoiceCard
              key={c.value}
              icon={c.icon}
              title={c.title}
              description={c.description}
              selected={advance === c.value}
              onClick={() => {
                console.log("[Setup:setAdvanceDirection]", { direction: c.value });
                setAdvance(c.value);
                setAdvanceDirection(c.value);
              }}
            />
          ))}
        </div>
      </div>

      {onComputer ? (
        <div className="mt-8">
          <SectionTitle>On this {osNames.computer}</SectionTitle>
          <SettingsGroup>
            {features.launchAtLogin ? (
              <SettingsRow
                title="Open at login"
                description="Mail is up to date before you look."
                control={
                  <Switch
                    checked={settings?.launchAtLogin ?? false}
                    disabled={!settings}
                    onCheckedChange={(checked) => void update({ launchAtLogin: checked })}
                  />
                }
              />
            ) : null}
            {features.defaultMailApp ? (
              <SettingsRow
                title="Default mail app"
                description={`Email links everywhere on your ${osNames.computer} open a new message here.`}
                control={
                  isDefaultMail ? (
                    <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <CheckIcon className="size-3.5 text-success" />
                      Otter Mail
                    </span>
                  ) : (
                    <Btn
                      size="sm"
                      disabled={isDefaultMail === null}
                      onClick={() => {
                        console.log("[Setup:setDefaultMailApp]");
                        void gmailApi
                          .setDefaultMailApp()
                          .catch(() => {})
                          .then(refreshDefaultMail);
                      }}
                    >
                      Use Otter Mail
                    </Btn>
                  )
                }
              />
            ) : null}
          </SettingsGroup>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/** Hermes' server URL and key, checked against the server as in Settings → Agents. */
function HermesConnect({ state, onConnected }: { state: ProvidersState; onConnected: () => void }) {
  const { baseUrl, setBaseUrl, apiKey, setApiKey, saving, connect } = useConnectHermes(state);
  return (
    <form
      className="flex flex-col gap-2 px-3.5 pb-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void connect().then((ok) => ok && onConnected());
      }}
    >
      <TextInput
        autoFocus
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder={state.settings.hermes.baseUrl || "https://<host>:8642"}
        aria-label="Hermes API base URL"
      />
      <TextInput
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder="API key (API_SERVER_KEY)"
        aria-label="Hermes API key"
      />
      <p className="text-xs leading-[17px] text-muted-foreground">
        {HERMES_URL_HINT} The key stays on this device.
      </p>
      <Btn type="submit" size="sm" variant="primary" disabled={saving} className="self-end">
        {saving ? "Connecting…" : "Connect"}
      </Btn>
    </form>
  );
}

function AgentStep({ firstRun }: { firstRun: boolean }) {
  const query = useAgentProviders();
  const setState = useSetProvidersState();
  const state = query.data;
  const [hermesOpen, setHermesOpen] = useState(false);
  const pick = (kind: NonNullable<typeof state>["selected"]) => {
    console.log("[Setup:selectAgent]", { kind });
    gmailApi
      .updateAgentSettings({ selected: kind })
      .then(setState, (error: unknown) => toast.error(`Could not save: ${String(error)}`));
  };
  // First run: the default (Hermes) can't answer yet but another can, so
  // that one, once every check is in. Run again, a choice stays as it was.
  const pickForEffect = useLatest(pick);
  useEffect(() => {
    if (!firstRun) return;
    if (!state || state.providers.some((p) => p.checkedAt === null)) return;
    const current = state.providers.find((p) => p.kind === state.selected);
    const ready = state.providers.find(isProviderUsable);
    if (ready && !(current && isProviderUsable(current))) pickForEffect.current(ready.kind);
  }, [state, firstRun, pickForEffect]);

  return (
    <>
      <StepHeader
        title="Meet your agent"
        description="It works beside your mail: ask about what you're reading, find that one email, or have it draft the reply. It asks before it changes anything."
      />
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6">
        {/* What a chat looks like, in the panel's own style. */}
        <div
          aria-hidden
          className="flex flex-col gap-3 self-start rounded-xl border border-border/60 bg-card p-4 text-[13px] leading-5"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-md bg-accent-surface px-1.5 py-0.5 text-foreground">
              Re: Dinner Saturday?
            </span>
            in context
          </div>
          <div className="ml-auto max-w-[85%] rounded-2xl bg-message px-3 py-2 text-message-foreground">
            What does Maya need from me?
          </div>
          <div className="text-foreground">
            She's hosting at 7 and asks you to bring dessert. She also wants to know if Sam is
            coming.
          </div>
          <div className="ml-auto max-w-[85%] rounded-2xl bg-message px-3 py-2 text-message-foreground">
            Say yes, tiramisu, and Sam's in.
          </div>
          <div className="flex flex-col gap-1.5 text-foreground">
            <span className="text-xs text-muted-foreground">Saved a draft reply</span>
            <span className="rounded-lg border border-border/60 bg-surface-raised px-3 py-2 text-muted-foreground">
              Count us in! I'll bring tiramisu, and Sam's coming too. See you at 7.
            </span>
          </div>
        </div>

        <div className="flex flex-col">
          <SectionTitle>Choose who answers</SectionTitle>
          {!state ? (
            <p className="px-1 text-[13px] text-muted-foreground">Looking for agents…</p>
          ) : (
            <div className="flex flex-col gap-2">
              {state.providers.map((p) => {
                const usable = isProviderUsable(p);
                // Hermes connects right here; the Mac's CLIs are set up outside the app.
                const connectable = !usable && p.kind === "hermes";
                const selected = usable && state.selected === p.kind;
                const open = connectable && hermesOpen;
                return (
                  <div
                    key={p.kind}
                    className={cn(
                      "rounded-xl border bg-card",
                      selected
                        ? "border-focus-ring ring-1 ring-focus-ring"
                        : usable || connectable
                          ? "border-border/60 hover:border-input"
                          : "border-border/60",
                    )}
                  >
                    <button
                      type="button"
                      aria-pressed={usable ? selected : undefined}
                      aria-expanded={connectable ? open : undefined}
                      disabled={!usable && !connectable}
                      onClick={() => (connectable ? setHermesOpen(!open) : pick(p.kind))}
                      className="flex w-full cursor-pointer items-start gap-3 rounded-xl px-3.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default"
                    >
                      <span className="flex h-5 shrink-0 items-center">
                        <ProviderIcon kind={p.kind} className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm text-foreground">{p.displayName}</span>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <span
                            aria-hidden
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              PROVIDER_STATUS_DOT[p.status],
                            )}
                          />
                          <span className="truncate">{providerSummary(p).headline}</span>
                        </span>
                      </span>
                      {selected ? (
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
                      ) : connectable ? (
                        <span className="mt-0.5 shrink-0 text-[13px] text-foreground">
                          {open ? "Cancel" : "Connect"}
                        </span>
                      ) : null}
                    </button>
                    {open ? (
                      <HermesConnect
                        state={state}
                        onConnected={() => {
                          setHermesOpen(false);
                          pick("hermes");
                        }}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-4 flex items-center gap-2 px-1 text-[13px] text-muted-foreground">
            <ShortcutKeys command="agent.toggle" />
            opens it from anywhere.
          </p>
          <p className="mt-1.5 px-1 text-[13px] text-muted-foreground">
            Set agents up in Settings → Agents.
          </p>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function KeysStep() {
  const [done, setDone] = useState(0);
  return (
    <>
      <StepHeader
        title="Learn a few keys"
        description={
          <>
            The same keys as Gmail, so your hands already know them. Try them here; nothing touches
            your mail.{" "}
            <span className="tabular-nums text-foreground">
              {done} of {KEY_DRILL_COUNT}
            </span>
          </>
        }
      />
      <KeyTrainer onProgress={setDone} />
      <p className="mt-6 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <ShortcutKeys command="keybindings.show" />
        lists every shortcut. Remap any of them, or add your own, in Settings → Keybindings.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

function DoneStep() {
  const finish = (tour: boolean) => {
    finishSetup();
    if (tour) requestTour();
  };
  return (
    <div className="flex flex-col items-center">
      <span className="mb-6 flex size-14 items-center justify-center rounded-full bg-success/12 text-success motion-safe:animate-[onboarding-pop_420ms_var(--ease-drawer)]">
        <CheckIcon className="size-7" />
      </span>
      <StepHeader
        title="You're all set"
        description="Your mail keeps syncing in the background. Take the one-minute tour to see where everything is, or dive right in."
      />
      <div className="flex items-center gap-3">
        <Btn variant="primary" className="h-10 px-5 text-[15px]" onClick={() => finish(true)}>
          Take the tour
        </Btn>
        <Btn variant="outline" className="h-10 px-5 text-[15px]" onClick={() => finish(false)}>
          Go to my inbox
        </Btn>
      </div>
      <div className="mt-10 grid w-full max-w-[32rem] grid-cols-3 gap-3 text-center">
        {(
          [
            ["commandPalette.toggle", "Everything, one search away"],
            ["keybindings.show", "Every shortcut, and rebinding"],
            ["compose.new", "A new message"],
          ] as const
        ).map(([command, label]) => (
          <div key={command} className="flex flex-col items-center gap-2">
            <ShortcutKeys command={command} />
            <span className="text-[13px] leading-[18px] text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
