/**
 * account-store.ts
 *
 * Persists non-sensitive MailAccount metadata to accounts.json. Tokens are
 * never stored here; the platform's Google sign-in keeps them.
 */

import type { MailProviderKind } from "@otter-mail/contracts";

import { readJson, writeJson } from "../json-file.js";
import type { MailAccount } from "../types.js";

/** Each account's provider (and IMAP server) as last read or written, for lookups by id that can't wait. */
const providerKinds = new Map<string, MailProviderKind>();
const imapHosts = new Map<string, string>();

function rememberProviders(accounts: MailAccount[]): MailAccount[] {
  for (const account of accounts) {
    providerKinds.set(account.id, account.provider ?? "gmail");
    if (account.imap) imapHosts.set(account.id, account.imap.imap.host);
  }
  return accounts;
}

/** An account's provider by id (Gmail until accounts.json was read). */
export function providerKindOf(accountId: string): MailProviderKind {
  return providerKinds.get(accountId) ?? "gmail";
}

/** An IMAP account's server by id (null: not IMAP, or not read yet). */
export function imapHostOf(accountId: string): string | null {
  return imapHosts.get(accountId) ?? null;
}

/**
 * Whether the account's signature lives on the device (synced as a
 * preference) rather than on the server: Gmail keeps its own; Graph doesn't
 * expose Outlook's, and IMAP has none.
 */
export function keepsSignatureOnDevice(account: MailAccount): boolean {
  return (account.provider ?? "gmail") !== "gmail";
}

async function readAccounts(): Promise<MailAccount[]> {
  return rememberProviders((await readJson<MailAccount[]>("accounts.json")) ?? []);
}

async function writeAccounts(accounts: MailAccount[]): Promise<void> {
  await writeJson("accounts.json", rememberProviders(accounts));
}

let changing: Promise<unknown> = Promise.resolve();

/**
 * Reads, edits and writes accounts.json, one change at a time: two at once
 * (signatures and profiles refresh together at start) would each write over
 * the other's.
 */
function change<T>(edit: (accounts: MailAccount[]) => T): Promise<T> {
  const changed = changing.then(async () => {
    const accounts = await readAccounts();
    const result = edit(accounts);
    await writeAccounts(accounts);
    return result;
  });
  changing = changed.catch(() => {});
  return changed;
}

export async function listAccounts(): Promise<MailAccount[]> {
  return readAccounts();
}

export async function addAccount(account: MailAccount): Promise<void> {
  await change((accounts) => {
    const exists = accounts.findIndex((a) => a.id === account.id);
    if (exists >= 0) {
      accounts[exists] = account;
    } else {
      accounts.push(account);
    }
  });
}

export async function removeAccount(accountId: string): Promise<void> {
  await change((accounts) => {
    const index = accounts.findIndex((a) => a.id === accountId);
    if (index >= 0) accounts.splice(index, 1);
  });
}

export async function getAccount(accountId: string): Promise<MailAccount | null> {
  const accounts = await readAccounts();
  return accounts.find((a) => a.id === accountId) ?? null;
}

export async function updateAccount(
  accountId: string,
  patch: {
    name?: string;
    picture?: string;
    displayName?: string;
    color?: string;
    signature?: string;
    signatureInGmail?: boolean;
  },
): Promise<MailAccount> {
  return change((accounts) => {
    const index = accounts.findIndex((a) => a.id === accountId);
    if (index < 0) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const current = accounts[index];
    const updated: MailAccount = {
      ...current,
      // The name is required: never blanked.
      name: patch.name || current.name,
      picture: patch.picture !== undefined ? patch.picture || undefined : current.picture,
      displayName:
        patch.displayName !== undefined ? patch.displayName || undefined : current.displayName,
      color: patch.color !== undefined ? patch.color || undefined : current.color,
      signature: patch.signature !== undefined ? patch.signature || undefined : current.signature,
      signatureInGmail: patch.signatureInGmail ?? current.signatureInGmail,
    };
    accounts[index] = updated;
    return updated;
  });
}
