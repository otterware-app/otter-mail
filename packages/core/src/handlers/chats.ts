/**
 * Agent chats (services/chats.ts): the renderer's channels. Every change is
 * broadcast as `chats:changed` with the chats' ids, whoever made it (a
 * window, or another device through the relay).
 */

import type { Chat } from "@otter-mail/contracts/chats";

import { handle } from "../ipc.js";
import * as chats from "../services/chats.js";

type Params = Record<string, unknown> | undefined;

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid parameter: "${name}".`);
  return value;
}

function chat(value: unknown): Chat {
  const c = value as Partial<Chat> | null;
  if (!c || typeof c.id !== "string" || !Array.isArray(c.turns) || !Array.isArray(c.tabs))
    throw new Error('Invalid parameter: "chat".');
  return c as Chat;
}

export function registerChatHandlers(): void {
  handle("chats:list", () => chats.listChats());
  handle("chats:get", (params: unknown) => chats.getChat(str((params as Params)?.id, "id")));
  handle("chats:save", (params: unknown) => chats.saveChat(chat((params as Params)?.chat)));
  handle("chats:delete", (params: unknown) => chats.deleteChat(str((params as Params)?.id, "id")));
}
