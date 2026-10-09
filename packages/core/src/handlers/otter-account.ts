/**
 * The Otter account: sign-in handlers, and the glue that runs while signed
 * in. On connecting to the relay (and hourly after), the linked accounts are
 * reconciled and Gmail watches renewed; Gmail's pushes then trigger syncs.
 */

import { OTTER_ACCOUNT_STATE_CHANNEL, type OtterAccountState } from "@otter-mail/contracts";
import type { AgentTokens } from "@otter-mail/contracts/agent-tokens";
import type {
  CreateAgentTokenResponse,
  ListAgentTokensResponse,
  MeResponse,
  RelayEvent,
} from "@otter-mail/contracts/relay";

import { SignInCancelledError } from "../google.js";
import { broadcast, handle } from "../ipc.js";
import { logger } from "../logger.js";
import { platform } from "../platform.js";
import { listAccounts } from "../services/account-store.js";
import { getAccount } from "../services/account-store.js";
import { getImapPassword } from "../services/imap-passwords.js";
import type { NotificationConnection } from "@otter-mail/contracts/relay";
import { findProvider, isSignedIn } from "../providers/index.js";
import {
  clearLinkedSnapshot,
  linkedAccountIds,
  reconcileAccounts,
} from "../services/linked-accounts.js";
import { setPushedAccounts, syncAccount, syncAllAccounts } from "../services/mail-sync.js";
import {
  deleteOtterAccount,
  getOtterUser,
  listDevices,
  onOtterAccountChange,
  relayRequest,
  signIn,
  signInRedirect,
  signOut,
  signOutDevice,
} from "../services/otter-account.js";
import { forgetSyncedPreferences, pullPreferences } from "../services/preferences.js";
import { pullProjects } from "../services/projects.js";
import { getRealtimeState, startRealtime, stopRealtime } from "../services/realtime.js";
import { removeLocalAccount } from "./gmail.js";

const REFRESH_EVERY_MS = 60 * 60_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function otterState(): OtterAccountState {
  const user = getOtterUser();
  return {
    user: user && { email: user.email, name: user.name, picture: user.picture },
    realtime: getRealtimeState(),
  };
}

const publishState = () => broadcast(OTTER_ACCOUNT_STATE_CHANNEL, otterState());

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

/**
 * Reconciles the linked accounts, then makes sure Gmail pushes every linked,
 * signed-in account's changes; accounts it can't watch keep polling. Calls
 * made while one runs coalesce into a single rerun.
 */
function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      await refreshOnce();
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function refreshOnce(): Promise<void> {
  try {
    const { pushTopic, pushTopics } = await relayRequest<MeResponse>("GET", "/v1/me");
    await reconcileAccounts(removeLocalAccount);
    const linked = linkedAccountIds();
    const pushed: string[] = [];
    for (const account of await listAccounts()) {
      const watch = findProvider(account)?.watchViaRelay;
      if (!watch || !linked.has(account.email.toLowerCase()) || !isSignedIn(account)) continue;
      try {
        const clientId =
          pushTopics && account.provider !== "outlook"
            ? await platform().google.getClientId?.(account.id)
            : undefined;
        const topic = (clientId && pushTopics?.[clientId.split("-")[0]!]) || pushTopic;
        if (await watch(account.id, topic)) pushed.push(account.id);
      } catch (err) {
        logger.info("otter-account", `Couldn't watch ${account.id}: ${String(err)}`);
      }
    }
    setPushedAccounts(pushed);
  } catch (err) {
    logger.info("otter-account", `Refresh failed: ${String(err)}`);
  }
}

async function syncPreferences(): Promise<void> {
  await pullPreferences().catch((err: unknown) =>
    logger.info("otter-account", `Preferences sync failed: ${String(err)}`),
  );
}

async function syncProjects(): Promise<void> {
  await pullProjects().catch((err: unknown) =>
    logger.info("otter-account", `Projects sync failed: ${String(err)}`),
  );
}

async function onEvent(event: RelayEvent): Promise<void> {
  if (event.type === "projects") {
    await syncProjects();
    return;
  }
  if (event.type === "accounts") {
    await refresh();
    return;
  }
  if (event.type === "preferences") {
    await syncPreferences();
    return;
  }
  const account = (await listAccounts()).find(
    (a) => a.email.toLowerCase() === event.email.toLowerCase(),
  );
  if (!account) return;
  logger.info("otter-account", "Gmail pushed a change", { accountId: account.id });
  syncAccount(account.id, { force: true, trigger: "push" });
}

function start(): void {
  startRealtime({
    onConnected: () => {
      void refresh();
      void syncPreferences();
      void syncProjects();
      // Catch up on whatever changed while disconnected.
      void syncAllAccounts({ force: true, trigger: "push" });
    },
    onEvent: (event) => void onEvent(event),
    onStateChange: (state) => {
      if (state !== "live") setPushedAccounts([]);
      publishState();
    },
    // If the session was ended elsewhere, this 401s and signs this device out.
    onRefused: () => void relayRequest("GET", "/v1/me").catch(() => {}),
  });
  refreshTimer ??= setInterval(() => {
    if (getRealtimeState() === "live") void refresh();
  }, REFRESH_EVERY_MS);
}

function stop(): void {
  stopRealtime();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  setPushedAccounts([]);
  clearLinkedSnapshot();
  void forgetSyncedPreferences();
}

export function registerOtterAccountHandlers(): void {
  onOtterAccountChange(() => {
    if (getOtterUser()) start();
    else stop();
    publishState();
  });

  handle("otter:getState", async () => otterState());

  handle("otter:notificationConnections", async () => {
    if (!getOtterUser())
      return { connections: [], providers: { gmail: false, outlook: false, imap: false } };
    return relayRequest<{
      connections: NotificationConnection[];
      providers: Record<string, boolean>;
    }>("GET", "/v1/notification-connections");
  });
  handle("otter:connectNotifications", async (params: unknown) => {
    const { accountId } = params as { accountId: string };
    const account = await getAccount(accountId);
    if (!account || !getOtterUser()) throw new Error("Sign in to your Otter account first.");
    if (!isSignedIn(account)) throw new Error("Sign in to this mailbox first.");
    if (account.provider === "imap") {
      const password = getImapPassword(accountId);
      if (!password || !account.imap) throw new Error("Reconnect this IMAP mailbox first.");
      await relayRequest("PUT", "/v1/notification-connections/imap", {
        email: account.email,
        password,
        settings: account.imap,
      });
      return { connected: true };
    }
    return relayRequest<{ url: string }>("POST", "/v1/notification-connections/authorize", {
      email: account.email,
      returnTo: platform().kind === "web" ? "web" : "desktop",
    });
  });
  handle("otter:disconnectNotifications", async (params: unknown) => {
    const { accountId } = params as { accountId: string };
    const account = await getAccount(accountId);
    if (!account) return;
    await relayRequest(
      "DELETE",
      "/v1/notification-connections/" + encodeURIComponent(account.email),
    );
  });

  // otter:signIn — "Sign in with Google", for the Otter account only (never
  // a mailbox). The desktop opens Google in the browser; the web app answers
  // `{ redirectTo }` for the page to go sign in (back to `callbackURL`). The
  // renderer gets null when the user cancels.
  handle("otter:signIn", async (params: unknown) => {
    const p = params as { callbackURL?: unknown } | undefined;
    const google = platform().google;
    try {
      if (google.signInForIdToken) {
        await signIn(await google.signInForIdToken());
      } else {
        const callbackURL = typeof p?.callbackURL === "string" ? p.callbackURL : "";
        return { redirectTo: await signInRedirect(callbackURL) };
      }
      return otterState();
    } catch (err) {
      if (err instanceof SignInCancelledError) return null;
      throw err;
    }
  });

  handle("otter:cancelSignIn", async () => {
    platform().google.cancelSignIn();
  });

  handle("otter:signOut", async () => {
    await signOut();
    return otterState();
  });

  handle("otter:listDevices", async () => listDevices());

  handle("otter:signOutDevice", async (params: unknown) => {
    const token = (params as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string") throw new Error('Invalid parameter: "token".');
    await signOutDevice(token);
  });

  // Agent tokens: agents elsewhere (Hermes) reach the account's projects at the relay's /mcp.
  handle("otter:listAgentTokens", async (): Promise<AgentTokens> => ({
    url: `${platform().relayUrl}/mcp`,
    tokens: (await relayRequest<ListAgentTokensResponse>("GET", "/v1/agent-tokens")).tokens,
  }));

  // Answers the token, this once.
  handle("otter:createAgentToken", async (params: unknown) => {
    const name = (params as { name?: unknown } | undefined)?.name;
    if (typeof name !== "string" || !name.trim()) throw new Error('Invalid parameter: "name".');
    const created = await relayRequest<CreateAgentTokenResponse>("POST", "/v1/agent-tokens", {
      name: name.trim(),
    });
    return created.token;
  });

  handle("otter:deleteAgentToken", async (params: unknown) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") throw new Error('Invalid parameter: "id".');
    await relayRequest("DELETE", `/v1/agent-tokens/${encodeURIComponent(id)}`);
  });

  // Deletes the Otter account on the relay; this device's Gmail accounts and mail stay.
  handle("otter:deleteAccount", async () => {
    await deleteOtterAccount();
    return otterState();
  });

  if (getOtterUser()) start();
}
