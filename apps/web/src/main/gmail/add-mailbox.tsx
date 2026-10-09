import { useState, type ReactNode } from "react";
import type { ImapSettings, MailServer } from "@otter-mail/contracts";
import { ChevronRightIcon, MailIcon, ServerIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { gmailApi } from "./api";
import { useAddAccount, useAddImapAccount, useMailProviders, useSignInImap } from "./hooks";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { toast } from "./toast";
import type { GmailAccount } from "./types";
import { cn } from "./ui";

/**
 * Adding a mailbox: Gmail (Google's sign-in in the browser), Outlook
 * (Microsoft's, where this app has an OAuth client for it), or any other mail
 * over IMAP (address and password, the servers found from the domain).
 */

/** The reason from a rejected invoke, without the IPC bridge's wrapping. */
export function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
}

/** Microsoft's four squares, for Outlook. */
export function MicrosoftMark({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 21 21" className={className} aria-hidden>
      <path fill="#f25022" d="M1 1h9v9H1z" />
      <path fill="#7fba00" d="M11 1h9v9h-9z" />
      <path fill="#00a4ef" d="M1 11h9v9H1z" />
      <path fill="#ffb900" d="M11 11h9v9h-9z" />
    </svg>
  );
}

/** Adds an Outlook mailbox; answers it (null when cancelled), or toasts why it couldn't. */
export function useAddOutlook(onAdded?: (account: GmailAccount) => void) {
  const add = useAddAccount("outlook");
  const start = () =>
    void add.mutateAsync(undefined).then(
      (account) => {
        if (account) onAdded?.(account);
      },
      (err: unknown) =>
        toast.error("Couldn't add the mailbox", { description: readableError(err) }),
    );
  return { start, pending: add.isPending };
}

/** "Add mailbox" as a menu: Gmail, Outlook, or other mail (the IMAP dialog). */
export function AddMailboxMenu({
  onGmail,
  onAdded,
  align = "start",
  children,
}: {
  onGmail: () => void;
  /** The Outlook or IMAP mailbox just added. */
  onAdded?: (account: GmailAccount) => void;
  align?: "start" | "end";
  /** The trigger (rendered via asChild). */
  children: ReactNode;
}) {
  const [imapOpen, setImapOpen] = useState(false);
  const outlook = useAddOutlook(onAdded);
  const providers = useMailProviders().data;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align={align}>
          <DropdownMenuItem icon={<MailIcon />} onSelect={onGmail}>
            Gmail
          </DropdownMenuItem>
          {providers?.outlook ? (
            <DropdownMenuItem icon={<MicrosoftMark />} onSelect={outlook.start}>
              Outlook
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem icon={<ServerIcon />} onSelect={() => setImapOpen(true)}>
            Other mail (IMAP)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ImapAccountDialog open={imapOpen} onOpenChange={setImapOpen} onAdded={onAdded} />
    </>
  );
}

/** Providers that refuse the account password over IMAP, by server. */
const APP_PASSWORDS: { host: RegExp; hint: string }[] = [
  {
    host: /(^|\.)me\.com$/,
    hint: "iCloud needs an app-specific password, made at account.apple.com.",
  },
  {
    host: /(^|\.)yahoo\.com$/,
    hint: "Yahoo needs an app password, made in your Yahoo account's security settings.",
  },
  {
    host: /(^|\.)fastmail\.com$/,
    hint: "Fastmail needs an app password, made in Settings › Privacy & Security.",
  },
  {
    host: /(^|\.)aol\.com$/,
    hint: "AOL needs an app password, made in your AOL account's security settings.",
  },
  { host: /(^|\.)gmx\.(com|net|de)$/, hint: "GMX needs IMAP turned on in its web settings first." },
  {
    host: /(^|\.)(office365|outlook)\.com$/,
    hint: "Outlook and Microsoft 365 don't take passwords over IMAP: add the mailbox as Outlook instead.",
  },
];

function appPasswordHint(settings: ImapSettings | null): string | undefined {
  const host = settings?.imap.host.toLowerCase();
  return host ? APP_PASSWORDS.find((p) => p.host.test(host))?.hint : undefined;
}

/** A first guess when discovery finds nothing: the usual names and ports. */
function guessSettings(email: string): ImapSettings {
  const domain = email.split("@")[1] ?? "";
  return {
    username: email,
    imap: { host: domain ? `imap.${domain}` : "", port: 993, security: "tls" },
    smtp: { host: domain ? `smtp.${domain}` : "", port: 465, security: "tls" },
  };
}

const looksLikeEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

type Discovery = { email: string; state: "looking" | "found" | "none" } | null;

export function ImapAccountDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (account: GmailAccount) => void;
}) {
  const add = useAddImapAccount();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<ImapSettings | null>(null);
  const [discovery, setDiscovery] = useState<Discovery>(null);
  const [showServers, setShowServers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setEmail("");
    setPassword("");
    setName("");
    setSettings(null);
    setDiscovery(null);
    setShowServers(false);
    setError(null);
  };

  /** Finds the address's servers once per address; keeps what the user typed otherwise. */
  const discover = async (address: string): Promise<ImapSettings> => {
    if (discovery?.email === address && settings) return settings;
    setDiscovery({ email: address, state: "looking" });
    setError(null);
    const found = await gmailApi.discoverImap(address).catch(() => null);
    const next = found ?? guessSettings(address);
    setSettings(next);
    setDiscovery({ email: address, state: found ? "found" : "none" });
    // Nothing known about the domain: show the guess, to be checked.
    if (!found) setShowServers(true);
    return next;
  };

  const submit = async () => {
    const address = email.trim();
    setError(null);
    if (!looksLikeEmail(address)) {
      setError("Enter your email address.");
      throw new Error("invalid");
    }
    const imap = await discover(address);
    if (!password) {
      setError("Enter your password.");
      throw new Error("invalid");
    }
    try {
      const account = await add.mutateAsync({
        email: address,
        name: name.trim() || undefined,
        password,
        imap,
      });
      onAdded?.(account);
    } catch (err) {
      const message = readableError(err);
      setError(message);
      // Can't reach the server, or its certificate: the settings are what to check.
      if (/reach|connect|certificate|tls|timed out|host|port/i.test(message)) setShowServers(true);
      throw err;
    }
  };

  const setServer = (key: "imap" | "smtp", server: MailServer) =>
    setSettings((s) => (s ? { ...s, [key]: server } : s));
  const hint = appPasswordHint(settings);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Add other mail"
      size="large"
      description="Any mailbox that works with IMAP: iCloud, Fastmail, Yahoo, your own domain."
      confirmLabel={add.isPending ? "Signing in…" : "Add mailbox"}
      confirmDisabled={add.isPending}
      onConfirm={submit}
    >
      <div className="flex flex-col gap-3">
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => {
              const address = email.trim();
              if (looksLikeEmail(address)) void discover(address);
            }}
            placeholder="you@example.com"
          />
        </Field>
        <Field label="Password" description={hint}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Your name (optional)">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Shown to the people you write to"
          />
        </Field>

        {settings ? (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              aria-expanded={showServers}
              onClick={() => setShowServers((s) => !s)}
              className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <ChevronRightIcon
                className={cn("size-3.5 shrink-0 transition-transform", showServers && "rotate-90")}
              />
              <span className="shrink-0">Server settings</span>
              {showServers ? null : (
                <span className="min-w-0 truncate text-muted-foreground/70">
                  {settings.imap.host} · {settings.smtp.host}
                </span>
              )}
            </button>
            {showServers ? (
              <>
                {discovery?.state === "none" ? (
                  <p className="text-xs text-muted-foreground">
                    Otter Mail couldn't find this domain's servers. Check these with your mail
                    provider.
                  </p>
                ) : null}
                <ServerFields
                  label="Incoming (IMAP)"
                  server={settings.imap}
                  ports={{ tls: 993, starttls: 143 }}
                  onChange={(server) => setServer("imap", server)}
                />
                <ServerFields
                  label="Outgoing (SMTP)"
                  server={settings.smtp}
                  ports={{ tls: 465, starttls: 587 }}
                  onChange={(server) => setServer("smtp", server)}
                />
                <Field label="Username">
                  <Input
                    autoComplete="off"
                    value={settings.username}
                    onChange={(e) => setSettings({ ...settings, username: e.target.value })}
                  />
                </Field>
              </>
            ) : null}
          </div>
        ) : discovery?.state === "looking" ? (
          <p className="text-[13px] text-muted-foreground">Looking up the servers…</p>
        ) : null}

        {error ? (
          <p role="alert" className="text-[13px] text-destructive-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Host, port and security of one server, on one line. */
function ServerFields({
  label,
  server,
  ports,
  onChange,
}: {
  label: string;
  server: MailServer;
  /** The usual port for each security, switched along with it. */
  ports: Record<MailServer["security"], number>;
  onChange: (server: MailServer) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex gap-2">
        <Input
          aria-label={`${label} server`}
          autoComplete="off"
          value={server.host}
          onChange={(e) => onChange({ ...server, host: e.target.value.trim() })}
          placeholder="mail.example.com"
          className="flex-1"
        />
        <Input
          aria-label={`${label} port`}
          inputMode="numeric"
          value={String(server.port)}
          onChange={(e) => onChange({ ...server, port: Number(e.target.value.replace(/\D/g, "")) })}
          className="w-16 text-center tabular-nums"
        />
        <Select
          value={server.security}
          onValueChange={(security: MailServer["security"]) =>
            onChange({
              ...server,
              security,
              port: server.port === ports[server.security] ? ports[security] : server.port,
            })
          }
        >
          <SelectTrigger aria-label={`${label} security`} className="w-28 min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tls">SSL/TLS</SelectItem>
            <SelectItem value="starttls">STARTTLS</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * Signs an IMAP mailbox in on this device: its password stays on the device
 * it was typed on, so a mailbox linked elsewhere asks for it here once. It
 * names the server the password goes to: the settings came from the Otter
 * account, and whoever holds that session could have changed them.
 */
export function ImapPasswordForm({
  account,
  size = "small",
  className,
}: {
  account: GmailAccount;
  size?: "small" | "default";
  className?: string;
}) {
  const signIn = useSignInImap();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const where = account.imap
    ? `Password for ${account.imap.username} on ${account.imap.imap.host}`
    : `Password for ${account.email}`;
  return (
    <form
      className={cn("flex flex-col gap-1.5", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (!password || signIn.isPending) return;
        setError(null);
        signIn.mutate(
          { accountId: account.id, password },
          { onError: (err) => setError(readableError(err)), onSuccess: () => setPassword("") },
        );
      }}
    >
      <p className="text-xs text-muted-foreground">{where}</p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="current-password"
          aria-label={where}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          className={size === "small" ? "h-7 min-w-44 text-[13px]" : "min-w-52"}
        />
        <Button type="submit" size={size} variant="accent" disabled={!password || signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </form>
  );
}
