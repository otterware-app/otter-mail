/**
 * account-store.ts
 *
 * Persists non-sensitive GmailAccount metadata to accounts.json. Tokens are
 * never stored here; the platform's Google sign-in keeps them.
 */

import type { MailProviderKind } from "@otter-mail/contracts";

import { readJson, writeJson } from "../json-file.js";
import type { GmailAccount } from "../types.js";

/** Each account's provider as last read or written, for lookups by id that can't wait. */
const providerKinds = new Map<string, MailProviderKind>();

function rememberProviders(accounts: GmailAccount[]): GmailAccount[] {
  for (const account of accounts) providerKinds.set(account.id, account.provider ?? "gmail");
  return accounts;
}

/** An account's provider by id (Gmail until accounts.json was read). */
export function providerKindOf(accountId: string): MailProviderKind {
  return providerKinds.get(accountId) ?? "gmail";
}

/**
 * Whether the account's signature lives on the device (synced as a
 * preference) rather than on the server: Gmail keeps its own; Graph doesn't
 * expose Outlook's, and IMAP has none.
 */
export function keepsSignatureOnDevice(account: GmailAccount): boolean {
  return (account.provider ?? "gmail") !== "gmail";
}

async function readAccounts(): Promise<GmailAccount[]> {
  return rememberProviders((await readJson<GmailAccount[]>("accounts.json")) ?? []);
}

async function writeAccounts(accounts: GmailAccount[]): Promise<void> {
  await writeJson("accounts.json", rememberProviders(accounts));
}

let changing: Promise<unknown> = Promise.resolve();

/**
 * Reads, edits and writes accounts.json, one change at a time: two at once
 * (signatures and profiles refresh together at start) would each write over
 * the other's.
 */
function change<T>(edit: (accounts: GmailAccount[]) => T): Promise<T> {
  const changed = changing.then(async () => {
    const accounts = await readAccounts();
    const result = edit(accounts);
    await writeAccounts(accounts);
    return result;
  });
  changing = changed.catch(() => {});
  return changed;
}

export async function listAccounts(): Promise<GmailAccount[]> {
  return readAccounts();
}

export async function addAccount(account: GmailAccount): Promise<void> {
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

export async function getAccount(accountId: string): Promise<GmailAccount | null> {
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
): Promise<GmailAccount> {
  return change((accounts) => {
    const index = accounts.findIndex((a) => a.id === accountId);
    if (index < 0) {
      throw new Error(`Account not found: ${accountId}`);
    }
    const current = accounts[index];
    const updated: GmailAccount = {
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
