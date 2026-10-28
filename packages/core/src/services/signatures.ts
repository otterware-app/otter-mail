/**
 * Signatures live in Gmail (one per send-as address), so they're the same in
 * Gmail on the web and on every device. The account keeps a copy for the
 * composer, refreshed from Gmail. A signature from before, kept only in Otter
 * Mail, moves to Gmail once. Mailboxes whose server keeps no signatures
 * (capabilities.serverSignatures) keep just the account's copy, which
 * follows the Otter account as a preference (preferences.ts).
 *
 * Reading needs only the Gmail scope; saving needs gmail.settings.basic,
 * which sign-ins from before it was added lack (GMAIL_SETTINGS_PERMISSION):
 * the signature is then kept here (signatureInGmail false) and moved to Gmail
 * once the account is signed in again.
 */

import { GMAIL_SETTINGS_PERMISSION } from "@otter-mail/contracts";

import { broadcast } from "../ipc.js";
import { logger } from "../logger.js";
import { findProvider, isSignedIn } from "../providers/index.js";
import { listAccounts, updateAccount } from "./account-store.js";
import { preferenceChanged } from "./preferences.js";
import type { MailAccount } from "../types.js";

/** Saves the signature on the server when it keeps them, then keeps its copy. */
export async function saveSignature(account: MailAccount, html: string): Promise<MailAccount> {
  const signatures = findProvider(account)?.signatures;
  if (!signatures) {
    // Kept on the device, following the Otter account as a preference.
    const updated = await updateAccount(account.id, { signature: html });
    preferenceChanged("signatures");
    return updated;
  }
  try {
    const saved = await signatures.set(account.id, account.email, html);
    return updateAccount(account.id, { signature: saved, signatureInGmail: true });
  } catch (err) {
    if (!(err instanceof Error && err.message === GMAIL_SETTINGS_PERMISSION)) throw err;
    // This sign-in may not change Gmail's settings: keep it here until one may.
    return updateAccount(account.id, { signature: html, signatureInGmail: false });
  }
}

async function refreshSignature(account: MailAccount): Promise<boolean> {
  const signatures = findProvider(account)?.signatures;
  if (!signatures) return false;
  if (account.signatureInGmail === false) {
    // Saved here while the sign-in couldn't save it in Gmail: try again.
    return (await saveSignature(account, account.signature ?? "")).signatureInGmail === true;
  }
  const inGmail = await signatures.get(account.id, account.email);
  if (!account.signatureInGmail && !inGmail && account.signature) {
    // Kept only here until now: move it to Gmail (if this sign-in may).
    await saveSignature(account, account.signature).catch((err: unknown) =>
      logger.info(
        "signatures",
        `Couldn't move ${account.email}'s signature to Gmail: ${String(err)}`,
      ),
    );
    return true;
  }
  if (account.signatureInGmail && (account.signature ?? "") === inGmail) return false;
  await updateAccount(account.id, { signature: inGmail, signatureInGmail: true });
  return true;
}

/** Brings every signed-in account's signature up to date with the server. */
export async function refreshSignatures(): Promise<void> {
  let changed = false;
  for (const account of await listAccounts()) {
    if (!isSignedIn(account)) continue;
    try {
      changed = (await refreshSignature(account)) || changed;
    } catch (err) {
      logger.info("signatures", `Couldn't read ${account.email}'s signature: ${String(err)}`);
    }
  }
  if (changed) broadcast("gmail:accounts-changed");
}
