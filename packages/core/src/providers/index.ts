/**
 * Which provider an account's mail comes from: `account.provider`, absent
 * meaning Gmail (accounts stored before IMAP).
 */

import type { MailCapabilities, MailProviderKind } from "@otter-mail/contracts";

import { imapHostOf, providerKindOf } from "../services/account-store.js";
import type { GmailAccount } from "../types.js";
import { gmailProvider } from "./gmail/index.js";
import { imapProvider } from "./imap/index.js";
import { outlookProvider } from "./outlook/index.js";
import type { MailProvider } from "./provider.js";

const providers: Record<MailProviderKind, MailProvider | null> = {
  gmail: gmailProvider,
  imap: imapProvider,
  outlook: outlookProvider,
};

/** What an account whose provider isn't here yet shows. */
const UNAVAILABLE = "This kind of mailbox isn't available in this app.";

/** The account's provider; null when this build can't reach its kind of mailbox yet. */
export function findProvider(account: GmailAccount | string): MailProvider | null {
  return providers[
    typeof account === "string" ? providerKindOf(account) : (account.provider ?? "gmail")
  ];
}

export function providerFor(account: GmailAccount | string): MailProvider {
  const provider = findProvider(account);
  if (!provider) throw new Error(UNAVAILABLE);
  return provider;
}

/** Gmail's own IMAP servers. */
const GMAIL_IMAP_HOSTS = ["imap.gmail.com", "imap.googlemail.com"];

/**
 * What the account's mailbox can do: its provider's, except that Gmail
 * reached over IMAP is still Gmail: its archive is All Mail, not a folder,
 * and its \Flagged is the star (imap/folders.ts).
 */
export function capabilitiesOf(account: GmailAccount | string): MailCapabilities | null {
  const capabilities = findProvider(account)?.capabilities ?? null;
  const host = typeof account === "string" ? imapHostOf(account) : account.imap?.imap.host;
  return capabilities && host && GMAIL_IMAP_HOSTS.includes(host.toLowerCase())
    ? { ...capabilities, archiveFolder: false, stars: true }
    : capabilities;
}

/** Whether this device can reach the account's mail now. */
export function isSignedIn(account: GmailAccount | string): boolean {
  return (
    findProvider(account)?.isSignedIn(typeof account === "string" ? account : account.id) ?? false
  );
}

/** Why it can't, for the status line. */
export function signedOutMessage(account: GmailAccount | string): string {
  return findProvider(account)?.signedOutMessage ?? UNAVAILABLE;
}
