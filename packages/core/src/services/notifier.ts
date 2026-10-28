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
 *
 * A sign-in code in the mail is shown in the notification, and on the Mac
 * offered to copy (its Copy & trash button: the mail goes once the code is used).
 */

import {
  findVerificationCode,
  mentionsVerificationCode,
} from "@otter-mail/shared/verification-code";
import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { providerFor } from "../providers/index.js";
import { getAccount } from "./account-store.js";
import { turnedOffMailboxes } from "./mail-sync.js";
import { getSettings } from "./settings-store.js";
import * as mailStore from "./mail-store.js";
import { bodyText } from "./agent/tools/text.js";
import type { MailAccount, MessageSummary } from "../types.js";

const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

function accountLabel(account: MailAccount): string {
  return account.displayName?.trim() || account.name || account.email;
}

/**
 * The sign-in code in new mail, read from its body: the one sync stored (Gmail
 * on the desktop), else fetched now when the preview names a code, and kept
 * for opening it. A preview is one line, too little to find the code in.
 */
async function codeIn(accountId: string, m: MessageSummary): Promise<string | undefined> {
  let detail = mailStore.getMessageDetail(accountId, m.id);
  if (!detail && mentionsVerificationCode(`${m.subject}\n${m.snippet}`)) {
    detail = await providerFor(accountId)
      .getMessage(accountId, m.id)
      .catch(() => null);
    if (detail) mailStore.upsertMessageDetail(accountId, detail);
  }
  return findVerificationCode(m.subject, detail ? bodyText(detail) : m.snippet) ?? undefined;
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
        const about = m.subject || m.snippet;
        const code = await codeIn(accountId, m);
        platform().notify({
          title: m.fromName || m.fromEmail,
          subtitle,
          // The code in the text too, for notifications without buttons (Linux, browsers).
          body: code && !about.includes(code) ? `${about}\n${code}` : about,
          open: { accountId, messageId: m.id },
          code,
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
