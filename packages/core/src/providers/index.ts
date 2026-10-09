/**
 * Which provider an account's mail comes from: `account.provider`, absent
 * meaning Gmail (accounts stored before IMAP).
 */

import type { MailProviderKind } from "@otter-mail/contracts";

import { providerKindOf } from "../services/account-store.js";
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
