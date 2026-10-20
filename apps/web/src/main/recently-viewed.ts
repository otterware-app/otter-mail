/**
 * Recently viewed (Linear's history menu): the conversations, mailboxes and
 * Settings pages you've been to, newest first, for the title bar's clock
 * (top-bar.tsx's HistoryControls). Each is kept with the URL that brings it
 * back and the names shown for it then. This device's own, like a browser's
 * history: localStorage, not synced.
 */

import { useEffect, useSyncExternalStore } from "react";
import { getAccountDisplayName } from "./gmail/account-style";
import { senderLabel } from "./gmail/address";
import { COMBINED_ACCOUNT_ID } from "./gmail/custom-views";
import { CHATS_SPACE, isViewSpaceId } from "./gmail/spaces";
import { SEARCH_MAILBOX } from "./gmail/gmail-query";
import { useLabels, useMessage } from "./gmail/hooks";
import { isBlank, useChats } from "./gmail/chat-store";
import { SYSTEM_LABEL_NAMES, labelDisplayName } from "./gmail/label-names";
import type { GmailAccount, MailView, ViewKind } from "./gmail/types";
import type { SettingsPane } from "./gmail/api";
import { SETTINGS_SECTION_LABELS } from "./settings/settings-search";

/** The icon a place shows: a view's kind, a label, a conversation, Settings, or a chat. */
export type RecentIcon = ViewKind | "label" | "conversation" | "settings" | "chat";

export type RecentPlace = Readonly<{
  /** The router location that brings it back. */
  href: string;
  /** Where it is (its mailbox, the sender, "Settings"), quieter, before the icon. */
  context: string;
  title: string;
  icon: RecentIcon;
}>;

const KEY = "otter:recently-viewed";
const CHANGE_EVENT = "otter:recently-viewed-change";
const MAX = 15;

let cache: { raw: string | null; places: RecentPlace[] } = { raw: null, places: [] };

export function getRecentlyViewed(): RecentPlace[] {
  const raw = localStorage.getItem(KEY);
  if (raw === cache.raw) return cache.places;
  let places: RecentPlace[] = [];
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) places = parsed as RecentPlace[];
  } catch {
    // A broken list starts over.
  }
  cache = { raw, places };
  return places;
}

/** Puts `place` first (once: an earlier visit to the same URL goes). */
function recordRecentlyViewed(place: RecentPlace): void {
  const rest = getRecentlyViewed().filter((p) => p.href !== place.href);
  localStorage.setItem(KEY, JSON.stringify([place, ...rest].slice(0, MAX)));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useRecentlyViewed(): RecentPlace[] {
  return useSyncExternalStore(subscribe, getRecentlyViewed);
}

/** A system label's icon: the kind of the combined view that shows it. */
const SYSTEM_LABEL_ICONS: Record<string, ViewKind> = {
  INBOX: "inbox",
  STARRED: "starred",
  SENT: "sent",
  DRAFT: "drafts",
  IMPORTANT: "important",
  ALL_MAIL: "allmail",
  SPAM: "junk",
  TRASH: "trash",
};

/**
 * Records where HomeView is, once it knows what to call it: a conversation
 * by its subject (from its sender), a mailbox's label or view by name (in
 * that mailbox), a Settings page by its pane, a chat by its title.
 * Searches aren't places.
 */
export function useRecordRecentlyViewed({
  ready,
  href,
  settingsPane,
  mailbox,
  label,
  messageId,
  readerAccount,
  accounts,
  views,
}: {
  ready: boolean;
  href: string;
  settingsPane: SettingsPane | null;
  mailbox: string | null;
  label: string;
  messageId: string | null;
  readerAccount: string | null;
  accounts: GmailAccount[];
  views: MailView[];
}): void {
  const inSettings = settingsPane !== null;
  const message = useMessage(
    !inSettings && messageId ? readerAccount : null,
    inSettings ? null : messageId,
  ).data;
  const ownLabels = useLabels(
    !inSettings && !messageId && mailbox && accounts.some((a) => a.id === mailbox) ? mailbox : null,
  ).data;
  const chat = useChats((s) =>
    mailbox === CHATS_SPACE ? s.conversations.find((c) => c.id === label) : undefined,
  );

  let place: RecentPlace | null = null;
  if (!ready) {
    place = null;
  } else if (settingsPane) {
    place = {
      href,
      context: "Settings",
      title: SETTINGS_SECTION_LABELS[settingsPane],
      icon: "settings",
    };
  } else if (messageId) {
    if (message && message.id === messageId) {
      place = {
        href,
        context: senderLabel(message.fromName, message.fromEmail, message.accountId),
        title: message.subject || "(no subject)",
        icon: "conversation",
      };
    }
  } else if (mailbox === CHATS_SPACE) {
    if (chat && !isBlank(chat)) place = { href, context: "Chats", title: chat.title, icon: "chat" };
  } else if (mailbox && label !== SEARCH_MAILBOX) {
    const account = accounts.find((a) => a.id === mailbox);
    const context =
      mailbox === COMBINED_ACCOUNT_ID
        ? "All mailboxes"
        : account
          ? getAccountDisplayName(account)
          : isViewSpaceId(mailbox)
            ? "Views"
            : null;
    // A view's space is its list: the view itself.
    const view = views.find((v) => v.id === (isViewSpaceId(mailbox) ? mailbox : label));
    const ownLabel = ownLabels?.find((l) => l.id === label);
    const title =
      view?.name ?? SYSTEM_LABEL_NAMES[label] ?? (ownLabel && labelDisplayName(ownLabel));
    if (context && title) {
      place = {
        href,
        context,
        title,
        icon: view ? view.kind : (SYSTEM_LABEL_ICONS[label] ?? "label"),
      };
    }
  }

  const key = place ? JSON.stringify(place) : null;
  useEffect(() => {
    if (key) recordRecentlyViewed(JSON.parse(key) as RecentPlace);
  }, [key]);
}
