/** One serialized provider connection per Otter user/mailbox. Only cursors and message IDs live in the object. */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./worker.ts";
import * as connections from "./notification-connections.ts";
import * as providers from "./notification-providers.ts";
import * as push from "./push.ts";

export class NotificationMailbox extends DurableObject<Env> {
  private running: Promise<void> | undefined;

  async start(userId: string, email: string): Promise<void> {
    // A new grant starts from the mailbox's current state. An earlier grant's cursor would walk,
    // and announce, everything that arrived while it was stopped.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("identity", { userId, email });
    await this.check(false);
    if ((await connections.connection(this.env, userId, email))?.status === "connecting")
      await this.check(false);
  }
  async changed(): Promise<void> {
    // A provider that is throttling us keeps its backoff: new deliveries wait for the retry,
    // which reads everything they announced.
    if (await this.ctx.storage.get<number>("failures")) return;
    // Multiple Pub/Sub/Graph deliveries become one history walk.
    const alarm = await this.ctx.storage.getAlarm();
    const due = Date.now() + 2000;
    if (!alarm || alarm > due) await this.ctx.storage.setAlarm(due);
  }
  async stop(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  override async alarm(): Promise<void> {
    await this.check(true);
  }

  private async check(background: boolean): Promise<void> {
    if (this.running) return this.running;
    const work = this.run(background);
    this.running = work;
    try {
      await work;
    } finally {
      if (this.running === work) this.running = undefined;
    }
  }
  private async run(background: boolean): Promise<void> {
    const identity = await this.ctx.storage.get<{ userId: string; email: string }>("identity");
    if (!identity) return;
    const { userId, email } = identity;
    const row = await connections.connection(this.env, userId, email);
    if (!row) {
      await this.stop();
      return;
    }
    if (background && row.status === "reauthorize") return;
    const devices = await push.devices(this.env, userId, email);
    // An explicitly disabled/disconnected device never causes background Gmail/IMAP access.
    if (background && !devices.length) return;
    const cursor = await this.ctx.storage.get<providers.MailCursor>("cursor");
    let next = row.provider === "imap" ? 2000 : 300_000;
    let stage = "provider-read";
    try {
      const result =
        row.provider === "gmail"
          ? await providers.gmailCheck(this.env, row, cursor)
          : row.provider === "outlook"
            ? await providers.outlookCheck(this.env, row, cursor)
            : await providers.imapCheck(
                this.env,
                row,
                cursor,
                devices.some((d) => d.notification_mode === "all"),
                background,
              );
      const current = await connections.connection(this.env, userId, email);
      if (current?.generation !== row.generation || !(await this.ctx.storage.get("identity")))
        return;
      // A durable outbox is committed with the cursor. Alarm retries cannot lose or duplicate arrivals.
      stage = "commit";
      await this.ctx.storage.transaction(async (storage) => {
        let sequence = (await storage.get<number>("sequence")) ?? 0;
        for (const message of result.messages) {
          sequence = Math.max(sequence + 1, Date.now());
          await storage.put(`outbox:${sequence}`, {
            ...message,
            sequence: String(sequence),
            generation: row.generation,
            provider: row.provider,
          });
        }
        await storage.put({ cursor: result.cursor, sequence });
      });
      await this.env.DB.prepare(
        "UPDATE notification_connections SET status='ready',updated_at=? WHERE user_id=? AND email=? AND generation=?",
      )
        .bind(Date.now(), userId, email, row.generation)
        .run();
      const outbox = await this.ctx.storage.list<
        providers.IncomingMessage & {
          sequence: string;
          generation: string;
          provider: "gmail" | "outlook" | "imap";
        }
      >({ prefix: "outbox:" });
      const hub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId));
      stage = "enqueue";
      for (const [key, message] of outbox) {
        if (message.generation === row.generation) {
          await hub.queueVerifiedPush(userId, email, message.sequence, message);
          await hub.publish({ type: "mail", email, historyId: "" });
        }
        await this.ctx.storage.delete(key);
      }
      await this.ctx.storage.delete("failures");
    } catch (error) {
      const reauthorize = error instanceof connections.NotificationFailure && error.reauthorize;
      console.warn("Notification check failed", {
        provider: row.provider,
        stage,
        reason: error instanceof connections.NotificationFailure ? error.reason : "unexpected",
        detail: error instanceof connections.NotificationFailure ? error.detail : undefined,
        category: reauthorize
          ? "authorization"
          : error instanceof connections.NotificationFailure
            ? "temporary"
            : "unexpected",
      });
      await this.env.DB.prepare(
        "UPDATE notification_connections SET status=?,updated_at=? WHERE user_id=? AND email=? AND generation=?",
      )
        .bind(reauthorize ? "reauthorize" : "retry", Date.now(), userId, email, row.generation)
        .run();
      if (reauthorize) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const failures = ((await this.ctx.storage.get<number>("failures")) ?? 0) + 1;
      await this.ctx.storage.put("failures", failures);
      next = Math.min(300_000, 10_000 * 2 ** Math.min(failures, 5));
      // No provider error text: IMAP servers can echo commands and OAuth endpoints can echo credentials.
    }
    if (
      (await connections.connection(this.env, userId, email))?.generation === row.generation &&
      (await this.ctx.storage.get("identity"))
    ) {
      const due = Date.now() + next;
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm || alarm > due) await this.ctx.storage.setAlarm(due);
    }
  }
}
