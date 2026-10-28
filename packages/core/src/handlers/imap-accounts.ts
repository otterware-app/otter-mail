/**
 * Adding IMAP mailboxes (`gmail:*` channels, like the rest): finding the
 * servers for an address, checking the password against both servers, and
 * signing a mailbox back in on this device (one linked on another device
 * arrives without its password).
 */

import { IMAP_CAPABILITIES, type ImapSettings, type MailServer } from "@otter-mail/contracts/mail";

import { broadcast, handle } from "../ipc.js";
import { MailProtocolError, connectImap, connectSmtp } from "../protocols/index.js";
import { capabilitiesOf } from "../providers/index.js";
import * as accountStore from "../services/account-store.js";
import { appPasswordUrl, discoverImap, mxHosts, servesImap } from "../services/imap-discovery.js";
import { setImapPassword } from "../services/imap-passwords.js";
import { accountAdded } from "../services/linked-accounts.js";
import * as mailSync from "../services/mail-sync.js";
import { syncedSignature } from "../services/preferences.js";
import type { MailAccount } from "../types.js";

const VERIFY_TIMEOUT_MS = 20_000;

/** Why logging in failed, in words for the add-mailbox form. */
function describe(err: unknown, server: MailServer, settings: ImapSettings): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof MailProtocolError)) return message;
  if (err.kind === "auth") {
    const appPasswords = appPasswordUrl(settings.imap.host);
    return appPasswords
      ? `${server.host} didn't accept the password for ${settings.username}. It needs an app password, which you can make at ${appPasswords}.`
      : `${server.host} didn't accept the password for ${settings.username}. Check it, or use an app password if your provider has two-step verification.`;
  }
  if (err.kind === "network" || err.kind === "timeout") {
    // The transport's words already name the host and port (and the certificate, TLS).
    return /couldn't connect|couldn't reach/i.test(message)
      ? message
      : `Couldn't reach ${server.host} on port ${server.port}: ${message}`;
  }
  return `${server.host} (port ${server.port}): ${message}`;
}

/**
 * A certificate for another name usually means the host points at a shared
 * server (imap.<domain> on a hosting provider): name the domain's own mail
 * server, when it answers IMAP with a certificate of its own.
 */
async function certificateHint(message: string, host: string, email: string): Promise<string> {
  if (!/certificate/i.test(message)) return message;
  const domain = email.split("@")[1]?.toLowerCase();
  const [mx] = domain ? await mxHosts(domain) : [];
  if (!mx || mx === host || !(await servesImap(mx))) return message;
  return `${message}. Your domain's mail server is ${mx}: use that as the server name, for incoming and outgoing mail.`;
}

/** Logs in to the IMAP server, then the SMTP server; throws a readable Error when either fails. */
export async function verifyLogin(
  settings: ImapSettings,
  password: string,
  email?: string,
): Promise<void> {
  const auth = { user: settings.username, pass: password };
  try {
    const imap = await connectImap({ ...settings.imap, auth, timeoutMs: VERIFY_TIMEOUT_MS });
    await imap.logout();
  } catch (err) {
    const message = describe(err, settings.imap, settings);
    throw new Error(email ? await certificateHint(message, settings.imap.host, email) : message, {
      cause: err,
    });
  }
  try {
    const smtp = await connectSmtp({ ...settings.smtp, auth, timeoutMs: VERIFY_TIMEOUT_MS });
    await smtp.quit();
  } catch (err) {
    throw new Error(describe(err, settings.smtp, settings), { cause: err });
  }
}

// ── Params ──────────────────────────────────────────────────────────────────

const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

function server(value: unknown, name: string): MailServer {
  const raw = (value ?? {}) as Partial<MailServer>;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${name} port is invalid.`);
  if (raw.security !== "tls" && raw.security !== "starttls") {
    throw new Error(`${name} security must be "tls" or "starttls".`);
  }
  return { host: text(raw.host, `${name} host`).toLowerCase(), port, security: raw.security };
}

function settings(value: unknown): ImapSettings {
  const raw = (value ?? {}) as Partial<ImapSettings>;
  return {
    username: text(raw.username, "Username"),
    imap: server(raw.imap, "IMAP"),
    smtp: server(raw.smtp, "SMTP"),
  };
}

// ── Flows ───────────────────────────────────────────────────────────────────

const withCapabilities = (account: MailAccount) => ({
  ...account,
  capabilities: capabilitiesOf(account) ?? IMAP_CAPABILITIES,
});

/** Checks the password, keeps it on this device, saves the mailbox, links it and syncs. */
export async function addImapAccount(params: unknown): Promise<MailAccount> {
  const p = (params ?? {}) as Record<string, unknown>;
  const email = text(p.email, "Email");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error(`${email} isn't an email address.`);
  const password = typeof p.password === "string" ? p.password : "";
  if (!password) throw new Error("Password is required.");
  const imap = settings(p.imap);
  const id = email.toLowerCase();
  const existing = await accountStore.getAccount(id);
  if (existing && existing.provider !== "imap") throw new Error(`${email} is already added.`);

  await verifyLogin(imap, password, email);
  await setImapPassword(id, password);
  const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : email;
  const account: MailAccount = {
    ...existing,
    id,
    email,
    name,
    provider: "imap",
    imap,
    signature: existing?.signature ?? syncedSignature(email),
  };
  await accountStore.addAccount(account);
  // Linked first: on the web, the relay's tunnel only carries a sync to linked servers.
  await accountAdded(account);
  mailSync.syncAccount(id, { force: true });
  broadcast("gmail:accounts-changed");
  return withCapabilities(account);
}

/** Signs a mailbox back in on this device with its stored settings. */
export async function signInImap(params: unknown): Promise<void> {
  const p = (params ?? {}) as Record<string, unknown>;
  const accountId = text(p.accountId, "accountId");
  const password = typeof p.password === "string" ? p.password : "";
  if (!password) throw new Error("Password is required.");
  const account = await accountStore.getAccount(accountId);
  if (!account?.imap || account.provider !== "imap") {
    throw new Error(`${accountId} isn't an IMAP mailbox.`);
  }
  await verifyLogin(account.imap, password, account.email);
  await setImapPassword(account.id, password);
  await accountAdded(account);
  mailSync.syncAccount(account.id, { force: true });
  broadcast("gmail:accounts-changed");
}

export function registerImapAccountHandlers(): void {
  handle("gmail:discoverImap", async (params: unknown) =>
    discoverImap(text((params as Record<string, unknown> | undefined)?.email, "Email")),
  );
  handle("gmail:addImapAccount", addImapAccount);
  handle("gmail:signInImap", signInImap);
}
