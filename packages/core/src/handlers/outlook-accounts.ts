/**
 * Adding Outlook mailboxes (`gmail:*` channels, like the rest): Microsoft's
 * sign-in in the browser, then the mailbox is saved, linked and synced.
 * Signing one back in (one linked on another device, or a lapsed sign-in)
 * is the same sign-in with its address prefilled.
 */

import { OUTLOOK_CAPABILITIES } from "@otter-mail/contracts";

import { SignInCancelledError } from "../google.js";
import { broadcast, handle } from "../ipc.js";
import { platform, type MicrosoftSignIn } from "../platform.js";
import * as accountStore from "../services/account-store.js";
import { refreshProfiles } from "../services/google-profile.js";
import { accountAdded } from "../services/linked-accounts.js";
import * as mailSync from "../services/mail-sync.js";
import { syncedSignature } from "../services/preferences.js";
import type { GmailAccount } from "../types.js";

/** Signs in with Microsoft; answers the mailbox, or null when the user cancelled. */
export async function addOutlookAccount(params: unknown): Promise<GmailAccount | null> {
  const auth = platform().microsoft;
  if (!auth || !(await auth.available())) throw new Error("This app can't sign in to Outlook.");
  const email = (params as { email?: unknown } | undefined)?.email;
  let signIn: { email: string; name: string };
  try {
    signIn = await auth.addAccount(typeof email === "string" ? email : undefined);
  } catch (err) {
    if (err instanceof SignInCancelledError) return null;
    throw err;
  }
  return saveOutlookAccount(signIn);
}

/** After a Microsoft sign-in: saves the mailbox, links it, syncs it. */
export async function saveOutlookAccount(signIn: MicrosoftSignIn): Promise<GmailAccount> {
  const auth = platform().microsoft!;
  const existing = await accountStore.getAccount(signIn.email);
  if (existing && existing.provider !== "outlook") {
    await auth.removeTokens(signIn.email);
    throw new Error(`${signIn.email} is already added.`);
  }
  const account: GmailAccount = {
    ...existing,
    id: signIn.email,
    email: signIn.email,
    name: existing?.name && existing.name !== existing.email ? existing.name : signIn.name,
    provider: "outlook",
    signature: existing?.signature ?? syncedSignature(signIn.email),
  };
  await accountStore.addAccount(account);
  mailSync.syncAccount(account.id, { force: true });
  void accountAdded(account);
  void refreshProfiles();
  // The browser sign-in outlasts the renderer's IPC timeout: every window reloads accounts.
  broadcast("gmail:accounts-changed");
  return { ...account, capabilities: OUTLOOK_CAPABILITIES };
}

export function registerOutlookAccountHandlers(): void {
  handle("gmail:addOutlookAccount", addOutlookAccount);
  /** Which kinds of mailbox this app can add besides Gmail and IMAP. */
  handle("gmail:mailProviders", async () => ({
    outlook: (await platform().microsoft?.available()) ?? false,
  }));
}
