/**
 * linked-accounts.ts
 *
 * Keeps this device's mailboxes and the Otter account's linked accounts in
 * step, so signing in on another device brings every account along. The relay
 * only learns addresses, profiles and IMAP server settings; each device signs
 * in itself (Gmail with Google, Outlook with Microsoft, IMAP with the
 * password, which never leaves the device), so an account that arrives from the relay shows up signed out
 * here until the user signs in to it (one click, or the password).
 *
 * Reconciling compares the local accounts, the relay's list, and the
 * accounts both had last time (the snapshot): that is what tells "added on
 * another device" apart from "removed on this one".
 */

import type { ImapSettings } from "@otter-mail/contracts";
import type {
  ListAccountsResponse,
  PutAccountRequest,
  RelayAccount,
} from "@otter-mail/contracts/relay";

import { logger } from "../logger.js";
import { broadcast } from "../ipc.js";
import * as accountStore from "./account-store.js";
import { platform } from "../platform.js";
import { isSignedIn } from "../providers/index.js";
import * as mailStore from "./mail-store.js";
import { getImapPassword, setAsideImapPassword } from "./imap-passwords.js";
import { getOtterUser, relayRequest, RelayError } from "./otter-account.js";
import { syncedSignature } from "./preferences.js";
import type { GmailAccount } from "../types.js";

export type LocalAccount = Pick<
  GmailAccount,
  "email" | "name" | "picture" | "displayName" | "color" | "imap"
> & {
  signedIn: boolean;
};

export type ReconcilePlan = {
  /** On this device only, and new: link them (Gmail and Outlook need a sign-in to prove it). */
  link: string[];
  /** Removed on this device since the last reconcile: unlink them. */
  unlink: string[];
  /** Linked on another device: add them here, signed out. */
  add: RelayAccount[];
  /** Unlinked on another device: remove them here. */
  remove: string[];
  /** Linked on both, with a profile (name, picture, label, color) edited elsewhere. */
  update: RelayAccount[];
  /**
   * IMAP mailboxes signed in here whose servers the relay lists differently.
   * Not adopted: whoever holds the Otter session could point them at a server
   * of theirs to collect the password. This device keeps its own settings and
   * asks for the password again (naming the host); signing in re-links them.
   */
  moved: string[];
};

const key = (email: string) => email.toLowerCase();

const sameServers = (a: ImapSettings, b: ImapSettings) =>
  a.imap.host.toLowerCase() === b.imap.host.toLowerCase() &&
  a.smtp.host.toLowerCase() === b.smtp.host.toLowerCase();

/** What to do to bring both sides together. Addresses compare case-insensitively. */
export function planReconcile(
  local: LocalAccount[],
  remote: RelayAccount[],
  snapshot: ReadonlySet<string>,
): ReconcilePlan {
  const plan: ReconcilePlan = { link: [], unlink: [], add: [], remove: [], update: [], moved: [] };
  const localByKey = new Map(local.map((account) => [key(account.email), account]));
  const remoteKeys = new Set(remote.map((account) => key(account.email)));

  for (const account of remote) {
    const here = localByKey.get(key(account.email));
    if (!here) {
      if (snapshot.has(key(account.email))) plan.unlink.push(account.email);
      else plan.add.push(account);
    } else {
      // A signed-in Gmail or Outlook account refreshes its name and picture
      // from Google or Microsoft itself; the relay's copy could be staler, so
      // even an update for its label or color leaves them alone. A null one
      // never blanks ours.
      const fromGoogle = here.signedIn && !here.imap;
      if (
        (here.displayName ?? null) !== account.displayName ||
        (here.color ?? null) !== account.color ||
        (!fromGoogle && account.name !== null && here.name !== account.name) ||
        (!fromGoogle && account.picture !== null && (here.picture ?? null) !== account.picture)
      ) {
        plan.update.push(fromGoogle ? { ...account, name: null, picture: null } : account);
      }
      if (here.signedIn && here.imap && account.imap && !sameServers(here.imap, account.imap)) {
        plan.moved.push(account.email);
      }
    }
  }
  for (const account of local) {
    if (remoteKeys.has(key(account.email))) continue;
    if (snapshot.has(key(account.email))) plan.remove.push(account.email);
    else if (account.signedIn) plan.link.push(account.email);
  }
  return plan;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

const SNAPSHOT_KEY = "otter:linkedAccounts";

function readSnapshot(): Set<string> {
  const saved = mailStore.getKv(SNAPSHOT_KEY);
  if (!saved) return new Set();
  try {
    return new Set(JSON.parse(saved) as string[]);
  } catch {
    return new Set();
  }
}

function writeSnapshot(emails: Iterable<string>): void {
  mailStore.setKv(SNAPSHOT_KEY, JSON.stringify([...new Set([...emails].map(key))]));
}

/** Forgets what was linked (signing out): the next Otter account starts by merging. */
export function clearLinkedSnapshot(): void {
  mailStore.setKv(SNAPSHOT_KEY, "");
}

/** Local accounts the relay has linked, as of the last reconcile. */
export function linkedAccountIds(): Set<string> {
  return readSnapshot();
}

// ── Relay calls ─────────────────────────────────────────────────────────────

/** `providers`: this build knows IMAP and Outlook mailboxes (contracts' ListAccountsResponse). */
const PROVIDERS = "?providers=gmail,imap,outlook";
const accountRoute = (email: string) =>
  `/v1/accounts/${encodeURIComponent(key(email))}${PROVIDERS}`;

const profile = (account: GmailAccount) => ({
  name: account.name,
  // Outlook's photo is a data URL, too big for the relay and only this device's to read.
  picture: account.picture?.startsWith("data:") ? null : (account.picture ?? null),
  displayName: account.displayName ?? null,
  color: account.color ?? null,
});

/**
 * What links an account: Gmail proves the sign-in with a Google ID token,
 * Outlook with a Microsoft one; IMAP sends its server settings (never the
 * password).
 */
export async function linkRequest(
  account: GmailAccount,
  idToken: (accountId: string) => Promise<string>,
): Promise<PutAccountRequest> {
  if (account.provider === "imap") {
    return { provider: "imap", imap: account.imap, ...profile(account) };
  }
  if (account.provider === "outlook") {
    return { provider: "outlook", idToken: await idToken(account.id), ...profile(account) };
  }
  return { idToken: await idToken(account.id), ...profile(account) };
}

/** Links a signed-in account to the Otter account. */
async function link(account: GmailAccount): Promise<void> {
  const body = await linkRequest(account, (id) => {
    const auth = account.provider === "outlook" ? platform().microsoft : platform().google;
    if (!auth) throw new Error("This app can't sign in to Outlook.");
    return auth.getIdToken(id);
  });
  await relayRequest("PUT", accountRoute(account.email), body);
}

/** An account linked on another device, as this device keeps it: signed out until it signs in. */
export function accountFromRelay(account: RelayAccount): GmailAccount {
  const imap = account.provider === "imap" && account.imap;
  return {
    id: account.email,
    email: account.email,
    name: account.name ?? account.email,
    ...(imap ? { provider: "imap", imap, signature: syncedSignature(account.email) } : {}),
    ...(account.provider === "outlook"
      ? { provider: "outlook", signature: syncedSignature(account.email) }
      : {}),
    picture: account.picture ?? undefined,
    displayName: account.displayName ?? undefined,
    color: account.color ?? undefined,
  };
}

/** After adding (or signing back in to) an account here. No-op when signed out of Otter. */
export async function accountAdded(account: GmailAccount): Promise<void> {
  if (!getOtterUser()) return;
  try {
    await link(account);
    writeSnapshot([...readSnapshot(), account.email]);
  } catch (err) {
    // The next reconcile links it.
    logger.info("linked-accounts", `Couldn't link ${account.email}: ${String(err)}`);
  }
}

/** After removing an account here. */
export async function accountRemoved(email: string): Promise<void> {
  if (!getOtterUser()) return;
  try {
    await relayRequest("DELETE", accountRoute(email));
    const snapshot = readSnapshot();
    snapshot.delete(key(email));
    writeSnapshot(snapshot);
  } catch (err) {
    // Still in the snapshot, so the next reconcile unlinks it.
    logger.info("linked-accounts", `Couldn't unlink ${email}: ${String(err)}`);
  }
}

/**
 * After editing an account here: its label and color, or the name and picture
 * read from Google (google-profile.ts). Only `fields` go: this device's copy
 * of the others may be older than the relay's.
 */
export async function accountEdited(
  account: GmailAccount,
  fields: (keyof ReturnType<typeof profile>)[],
): Promise<void> {
  if (!getOtterUser() || !readSnapshot().has(key(account.email))) return;
  const all = profile(account);
  const edited = Object.fromEntries(fields.map((field) => [field, all[field]]));
  await relayRequest("PUT", accountRoute(account.email), edited).catch((err: unknown) => {
    logger.info("linked-accounts", `Couldn't update ${account.email}: ${String(err)}`);
  });
}

// ── Reconcile ───────────────────────────────────────────────────────────────

/**
 * Brings this device and the relay together (see planReconcile). `removeLocal`
 * deletes an account and its cached mail from this device.
 */
export async function reconcileAccounts(
  removeLocal: (accountId: string) => Promise<void>,
): Promise<void> {
  if (!getOtterUser()) return;
  const { accounts: remote } = await relayRequest<ListAccountsResponse>(
    "GET",
    `/v1/accounts${PROVIDERS}`,
  );
  const localAccounts = await accountStore.listAccounts();
  const byKey = new Map(localAccounts.map((account) => [key(account.email), account]));
  const plan = planReconcile(
    localAccounts.map((account) => ({
      ...account,
      signedIn: isSignedIn(account),
    })),
    remote,
    readSnapshot(),
  );

  const linked = new Set(remote.map((account) => key(account.email)));
  for (const email of plan.unlink) {
    await relayRequest("DELETE", accountRoute(email));
    linked.delete(key(email));
  }
  for (const email of plan.link) {
    try {
      await link(byKey.get(key(email))!);
      linked.add(key(email));
    } catch (err) {
      if (err instanceof RelayError && err.status === 401) throw err;
      logger.info("linked-accounts", `Couldn't link ${email}: ${String(err)}`);
    }
  }
  for (const account of plan.add) {
    // An IMAP link without its settings can't be reached from here.
    if (account.provider === "imap" && !account.imap) continue;
    await accountStore.addAccount(accountFromRelay(account));
  }
  for (const email of plan.remove) {
    await removeLocal(byKey.get(key(email))!.id);
  }
  for (const account of plan.update) {
    await accountStore.updateAccount(byKey.get(key(account.email))!.id, {
      name: account.name ?? undefined,
      picture: account.picture ?? undefined,
      displayName: account.displayName ?? "",
      color: account.color ?? "",
    });
  }
  for (const email of plan.moved) {
    const here = byKey.get(key(email))!;
    const password = getImapPassword(here.id);
    if (password) {
      setAsideImapPassword(here.id, password, "the Otter account lists other servers for it");
    }
  }
  writeSnapshot(linked);

  const changed = plan.add.length + plan.remove.length + plan.update.length > 0;
  if (changed) broadcast("gmail:accounts-changed");
  if (Object.values(plan).some((list) => list.length > 0)) {
    logger.info("linked-accounts", "Reconciled", {
      linked: plan.link.length,
      unlinked: plan.unlink.length,
      added: plan.add.length,
      removed: plan.remove.length,
      updated: plan.update.length,
      moved: plan.moved.length,
    });
  }
}
