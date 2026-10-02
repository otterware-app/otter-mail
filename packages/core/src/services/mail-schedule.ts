import type { MailSchedule } from "@otter-mail/contracts";
import { broadcast } from "../ipc.js";
import { platform } from "../platform.js";
import { providerFor } from "../providers/index.js";
import type { OutgoingMail } from "../providers/provider.js";
import { getAccount } from "./account-store.js";
import * as store from "./mail-store.js";
import { updateDockBadge } from "./notifier.js";

// The backend is single-owner (a utility process, or the elected web worker).
// SQLite commits the claim before a send: a crash must never automatically resend it.
function db() {
  const db = platform().database();
  db.exec(`CREATE TABLE IF NOT EXISTS mail_schedule (
    id TEXT PRIMARY KEY, accountId TEXT NOT NULL, kind TEXT NOT NULL,
    dueAt INTEGER NOT NULL, state TEXT NOT NULL, subject TEXT NOT NULL,
    threadId TEXT, payload TEXT, error TEXT
  )`);
  return db;
}

function changed() {
  broadcast("gmail:schedule-changed");
  broadcast("gmail:mail-changed");
  updateDockBadge();
}

export function futureTime(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(new Date(value).getTime()) ||
    value <= Date.now()
  ) {
    throw new Error("Choose a date and time in the future.");
  }
  return value;
}

export function listSchedules(): MailSchedule[] {
  return db()
    .prepare(
      "SELECT id, accountId, kind, dueAt, state, subject, threadId, error FROM mail_schedule ORDER BY dueAt",
    )
    .all() as unknown as MailSchedule[];
}

export function scheduleSend(accountId: string, mail: OutgoingMail, dueAt: number): void {
  futureTime(dueAt);
  db()
    .prepare("INSERT INTO mail_schedule VALUES (?, ?, 'send', ?, 'pending', ?, ?, ?, NULL)")
    .run(
      crypto.randomUUID(),
      accountId,
      dueAt,
      mail.subject,
      mail.threadId ?? null,
      JSON.stringify(mail),
    );
  changed();
}

function failed(id: string, error: unknown) {
  db()
    .prepare("UPDATE mail_schedule SET state = 'failed', error = ? WHERE id = ?")
    .run(error instanceof Error ? error.message : String(error), id);
  changed();
  broadcast("gmail:schedule-failed");
}

export async function snoozeThread(
  accountId: string,
  threadId: string,
  dueAt: number,
): Promise<void> {
  futureTime(dueAt);
  if (!(await getAccount(accountId))) throw new Error("Mailbox no longer exists.");
  if (
    listSchedules().some(
      (s) => s.accountId === accountId && s.threadId === threadId && s.kind === "snooze",
    )
  ) {
    throw new Error("This conversation is already snoozed. Manage it in Scheduled & snoozed.");
  }
  const rows = store.getThreadMessages(accountId, threadId);
  if (
    !rows.some((m) => m.labelIds.includes("INBOX")) ||
    rows.some((m) => m.labelIds.some((l) => l === "TRASH" || l === "SPAM"))
  ) {
    throw new Error("Only conversations in the inbox can be snoozed.");
  }
  const id = crypto.randomUUID();
  db()
    .prepare("INSERT INTO mail_schedule VALUES (?, ?, 'snooze', ?, 'running', ?, ?, ?, NULL)")
    .run(
      id,
      accountId,
      dueAt,
      rows[0].subject,
      threadId,
      JSON.stringify(rows.filter((m) => m.labelIds.includes("INBOX")).map((m) => m.id)),
    );
  changed();
  try {
    await providerFor(accountId).modifyThread(accountId, threadId, { removeLabelIds: ["INBOX"] });
    store.applyLabelChangeToThread(accountId, threadId, [], ["INBOX"]);
    db().prepare("UPDATE mail_schedule SET state = 'pending' WHERE id = ?").run(id);
    changed();
  } catch (error) {
    failed(id, error);
    throw error;
  }
}

async function wake(entry: MailSchedule): Promise<void> {
  const provider = providerFor(entry.accountId);
  // Read current metadata so trash/deletions elsewhere are never resurrected.
  const cached = store.getThreadMessages(entry.accountId, entry.threadId!);
  const fresh = await provider.getSummaries(
    entry.accountId,
    cached.map((m) => m.id),
  );
  store.upsertMessages(entry.accountId, fresh);
  const payload = db()
    .prepare("SELECT payload FROM mail_schedule WHERE id = ?")
    .get(entry.id)?.payload;
  const inboxIds = new Set<string>(payload ? (JSON.parse(String(payload)) as string[]) : []);
  for (const m of fresh) {
    if (m.labelIds.some((l) => ["TRASH", "SPAM", "DRAFT"].includes(l))) continue;
    // Mail sent to yourself can be both Sent and Inbox; ordinary replies stay in Sent.
    if (m.labelIds.includes("SENT") && !inboxIds.has(m.id)) continue;
    await provider.modifyMessage(entry.accountId, m.id, { addLabelIds: ["INBOX"] });
    // IMAP moves re-key their cached rows themselves.
    store.applyLabelChange(entry.accountId, m.id, ["INBOX"], []);
  }
}

function claim(id: string): MailSchedule {
  const entry = listSchedules().find((s) => s.id === id);
  if (!entry) throw new Error("This item is no longer scheduled.");
  if (
    !db()
      .prepare(
        "UPDATE mail_schedule SET state = 'running', error = NULL WHERE id = ? AND state != 'running'",
      )
      .run(id).changes
  ) {
    throw new Error("This item is already being processed.");
  }
  changed();
  return entry;
}

export async function cancelSchedule(id: string): Promise<void> {
  const entry = claim(id);
  try {
    if (entry.kind === "send") {
      const row = db().prepare("SELECT payload FROM mail_schedule WHERE id = ?").get(id)!;
      const mail = JSON.parse(String(row.payload)) as OutgoingMail;
      const provider = providerFor(entry.accountId);
      const draft = await provider.saveDraft(entry.accountId, mail);
      db().prepare("DELETE FROM mail_schedule WHERE id = ?").run(id);
      if (draft.messageId) {
        try {
          store.upsertMessages(
            entry.accountId,
            await provider.getSummaries(entry.accountId, [draft.messageId]),
          );
          store.setDraftId(entry.accountId, draft.messageId, draft.draftId);
        } catch {
          /* The draft exists; sync will bring it into the cache. */
        }
      }
    } else {
      await wake(entry);
    }
    db().prepare("DELETE FROM mail_schedule WHERE id = ?").run(id);
    changed();
  } catch (error) {
    failed(id, error);
    throw error;
  }
}

export function removeAccountSchedules(accountId: string): void {
  db().prepare("DELETE FROM mail_schedule WHERE accountId = ?").run(accountId);
  changed();
}

let processing = false;
export async function processSchedules(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (const item of listSchedules()) {
      if (item.state !== "pending" || item.dueAt > Date.now()) continue;
      if (!(await getAccount(item.accountId))) {
        removeAccountSchedules(item.accountId);
        continue;
      }
      // Account lookup yielded: cancellation may have changed or removed the job.
      if (!listSchedules().some((s) => s.id === item.id && s.state === "pending")) continue;
      const entry = claim(item.id);
      try {
        if (entry.kind === "send") {
          const row = db().prepare("SELECT payload FROM mail_schedule WHERE id = ?").get(entry.id)!;
          const provider = providerFor(entry.accountId);
          const result = await provider.send(
            entry.accountId,
            JSON.parse(String(row.payload)) as OutgoingMail,
          );
          // Commit completion before best-effort cache work.
          db().prepare("DELETE FROM mail_schedule WHERE id = ?").run(entry.id);
          if (result.messageId) {
            try {
              store.upsertMessages(
                entry.accountId,
                await provider.getSummaries(entry.accountId, [result.messageId]),
              );
            } catch {
              /* Sync fills this in. */
            }
          }
        } else {
          await wake(entry);
          db().prepare("DELETE FROM mail_schedule WHERE id = ?").run(entry.id);
        }
        changed();
      } catch (error) {
        // A network failure may mean the server accepted a send. Keep its
        // contents for review, never retry an uncertain delivery automatically.
        failed(entry.id, error);
      }
    }
  } finally {
    processing = false;
  }
}

export function startMailSchedule(): void {
  db()
    .prepare("UPDATE mail_schedule SET state = 'failed', error = ? WHERE state = 'running'")
    .run(
      "Interrupted while processing. Check Sent before restoring a scheduled message to Drafts.",
    );
  const run = () => {
    void processSchedules().catch((error) =>
      platform().log("error", "mail-schedule", String(error)),
    );
  };
  run();
  setInterval(run, 15_000);
  platform().onResume(run);
}
