/**
 * Agent chats (contracts' chats.ts), local-first: this device keeps them in
 * chats.json, the renderer saves each change there at once, and each changed
 * chat is written whole to the relay when signed in to an Otter account.
 * Chats not on the relay yet are `pending`, by id; a pull (on connecting,
 * and on the relay's `chats` event) takes the chats written elsewhere since,
 * and leaves the pending ones as they are here. Without an Otter account,
 * chats stay on this device until one signs in.
 */

import {
  CHAT_LIMITS,
  LOCAL_CHAT_PROVIDERS,
  chatForSync,
  type Chat,
  type ChatSummary,
  type ChatTurn,
  type ListChatsResponse,
} from "@otter-mail/contracts/chats";

import { broadcast } from "../ipc.js";
import { readJson, writeJson } from "../json-file.js";
import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { getOtterUser, relayRequest, RelayError } from "./otter-account.js";

const FILE = "chats.json";
/** Chats changed (their ids): saved here, pulled from the relay, or deleted. */
export const CHATS_CHANGED = "chats:changed";

type Device = { id: string; name: string };
type ChatsFile = { chats: Chat[]; pending: string[]; device: Device };

let loading: Promise<ChatsFile> | null = null;
let writes: Promise<unknown> = Promise.resolve();

function load(): Promise<ChatsFile> {
  loading ??= (async () => {
    const saved = await readJson<Partial<ChatsFile>>(FILE);
    const name = platform().deviceName ?? "This computer";
    return {
      chats: Array.isArray(saved?.chats) ? saved.chats : [],
      pending: Array.isArray(saved?.pending) ? saved.pending : [],
      device: saved?.device?.id ? { id: saved.device.id, name } : { id: crypto.randomUUID(), name },
    };
  })();
  return loading;
}

/** One change at a time, written to disk before the next; `changed` is broadcast. */
function mutate<T>(
  change: (file: ChatsFile) => T | Promise<T>,
  changed: () => string[],
): Promise<T> {
  const run = writes.then(async () => {
    const file = await load();
    const result = await change(file);
    await writeJson(FILE, file);
    const ids = changed();
    if (ids.length > 0) broadcast(CHATS_CHANGED, { ids });
    return result;
  });
  writes = run.catch(() => {});
  return run;
}

/** `delay`: a chat whose turn still streams goes in a while, the rest at once. */
function queue(file: ChatsFile, id: string, delay = 300): void {
  if (!file.pending.includes(id)) file.pending.push(id);
  schedulePush(delay);
}

/** While a turn streams, the relay (and so every other device) has the chat this often. */
const STREAMING_PUSH_MS = 15_000;

const summary = ({ turns: _turns, ...chat }: Chat): Omit<ChatSummary, "deletedAt"> => chat;

/** This device's chats, newest first, without their turns; and this device. */
export async function listChats(): Promise<{
  chats: Omit<ChatSummary, "deletedAt">[];
  device: Device;
}> {
  const file = await load();
  return { chats: file.chats.map(summary), device: file.device };
}

export async function getChat(id: string): Promise<Chat | null> {
  return (await load()).chats.find((c) => c.id === id) ?? null;
}

/**
 * A chat as the renderer has it now; a Claude or Codex chat is this device's.
 * `settled`: no turn runs in it. Past the limit, the oldest chats go (everywhere).
 */
export function saveChat(chat: Chat, settled = true): Promise<void> {
  return mutate(
    (file) => {
      const local = LOCAL_CHAT_PROVIDERS.includes(chat.provider);
      const saved = { ...chat, device: local ? (chat.device ?? file.device) : null };
      const chats = [saved, ...file.chats.filter((c) => c.id !== chat.id)].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      file.chats = chats.slice(0, CHAT_LIMITS.chats);
      for (const dropped of chats.slice(CHAT_LIMITS.chats)) queue(file, dropped.id);
      queue(file, chat.id, settled ? 300 : STREAMING_PUSH_MS);
    },
    () => [chat.id],
  );
}

export function deleteChat(id: string): Promise<void> {
  return mutate(
    (file) => {
      file.chats = file.chats.filter((c) => c.id !== id);
      queue(file, id);
    },
    () => [id],
  );
}

// ── Writing to the relay ─────────────────────────────────────────────────────

const RETRY_MS = 30_000;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushAt = 0;
let pushing: Promise<void> | null = null;
/** The chat being written right now: still this device's until the relay has it. */
let inFlight: string | null = null;

function schedulePush(delay = 300): void {
  if (!getOtterUser()) return;
  if (pushTimer && pushAt <= Date.now() + delay) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushAt = Date.now() + delay;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void push();
  }, delay);
}

function push(): Promise<void> {
  pushing ??= (async () => {
    try {
      while (getOtterUser()) {
        const next = await mutate(
          (file) => {
            const id = file.pending[0];
            if (!id) return null;
            file.pending = file.pending.slice(1);
            inFlight = id;
            const chat = file.chats.find((c) => c.id === id);
            const route = `/v1/chats/${encodeURIComponent(id)}`;
            return {
              id,
              send: chat
                ? () => relayRequest("PUT", route, chatForSync(chat))
                : () => relayRequest("DELETE", route),
            };
          },
          () => [],
        );
        if (!next) return;
        try {
          await next.send();
        } catch (err) {
          // A later write from another device wins: take it.
          if (err instanceof RelayError && err.status === 409) {
            schedulePull();
            continue;
          }
          // Refused for good (invalid, too big, too many): it stays on this device.
          if (err instanceof RelayError && [400, 404, 413].includes(err.status)) {
            logger.warn("chats", `The relay refused a chat: ${err.message}`);
            continue;
          }
          await mutate(
            (file) => {
              if (!file.pending.includes(next.id)) file.pending.unshift(next.id);
            },
            () => [],
          );
          schedulePush(RETRY_MS);
          return;
        } finally {
          inFlight = null;
        }
      }
    } finally {
      pushing = null;
    }
  })();
  return pushing;
}

// ── Reading from the relay ───────────────────────────────────────────────────

let pullTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePull(): void {
  pullTimer ??= setTimeout(() => {
    pullTimer = null;
    void pullChats().catch((err: unknown) =>
      logger.info("chats", `Chats sync failed: ${String(err)}`),
    );
  }, 300);
}

/**
 * The relay's copy over this device's, keeping what the relay leaves out
 * (`chatForSync`): the older turns before its first, steps' whole outputs,
 * and the thumbnails of this device's images.
 */
function merged(remote: Chat, local: Chat | undefined): Chat {
  if (!local) return remote;
  const mine = new Map(local.turns.map((t) => [t.id, t]));
  const first = remote.turns[0]?.id;
  const at = first === undefined ? -1 : local.turns.findIndex((t) => t.id === first);
  const turns = remote.turns.map((turn): ChatTurn => {
    const own = mine.get(turn.id);
    if (!own) return turn;
    return {
      ...turn,
      items: turn.items?.map((item, i) => {
        const whole = own.items?.[i];
        return item.kind === "step" &&
          whole?.kind === "step" &&
          item.output !== undefined &&
          whole.output !== undefined &&
          item.output.endsWith("…") &&
          whole.output.startsWith(item.output.slice(0, -1))
          ? { ...item, output: whole.output }
          : item;
      }),
      attachments: turn.attachments?.map((a) => ({
        ...a,
        thumb: a.thumb ?? own.attachments?.find((b) => b.name === a.name)?.thumb,
      })),
    };
  });
  return { ...remote, turns: [...(at > 0 ? local.turns.slice(0, at) : []), ...turns] };
}

/**
 * The account's chats: those written elsewhere since this device last had
 * them come in whole, those deleted elsewhere go, and this device's own
 * chats the relay doesn't have yet are written to it.
 */
export async function pullChats(): Promise<void> {
  if (!getOtterUser()) return;
  const { chats: remote } = await relayRequest<ListChatsResponse>("GET", "/v1/chats");
  const file = await load();
  const waiting = () => new Set([...file.pending, ...(inFlight ? [inFlight] : [])]);
  const before = new Map(file.chats.map((c) => [c.id, c.updatedAt]));
  const newer = remote.filter(
    (r) => !r.deletedAt && !waiting().has(r.id) && (before.get(r.id) ?? -1) < r.updatedAt,
  );
  const fetched = new Map<string, Chat>();
  for (const { id } of newer) {
    try {
      const { chat } = await relayRequest<{ chat: Chat }>(
        "GET",
        `/v1/chats/${encodeURIComponent(id)}`,
      );
      fetched.set(id, chat);
    } catch (err) {
      if (!(err instanceof RelayError && err.status === 404)) throw err;
    }
  }
  const changed: string[] = [];
  await mutate(
    (file) => {
      const pending = waiting();
      const chats = new Map(file.chats.map((c) => [c.id, c]));
      const known = new Set(remote.map((r) => r.id));
      for (const r of remote) {
        if (pending.has(r.id)) continue;
        if (r.deletedAt) {
          if (chats.delete(r.id)) changed.push(r.id);
          continue;
        }
        const chat = fetched.get(r.id);
        const local = chats.get(r.id);
        if (chat && (local?.updatedAt ?? -1) < chat.updatedAt) {
          chats.set(r.id, merged(chat, local));
          changed.push(r.id);
        }
      }
      for (const chat of chats.values()) {
        if (!known.has(chat.id) && !pending.has(chat.id)) file.pending.push(chat.id);
      }
      file.chats = [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    () => changed,
  );
  if (file.pending.length > 0) schedulePush(0);
}
