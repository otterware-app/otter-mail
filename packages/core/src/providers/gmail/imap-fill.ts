/**
 * The first sync of a Gmail mailbox, over IMAP. Gmail speaks it with the
 * same sign-in (the https://mail.google.com/ scope, SASL XOAUTH2), a UID
 * FETCH answers a thousand messages at once, and none of it counts against
 * the Gmail API's quota: every list row of a 13,000-message mailbox is in
 * within seconds, where the API (a message fetch is 20 of the 6,000 units a
 * minute) takes most of an hour.
 *
 * Gmail's IMAP ids are its API ids in decimal (X-GM-MSGID, X-GM-THRID) and
 * X-GM-LABELS carries the labels, so rows land as the API writes them, but
 * for what IMAP doesn't have: the snippet and the category labels
 * (Promotions, Social, …). The sync fills categories in from API listings
 * after this; snippets come with the bodies, from the offline downloads.
 */

import { platform } from "../../platform.js";
import {
  connectImap,
  decodeMailboxName,
  type FetchedMessage,
  type SpecialUse,
} from "../../protocols/index.js";
import { getAccount } from "../../services/account-store.js";
import * as store from "../../services/mail-store.js";
import type { MessageSummary } from "../../types.js";
import type { SyncContext } from "../provider.js";
import { mapMessageSummary } from "./api.js";

const ROWS_PER_FETCH = 1000;
const HEADERS = ["From", "To", "Cc", "Subject", "Date", "Message-ID", "References"];

/** Gmail's system labels as X-GM-LABELS names them. */
const SYSTEM_LABELS: Record<string, string> = {
  "\\Inbox": "INBOX",
  "\\Important": "IMPORTANT",
  "\\Sent": "SENT",
  "\\Draft": "DRAFT",
  "\\Drafts": "DRAFT",
  "\\Starred": "STARRED",
};

/** All Mail holds everything but Spam and Trash, which are folders of their own. */
const FOLDERS: [SpecialUse, string | null][] = [
  ["\\All", null],
  ["\\Junk", "SPAM"],
  ["\\Trash", "TRASH"],
];

/** Caches every message's row, newest first; throws when IMAP isn't to be had. */
export async function fillOverImap(accountId: string, ctx: SyncContext): Promise<void> {
  const account = await getAccount(accountId);
  const client = await connectImap({
    host: "imap.gmail.com",
    port: 993,
    security: "tls",
    auth: {
      user: account?.email ?? accountId,
      accessToken: await platform().google.getAccessToken(accountId),
    },
  });
  try {
    const folders = await client.list();
    const userLabels = new Map(
      store
        .getLabels(accountId)
        .filter((l) => l.type === "user")
        .map((l) => [l.name, l.id]),
    );
    let synced = 0;
    let total = 0;
    ctx.update({ phase: "full", synced, total: null });
    for (const [use, folderLabel] of FOLDERS) {
      const folder = folders.find((f) => f.specialUse === use);
      if (!folder) {
        if (use === "\\All") throw new Error("Gmail shows no All Mail folder over IMAP.");
        continue;
      }
      await client.select(folder.path, { readOnly: true });
      const uids = (await client.search("ALL")).sort((a, b) => b - a);
      total += uids.length;
      ctx.update({ total });
      for (let i = 0; i < uids.length; i += ROWS_PER_FETCH) {
        const fetched = await client.fetch(uids.slice(i, i + ROWS_PER_FETCH), {
          flags: true,
          internalDate: true,
          headers: HEADERS,
          gmail: true,
        });
        const rows = fetched
          .map((m) => rowOf(m, folderLabel, userLabels))
          .filter((row): row is MessageSummary => row !== null);
        ctx.assertActive();
        // Rows the history feed cached meanwhile are newer than these.
        const fresh = new Set(
          store.filterUnknownIds(
            accountId,
            rows.map((row) => row.id),
          ),
        );
        store.upsertMessages(
          accountId,
          rows.filter((row) => fresh.has(row.id)),
        );
        synced += rows.length;
        ctx.update({ synced });
        ctx.bumpRevision();
      }
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** The row the Gmail API would give for a message, but for the snippet and categories. */
function rowOf(
  m: FetchedMessage,
  folderLabel: string | null,
  userLabels: Map<string, string>,
): MessageSummary | null {
  if (m.gmailId === undefined) return null;
  const labelIds = new Set<string>();
  for (const raw of m.gmailLabels ?? []) {
    // Gmail's other system labels (\Muted, …) aren't API labels.
    const id = SYSTEM_LABELS[raw] ?? userLabels.get(decodeMailboxName(raw));
    if (id) labelIds.add(id);
  }
  if (!m.flags?.includes("\\Seen")) labelIds.add("UNREAD");
  if (m.flags?.includes("\\Flagged")) labelIds.add("STARRED");
  if (folderLabel) labelIds.add(folderLabel);
  const headers = m.headers ?? {};
  return mapMessageSummary({
    id: m.gmailId.toString(16),
    threadId: (m.gmailThreadId ?? m.gmailId).toString(16),
    labelIds: [...labelIds],
    internalDate: String(m.internalDate?.getTime() ?? 0),
    payload: {
      headers: HEADERS.filter((name) => headers[name.toLowerCase()] !== undefined).map((name) => ({
        name,
        value: headers[name.toLowerCase()]!,
      })),
    },
  });
}
