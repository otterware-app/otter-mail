/**
 * notifier.ts
 *
 * New-mail notifications and the unread badge (the Dock, or the browser tab).
 *
 * Notifications fire only for messages newly added by an incremental sync's
 * history feed (mail-sync calls notifyNewMail with them) — never for full
 * syncs, body backfills, or an account's first sync. The badge mirrors
 * total INBOX unread across the mailboxes that are on, after syncs, local
 * mutations, and turning a mailbox on or off.
 */

import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { getAccount } from "./account-store.js";
import { turnedOffMailboxes } from "./mail-sync.js";
import { getSettings } from "./settings-store.js";
import * as mailStore from "./mail-store.js";
import type { MailAccount, MessageSummary } from "../types.js";

const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

function accountLabel(account: MailAccount): string {
  return account.displayName?.trim() || account.name || account.email;
}

/**
 * Notify about messages an incremental sync just stored. Filters by the
 * notifications setting, drops anything older than the account's previous
 * completed sync, and never notifies for the account's own outgoing mail.
 */
export async function notifyNewMail(
  accountId: string,
  added: MessageSummary[],
  prevLastSyncAt: number | null,
): Promise<void> {
  try {
    if (added.length === 0) return;
    const settings = await getSettings();
    if (settings.notificationsMode === "off") return;
    const account = await getAccount(accountId);
    if (!account) return;

    const ownEmail = account.email.toLowerCase();
    const cutoff = prevLastSyncAt ?? 0;
    const fresh = added.filter(
      (m) =>
        m.date > cutoff &&
        m.unread && // already read elsewhere (phone, Gmail web) — nothing to announce
        m.fromEmail.toLowerCase() !== ownEmail &&
        (settings.notificationsMode === "all" || m.labelIds.includes("INBOX")),
    );
    if (fresh.length === 0) return;

    const subtitle = accountLabel(account);
    if (fresh.length <= MAX_INDIVIDUAL_NOTIFICATIONS) {
      for (const m of fresh) {
        platform().notify({
          title: m.fromName || m.fromEmail,
          subtitle,
          body: m.subject || m.snippet,
          open: { accountId, messageId: m.id },
        });
      }
    } else {
      // A click opens the newest of them.
      const newest = fresh.reduce((a, b) => (b.date > a.date ? b : a));
      platform().notify({
        title: `${fresh.length} new messages`,
        subtitle,
        open: { accountId, messageId: newest.id },
      });
    }
  } catch (err) {
    logger.info("notifier", `notifyNewMail failed: ${String(err)}`);
  }
}

/** Mirror total INBOX unread (mailboxes that are on) onto the badge; clear at 0. */
export function updateDockBadge(): void {
  try {
    platform().setUnreadCount(mailStore.countInboxUnreadAll(turnedOffMailboxes()));
  } catch (err) {
    logger.info("notifier", `badge update failed: ${String(err)}`);
  }
}
