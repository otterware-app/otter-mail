/** APNs registrations contain routing metadata only; Gmail tokens stay on the phone. */
import { HTTPException } from "hono/http-exception";
import type { PutPushDeviceRequest } from "@otter-mail/contracts/relay";
import type { Env } from "./worker.ts";

export type PushDevice = PutPushDeviceRequest & {
  session_id: string;
  user_id: string;
  updated_at: number;
  notification_mode: "inbox" | "all";
};

export async function register(
  env: Env,
  session: { id: string; user: { id: string }; expiresAt: number; createdAt: number },
  input: PutPushDeviceRequest,
): Promise<void> {
  const topic =
    input.environment === "sandbox" ? env.APNS_SANDBOX_TOPIC : env.APNS_PRODUCTION_TOPIC;
  if (!topic || input.topic !== topic)
    throw new HTTPException(400, { message: "Unsupported push topic/environment." });
  const userId = session.user.id;
  const mailboxes = [...new Set(input.mailboxes)];
  for (const email of mailboxes) {
    const linked = await env.DB.prepare(
      "SELECT 1 FROM linked_accounts WHERE user_id = ? AND email = ? AND provider = 'gmail'",
    )
      .bind(userId, email)
      .first();
    if (!linked) throw new HTTPException(403, { message: "Push requires a linked Gmail mailbox." });
  }
  const now = Date.now();
  const allowed =
    "NOT EXISTS (SELECT 1 FROM push_revocations WHERE user_id=? AND (session_id=? OR (session_id='' AND revoked_at>=?)))";
  const results = await env.DB.batch([
    // Token rotation and account switching replace the old owner atomically.
    env.DB.prepare(
      `DELETE FROM push_devices WHERE token = ? AND topic = ? AND environment = ? AND session_id != ? AND ${allowed}`,
    ).bind(
      input.token,
      input.topic,
      input.environment,
      session.id,
      userId,
      session.id,
      session.createdAt,
    ),
    env.DB.prepare(`INSERT INTO push_devices (session_id, user_id, token, topic, environment, mode, expires_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${allowed} ON CONFLICT(session_id) DO UPDATE SET
      user_id=excluded.user_id, token=excluded.token, topic=excluded.topic, environment=excluded.environment,
      mode=excluded.mode, expires_at=excluded.expires_at, updated_at=excluded.updated_at`).bind(
      session.id,
      userId,
      input.token,
      input.topic,
      input.environment,
      input.mode,
      session.expiresAt,
      now,
      userId,
      session.id,
      session.createdAt,
    ),
    env.DB.prepare("DELETE FROM push_mailboxes WHERE session_id = ?").bind(session.id),
    ...mailboxes.map((email) =>
      env.DB.prepare(`INSERT INTO push_mailboxes (session_id, user_id, email)
      SELECT ?, user_id, email FROM linked_accounts WHERE user_id = ? AND email = ? AND provider = 'gmail'
      AND EXISTS (SELECT 1 FROM push_devices WHERE session_id=?)`).bind(
        session.id,
        userId,
        email,
        session.id,
      ),
    ),
  ]);
  if (!results[1]!.meta.changes) throw new HTTPException(401, { message: "Session revoked." });
}

export async function remove(
  env: Env,
  userId: string,
  sessionId?: string,
  revoked = false,
): Promise<void> {
  const statements = [];
  if (revoked)
    statements.push(
      env.DB.prepare(`INSERT INTO push_revocations (user_id, session_id, revoked_at)
    SELECT id, ?, ? FROM user WHERE id=? ON CONFLICT(user_id, session_id) DO UPDATE SET revoked_at=excluded.revoked_at`).bind(
        sessionId ?? "",
        Date.now(),
        userId,
      ),
    );
  statements.push(
    env.DB.prepare(
      `DELETE FROM push_devices WHERE user_id = ?${sessionId ? " AND session_id = ?" : ""}`,
    ).bind(...(sessionId ? [userId, sessionId] : [userId])),
  );
  await env.DB.batch(statements);
}

/** Rechecked before every submission/retry, including account preferences changed on another device. */
export async function devices(env: Env, userId: string, email: string): Promise<PushDevice[]> {
  await env.DB.prepare("DELETE FROM push_devices WHERE user_id=? AND expires_at <= ?")
    .bind(userId, Date.now())
    .run();
  const { results } = await env.DB.prepare(`SELECT d.*,
    CASE WHEN d.mode='inbox' OR json_extract(p.data, '$.settings.notificationsMode')='inbox'
    THEN 'inbox' ELSE 'all' END AS notification_mode FROM push_devices d
    JOIN push_mailboxes m ON m.session_id=d.session_id AND m.user_id=d.user_id
    JOIN linked_accounts a ON a.user_id=m.user_id AND a.email=m.email AND a.provider='gmail'
    LEFT JOIN preferences p ON p.user_id=d.user_id
    WHERE d.user_id=? AND m.email=? AND d.mode!='off'
    AND COALESCE(json_extract(p.data, '$.settings.notificationsMode'), d.mode) != 'off'`)
    .bind(userId, email)
    .all<PushDevice>();
  return results;
}

/** Don't delete a freshly rotated/re-registered token because an older send failed. */
export async function invalidate(env: Env, device: PushDevice): Promise<void> {
  await env.DB.prepare("DELETE FROM push_devices WHERE session_id=? AND token=? AND updated_at=?")
    .bind(device.session_id, device.token, device.updated_at)
    .run();
}
