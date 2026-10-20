/**
 * The account's agent chats (contracts' chats.ts), a row each. A write
 * replaces the chat unless the relay has a later one (another device's); a
 * delete leaves the row's id and time so other devices let the chat go too.
 */

import { and, count, eq, isNull, sql } from "drizzle-orm";
import { CHAT_LIMITS, type Chat, type ChatSummary } from "@otter-mail/contracts/chats";

import * as schema from "./schema.ts";
import type { Db } from "./store.ts";

const { chats } = schema;

const row = (userId: string, id: string) => and(eq(chats.userId, userId), eq(chats.id, id));

/** Why a write didn't happen: a later write is there, or the account has too many chats. */
export type Refusal = "stale" | "full";

export async function list(db: Db, userId: string): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      id: chats.id,
      title: chats.title,
      provider: chats.provider,
      sessionId: chats.sessionId,
      sessionOwned: chats.sessionOwned,
      lastResponseId: chats.lastResponseId,
      device: chats.device,
      tabs: chats.tabs,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      deletedAt: chats.deletedAt,
    })
    .from(chats)
    .where(eq(chats.userId, userId));
  return rows
    .map((r) => ({
      ...r,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      deletedAt: r.deletedAt?.getTime() ?? null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function get(db: Db, userId: string, id: string): Promise<Chat | null> {
  const [found] = await db
    .select()
    .from(chats)
    .where(and(row(userId, id), isNull(chats.deletedAt)));
  if (!found) return null;
  const { userId: _user, deletedAt: _deleted, ...chat } = found;
  return {
    ...chat,
    turns: JSON.parse(chat.turns) as Chat["turns"],
    createdAt: chat.createdAt.getTime(),
    updatedAt: chat.updatedAt.getTime(),
  };
}

export async function put(db: Db, userId: string, chat: Chat): Promise<Refusal | null> {
  const [existing] = await db
    .select({ updatedAt: chats.updatedAt })
    .from(chats)
    .where(row(userId, chat.id));
  if (!existing) {
    const [{ n }] = await db
      .select({ n: count() })
      .from(chats)
      .where(and(eq(chats.userId, userId), isNull(chats.deletedAt)));
    if (n >= CHAT_LIMITS.chats) return "full";
  }
  const values = {
    title: chat.title,
    provider: chat.provider,
    sessionId: chat.sessionId,
    sessionOwned: chat.sessionOwned,
    lastResponseId: chat.lastResponseId,
    device: chat.device,
    tabs: chat.tabs,
    turns: JSON.stringify(chat.turns),
    createdAt: new Date(chat.createdAt),
    updatedAt: new Date(chat.updatedAt),
    deletedAt: null,
  };
  const written = await db
    .insert(chats)
    .values({ userId, id: chat.id, ...values })
    .onConflictDoUpdate({
      target: [chats.userId, chats.id],
      set: values,
      // A deleted chat stays deleted; an older write loses to the one there.
      setWhere: sql`${chats.deletedAt} is null and ${chats.updatedAt} <= ${chat.updatedAt}`,
    })
    .returning({ id: chats.id });
  return written.length > 0 ? null : "stale";
}

/** Whether there was a chat to delete. */
export async function remove(db: Db, userId: string, id: string): Promise<boolean> {
  const removed = await db
    .update(chats)
    .set({ tabs: [], turns: "[]", title: "", deletedAt: new Date() })
    .where(and(row(userId, id), isNull(chats.deletedAt)))
    .returning({ id: chats.id });
  return removed.length > 0;
}
