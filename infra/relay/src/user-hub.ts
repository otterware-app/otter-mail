/**
 * One Durable Object per Otter account: holds the WebSocket of every device
 * signed in to it and fans relay events out to them. Uses hibernation, so
 * idle connections cost nothing, and answers `ping` with `pong` without
 * waking up.
 */

import { DurableObject } from "cloudflare:workers";
import type { RelayEvent } from "@otter-mail/contracts/relay";
import * as apns from "./apns.ts";
import * as push from "./push.ts";
import { connection, NotificationFailure } from "./notification-connections.ts";
import { stillEligible } from "./notification-providers.ts";
import type { Env } from "./worker.ts";

type PendingPush = {
  userId: string;
  email: string;
  historyId: string;
  attempts: number;
  due: number;
  verified?: {
    provider: "gmail" | "outlook" | "imap";
    messageId: string;
    inbox: boolean;
    generation: string;
    folder?: string;
    uidValidity?: number;
  };
  inboxMessage?: PendingPush["verified"];
};

/** Set by the Worker on the upgrade request it forwards: the socket's session. */
export const SESSION_HEADER = "x-otter-session";

export class UserHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Accepts a device's WebSocket (the Worker already authenticated it). */
  override async fetch(request: Request): Promise<Response> {
    const sessionId = request.headers.get(SESSION_HEADER);
    if (!sessionId) return new Response("Missing session", { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged with the session, so signing out closes exactly that device's sockets.
    this.ctx.acceptWebSocket(server, [sessionId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends the event to every connected device; returns how many got it. */
  publish(event: RelayEvent): number {
    const message = JSON.stringify(event);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
        delivered += 1;
      } catch {
        // Already closing; its device reconnects and catches up.
      }
    }
    return delivered;
  }

  /** Five-second bursts coalesce, then at most one alert per mailbox each 30 seconds. */
  async queuePush(userId: string, email: string, _historyId: string): Promise<void> {
    // Legacy change markers never produce a visible alert. The provider watcher verifies additions.
    if (this.env.NOTIFICATION_MAILBOX) {
      await this.env.NOTIFICATION_MAILBOX.get(
        this.env.NOTIFICATION_MAILBOX.idFromName(JSON.stringify([userId, email])),
      ).changed();
    }
  }

  async queueVerifiedPush(
    userId: string,
    email: string,
    historyId: string,
    verified: NonNullable<PendingPush["verified"]>,
  ): Promise<void> {
    if (!apns.configured(this.env)) return;
    if (!(await push.devices(this.env, userId, email)).length) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get<string>(`new-marker:${email}`);
      if (!apns.newer(historyId, previous)) return;
      const last = (await this.ctx.storage.get<number>(`last:${email}`)) ?? 0;
      const due = Math.max(Date.now() + 5000, last + 30_000);
      const existing = await this.ctx.storage.get<PendingPush>(`pending:${email}`);
      const nextDue = existing?.due ?? due;
      await this.ctx.storage.put({
        [`new-marker:${email}`]: historyId,
        [`pending:${email}`]: {
          userId,
          email,
          historyId,
          attempts: 0,
          due: nextDue,
          verified,
          inboxMessage: verified.inbox ? verified : existing?.inboxMessage,
        },
      });
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm || alarm > nextDue) await this.ctx.storage.setAlarm(nextDue);
    });
  }

  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.list<PendingPush>({ prefix: "pending:" });
    for (const [key, event] of pending) {
      if (event.due > Date.now()) continue;
      if (!event.verified) {
        await this.ctx.storage.delete(key);
        continue;
      }
      let retryDelay = 0;
      const devices = await push.devices(this.env, event.userId, event.email);
      for (const device of devices) {
        const receipt = `new-sent:${device.session_id}:${event.email}`;
        if (!apns.newer(event.historyId, await this.ctx.storage.get<string>(receipt))) continue;
        // Registration/unlink/revocation is checked again immediately before submission.
        const current = (await push.devices(this.env, event.userId, event.email)).find(
          (d) => d.session_id === device.session_id,
        );
        if (!current) continue;
        const selected =
          current.notification_mode === "inbox" ? event.inboxMessage : event.verified;
        if (!selected) continue;
        const linked = await this.env.DB.prepare(
          "SELECT 1 FROM notification_connections WHERE user_id=? AND email=? AND generation=? AND status='ready'",
        )
          .bind(event.userId, event.email, selected.generation)
          .first();
        if (!linked) continue;
        const row = await connection(this.env, event.userId, event.email);
        if (!row || row.generation !== selected.generation) continue;
        try {
          if (!(await stillEligible(this.env, row, selected, current.notification_mode))) {
            await this.ctx.storage.put(receipt, event.historyId);
            continue;
          }
        } catch (error) {
          if (!(error instanceof NotificationFailure && error.reauthorize))
            retryDelay = Math.max(retryDelay, 30_000);
          continue;
        }
        // Provider reads yielded: revocation/unlink/Off may have changed while they were in flight.
        const recipient = (await push.devices(this.env, event.userId, event.email)).find(
          (d) => d.session_id === current.session_id && d.token === current.token,
        );
        if (!recipient) continue;
        if (recipient.notification_mode !== current.notification_mode) {
          retryDelay = Math.max(retryDelay, 5000);
          continue;
        }
        if (
          (await connection(this.env, event.userId, event.email))?.generation !==
          selected.generation
        )
          continue;
        const result = await apns.send(this.env, recipient, {
          version: 2,
          userId: event.userId,
          email: event.email,
          historyId: event.historyId,
          mode: current.notification_mode,
          provider: selected.provider,
          messageId: selected.messageId,
          ...(selected.folder ? { folder: selected.folder } : {}),
          ...(selected.uidValidity ? { uidValidity: selected.uidValidity } : {}),
        });
        if (result === "invalid") await push.invalidate(this.env, recipient);
        if (typeof result === "object") retryDelay = Math.max(retryDelay, result.retryAfterMs);
        else if (result === "retry")
          retryDelay = Math.max(retryDelay, 30_000 * (event.attempts + 1));
        else await this.ctx.storage.put(receipt, event.historyId);
      }
      await this.ctx.storage.put(`last:${event.email}`, Date.now());
      await this.ctx.storage.transaction(async (storage) => {
        const latest = await storage.get<PendingPush>(key);
        if (latest?.historyId !== event.historyId) {
          if (latest)
            await storage.put(key, {
              ...latest,
              due: Math.max(latest.due, Date.now() + Math.max(30_000, retryDelay)),
            });
          return;
        }
        if (retryDelay && event.attempts < 2) {
          await storage.put(key, {
            ...event,
            attempts: event.attempts + 1,
            due: Date.now() + retryDelay,
          });
        } else await storage.delete(key);
      });
    }
    const remaining = await this.ctx.storage.list<PendingPush>({ prefix: "pending:" });
    if (remaining.size)
      await this.ctx.storage.setAlarm(Math.min(...Array.from(remaining.values(), (p) => p.due)));
  }

  /** Closes a signed-out session's sockets, or every socket when the account is deleted. */
  async disconnect(sessionId?: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets(sessionId)) {
      socket.close(4001, "Signed out");
    }
    if (!sessionId) await this.ctx.storage.deleteAll();
    else {
      for (const prefix of [`sent:${sessionId}:`, `new-sent:${sessionId}:`]) {
        const receipts = await this.ctx.storage.list({ prefix });
        if (receipts.size) await this.ctx.storage.delete([...receipts.keys()]);
      }
    }
  }

  async forgetPush(email: string): Promise<void> {
    await this.ctx.storage.delete([
      `pending:${email}`,
      `marker:${email}`,
      `new-marker:${email}`,
      `last:${email}`,
    ]);
    for (const prefix of ["sent:", "new-sent:"]) {
      const receipts = await this.ctx.storage.list({ prefix });
      const matching = [...receipts.keys()].filter((key) => key.endsWith(`:${email}`));
      if (matching.length) await this.ctx.storage.delete(matching);
    }
  }

  override webSocketMessage(): void {
    // Clients only send `ping`, which the auto-response answers.
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Codes like 1006 can't be echoed; the socket is gone either way.
    }
  }
}
