/**
 * Outlook push notifications: a Graph subscription to the mailbox's messages
 * sends every change to the relay (`/push/outlook/:email`), which passes it
 * on to the devices as Gmail's are. The relay says where to send them and
 * the `clientState` it checks them against (`/v1/outlook/watch`). Each device
 * keeps its own subscription, renewed a day before it lapses; mail
 * subscriptions last at most three days. A device that can't subscribe polls.
 */

import type { OutlookWatchResponse } from "@otter-mail/contracts/relay";

import { logger } from "../../logger.js";
import * as mailStore from "../../services/mail-store.js";
import { relayRequest } from "../../services/otter-account.js";
import { graph, isNotFound } from "./graph.js";

const LIFETIME_MS = 70 * 60 * 60_000;
const RENEW_BEFORE_MS = 24 * 60 * 60_000;

type Subscription = { id: string; notificationUrl: string; expiration: number };

const subscriptionKey = (accountId: string) => `outlookSubscription:${accountId}`;

function readSubscription(accountId: string): Subscription | null {
  try {
    return JSON.parse(mailStore.getKv(subscriptionKey(accountId)) || "null") as Subscription | null;
  } catch {
    return null;
  }
}

/** Starts or renews the mailbox's subscription when due; answers whether changes are pushed. */
export async function renewSubscription(accountId: string): Promise<boolean> {
  const current = readSubscription(accountId);
  if (current && current.expiration - Date.now() > RENEW_BEFORE_MS) return true;
  try {
    const target = await relayRequest<OutlookWatchResponse>("POST", "/v1/outlook/watch", {
      email: accountId,
    });
    const expiration = Date.now() + LIFETIME_MS;
    const expirationDateTime = new Date(expiration).toISOString();
    let id: string | null = null;
    if (current?.notificationUrl === target.notificationUrl) {
      try {
        await graph(accountId, `/subscriptions/${encodeURIComponent(current.id)}`, {
          method: "PATCH",
          body: { expirationDateTime },
        });
        id = current.id;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    }
    // Graph checks the relay answers before it subscribes (the validation handshake).
    id ??= (
      await graph<{ id: string }>(accountId, "/subscriptions", {
        method: "POST",
        body: {
          changeType: "created,updated,deleted",
          notificationUrl: target.notificationUrl,
          resource: "me/messages",
          expirationDateTime,
          clientState: target.clientState,
        },
      })
    ).id;
    mailStore.setKv(
      subscriptionKey(accountId),
      JSON.stringify({
        id,
        notificationUrl: target.notificationUrl,
        expiration,
      } satisfies Subscription),
    );
    logger.info("outlook-watch", "Watching", { accountId, until: expirationDateTime });
    return true;
  } catch (err) {
    logger.info("outlook-watch", `Couldn't watch ${accountId}: ${String(err)}`);
    return false;
  }
}

/** Ends this device's subscription (a removed mailbox); best effort. */
export async function endSubscription(accountId: string): Promise<void> {
  const current = readSubscription(accountId);
  mailStore.setKv(subscriptionKey(accountId), "");
  if (!current) return;
  await graph(accountId, `/subscriptions/${encodeURIComponent(current.id)}`, {
    method: "DELETE",
  }).catch(() => {});
}
