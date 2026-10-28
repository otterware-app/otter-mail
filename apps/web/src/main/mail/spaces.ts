/**
 * Spaces: what the rail holds, and what the window shows one of at a time
 * (ChatGPT's). Each is named by an id, the route's first segment:
 *
 * - a mailbox: an account (its id); its sidebar has its folders and labels;
 * - a view (a custom view's id, `v_…`): its list alone, no sidebar;
 * - Chats (CHATS_SPACE): the AI workspace; its sidebar lists them, and its
 *   "label" is the chat showing (NEW_CHAT, a new one).
 */

import type { MailAccount, MailView } from "./types";

export const CHATS_SPACE = "__chats__";

/** Chats' "label" for a new chat. */
export const NEW_CHAT = "new";

/** A view's one "label": its list. */
export const VIEW_LIST = "all";

/** Views' ids (views-store's `v_…`), never an account's address. */
export const isViewSpaceId = (id: string) => id.startsWith("v_");

export type Space =
  | { kind: "mailbox"; id: string; account: MailAccount }
  | { kind: "view"; id: string; view: MailView }
  | { kind: "chats"; id: typeof CHATS_SPACE };

/**
 * The space `id` names, among those there are: null for an account that's
 * gone (or turned off), or a deleted view.
 */
export function spaceOf(
  id: string,
  { accounts, views }: { accounts: MailAccount[]; views: MailView[] },
): Space | null {
  if (id === CHATS_SPACE) return { kind: "chats", id };
  if (isViewSpaceId(id)) {
    const view = views.find((v) => v.kind === "custom" && v.id === id);
    return view ? { kind: "view", id, view } : null;
  }
  const account = accounts.find((a) => a.id === id);
  return account ? { kind: "mailbox", id, account } : null;
}

/** Where a space opens: its Inbox, its list, or a new chat. */
export function firstLabelOf(spaceId: string): string {
  if (spaceId === CHATS_SPACE) return NEW_CHAT;
  if (isViewSpaceId(spaceId)) return VIEW_LIST;
  return "INBOX";
}

/** Its list draws on every mailbox (or some), not one account's (Chats: none, so all of them). */
export const spansMailboxes = (space: Space | null) => space != null && space.kind !== "mailbox";
