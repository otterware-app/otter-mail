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
import type { Env } from "./worker.ts";

type PendingPush = {
  userId: string;
  email: string;
  historyId: string;
  attempts: number;
  due: number;
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
  async queuePush(userId: string, email: string, historyId: string): Promise<void> {
    if (!apns.configured(this.env)) return;
    if (!(await push.devices(this.env, userId, email)).length) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get<string>(`marker:${email}`);
      if (!apns.newer(historyId, previous)) return;
      const last = (await this.ctx.storage.get<number>(`last:${email}`)) ?? 0;
      const due = Math.max(Date.now() + 5000, last + 30_000);
      const existing = await this.ctx.storage.get<PendingPush>(`pending:${email}`);
      const nextDue = existing?.due ?? due;
      await this.ctx.storage.put({
        [`marker:${email}`]: historyId,
        [`pending:${email}`]: { userId, email, historyId, attempts: 0, due: nextDue },
      });
      const alarm = await this.ctx.storage.getAlarm();
      if (!alarm || alarm > nextDue) await this.ctx.storage.setAlarm(nextDue);
    });
  }

  override async alarm(): Promise<void> {
    const pending = await this.ctx.storage.list<PendingPush>({ prefix: "pending:" });
    for (const [key, event] of pending) {
      if (event.due > Date.now()) continue;
      let retryDelay = 0;
      const devices = await push.devices(this.env, event.userId, event.email);
      for (const device of devices) {
        const receipt = `sent:${device.session_id}:${event.email}`;
        if (!apns.newer(event.historyId, await this.ctx.storage.get<string>(receipt))) continue;
        // Registration/unlink/revocation is checked again immediately before submission.
        const current = (await push.devices(this.env, event.userId, event.email)).find(
          (d) => d.session_id === device.session_id,
        );
        if (!current) continue;
        const result = await apns.send(this.env, current, {
          version: 1,
          userId: event.userId,
          email: event.email,
          historyId: event.historyId,
          mode: current.notification_mode,
        });
        if (result === "invalid") await push.invalidate(this.env, current);
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
      const receipts = await this.ctx.storage.list({ prefix: `sent:${sessionId}:` });
      if (receipts.size) await this.ctx.storage.delete([...receipts.keys()]);
    }
  }

  async forgetPush(email: string): Promise<void> {
    await this.ctx.storage.delete([`pending:${email}`, `marker:${email}`, `last:${email}`]);
    const receipts = await this.ctx.storage.list({ prefix: "sent:" });
    const matching = [...receipts.keys()].filter((key) => key.endsWith(`:${email}`));
    if (matching.length) await this.ctx.storage.delete(matching);
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
