import { useEffect, useState } from "react";
import { useAccounts } from "./mail/hooks";
import type { GmailAccount } from "./mail/types";
import { setSyncedPreference } from "./synced-preferences";

/**
 * How the mailboxes are arranged, following the Otter account to every
 * device: their order, which are turned off, and whether "All mailboxes" is
 * on. Mailboxes are named by address, the one thing every device agrees on.
 * Core reads the same preference to leave turned-off mailboxes unsynced
 * (packages/core, services/mail-sync.ts).
 */
export type MailboxArrangement = {
  /** Addresses in the user's order; mailboxes not listed follow, as added. */
  order: string[];
  /** Addresses of turned-off mailboxes. */
  off: string[];
  /** "All mailboxes" (the combined inbox) is offered. */
  combined: boolean;
};

const KEY = "mail:mailboxes";
const CHANGE_EVENT = "otter:mailboxes-change";

function read(): MailboxArrangement {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<MailboxArrangement>;
    return { order: value.order ?? [], off: value.off ?? [], combined: value.combined ?? true };
  } catch {
    return { order: [], off: [], combined: true };
  }
}

export function setMailboxArrangement(next: MailboxArrangement): void {
  setSyncedPreference(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The arrangement, re-read when it changes here, in another window, or on another device. */
export function useMailboxArrangement(): MailboxArrangement {
  const [arrangement, setArrangement] = useState(read);
  useEffect(() => {
    const update = () => setArrangement(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) update();
    };
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, update);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return arrangement;
}

/** Accounts in the user's order (turned-off ones included). */
export function arrangeAccounts(
  accounts: GmailAccount[],
  { order }: MailboxArrangement,
): GmailAccount[] {
  const rank = (a: GmailAccount) => {
    const i = order.indexOf(a.email);
    return i === -1 ? order.length : i;
  };
  return accounts
    .map((account, added) => ({ account, added }))
    .sort((x, y) => rank(x.account) - rank(y.account) || x.added - y.added)
    .map((x) => x.account);
}

/**
 * The mailboxes the app shows: turned-on accounts in the user's order, and
 * whether "All mailboxes" is offered (it needs two or more).
 */
export function useMailboxes(): {
  accounts: GmailAccount[];
  combined: boolean;
  isLoading: boolean;
} {
  const query = useAccounts();
  const arrangement = useMailboxArrangement();
  const accounts = arrangeAccounts(query.data ?? [], arrangement).filter(
    (a) => !arrangement.off.includes(a.email),
  );
  return {
    accounts,
    combined: arrangement.combined && accounts.length > 1,
    isLoading: query.isLoading,
  };
}
