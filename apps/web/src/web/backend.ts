/**
 * The connection to the mail backend, from any number of tabs. The backend
 * (core, in a Web Worker) runs once: in whichever tab holds the
 * "otter-mail:backend" Web Lock (its cache is SQLite on OPFS, which one tab
 * at a time can open). The other tabs reach it over a BroadcastChannel. When
 * the hosting tab closes, the lock passes to another tab, which starts the
 * backend on the same cache and says so; waiting tabs then carry on.
 *
 * What needs a page (a file picker, the Gmail sign-in popup, a download)
 * happens in the tab whose invoke asked for it; notifications show once,
 * from the hosting tab; the unread badge shows in every tab.
 */

import type { FromWorker, PageEffect, PageRequests, ToWorker } from "./protocol";

export type PageHandlers = {
  onEvent(channel: string, params: unknown): void;
  onRequest<K extends keyof PageRequests>(
    kind: K,
    params: PageRequests[K]["params"],
  ): Promise<PageRequests[K]["result"]>;
  onEffect(effect: PageEffect): void;
  onFailed(error: string): void;
};

/** The invoke a page request or effect belongs to: it goes to the tab that made it. */
const ORIGIN_CHANNELS: Record<keyof PageRequests | "download" | "open", string[]> = {
  todoistSignIn: ["todoist:signIn"],
  pickFiles: ["gmail:pickAttachments"],
  googleSignIn: ["gmail:addAccount"],
  outlookSignIn: ["gmail:addOutlookAccount"],
  download: ["gmail:getAttachment"],
  open: ["gmail:openAttachment", "gmail:openComposeAttachment"],
  detectLanguage: ["translation:detect"],
  translate: ["translation:translate"],
};

type TabMessage =
  | { type: "invoke"; tab: string; id: number; channel: string; params: unknown }
  | { type: "result"; tab: string; id: number; result?: unknown; error?: string }
  | { type: "event"; channel: string; params: unknown }
  | { type: "request"; tab: string; id: number; kind: keyof PageRequests; params: unknown }
  | { type: "reply"; id: number; result?: unknown; error?: string }
  | { type: "effect"; tab: string; effect: PageEffect }
  | { type: "failed"; error: string }
  | { type: "resume" }
  /** From the hosting tab: the backend is up there; send what's waiting. */
  | { type: "host"; host: string }
  /** From a new tab: who hosts the backend? */
  | { type: "hello" };

const ALL_TABS = "*";
/** The demos run their own backend, apart from real mail on the same origin. */
const NAME = __DEMO__ ? "otter-mail-demo" : __DEV_DEMO__ ? "otter-mail-dev-demo" : "otter-mail";

export function connectBackend(page: PageHandlers) {
  const tab = crypto.randomUUID();
  const channel = new BroadcastChannel(NAME);
  const toTabs = (message: TabMessage) =>
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel has none
    channel.postMessage(message);
  let hosting: ((message: TabMessage) => void) | null = null;
  /** The tab hosting the backend, once one has said so. */
  let host: string | null = null;

  // Invokes waiting for their result. `sent` ones went to a host that may
  // since have gone away; unsent ones wait for a host.
  let nextId = 1;
  const pending = new Map<
    number,
    {
      channel: string;
      params: unknown;
      sent: boolean;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  /** A message for this tab's side of things (from the host, or from itself when hosting). */
  function receive(message: TabMessage): void {
    switch (message.type) {
      case "result": {
        if (message.tab !== tab) return;
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined) call?.reject(new Error(message.error));
        else call?.resolve(message.result);
        break;
      }
      case "event":
        page.onEvent(message.channel, message.params);
        break;
      case "request":
        if (message.tab !== tab) return;
        void page.onRequest(message.kind, message.params as never).then(
          (result) => send({ type: "reply", id: message.id, result }),
          (err: unknown) =>
            send({
              type: "reply",
              id: message.id,
              error: err instanceof Error ? err.message : String(err),
            }),
        );
        break;
      case "effect":
        if (message.tab === tab || message.tab === ALL_TABS) page.onEffect(message.effect);
        break;
      case "failed":
        page.onFailed(message.error);
        break;
      case "host":
        if (message.host === host) return;
        host = message.host;
        for (const [id, call] of pending) {
          if (call.sent) {
            // The previous host went away mid-call: don't risk doing it twice.
            pending.delete(id);
            call.reject(new Error("Otter Mail reconnected in another tab. Try again."));
          } else {
            call.sent = true;
            send({ type: "invoke", tab, id, channel: call.channel, params: call.params });
          }
        }
        break;
    }
  }

  /** To the host: straight in when this tab is it, else over the channel. */
  function send(message: TabMessage): void {
    if (hosting) hosting(message);
    else toTabs(message);
  }

  channel.addEventListener("message", (event: MessageEvent<TabMessage>) => {
    if (hosting) hosting(event.data);
    else receive(event.data);
  });

  /** Runs the backend here, for every tab, until this tab closes. */
  function startHosting(): void {
    // Calls made while the backend starts wait for it; earlier ones went elsewhere.
    host = null;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const post = (message: ToWorker) => worker.postMessage(message, []);
    const invokes = new Map<number, { tab: string; id: number }>();
    const lastOrigin = new Map<string, string>();
    let nextWorkerId = 1;

    /** Delivers to its tab: this one, another one, or all of them. */
    function deliver(message: TabMessage & { tab?: string }): void {
      if (message.tab === undefined || message.tab === tab || message.tab === ALL_TABS) {
        receive(message);
      }
      if (message.tab !== tab) toTabs(message);
    }

    const originOf = (kind: keyof typeof ORIGIN_CHANNELS) =>
      ORIGIN_CHANNELS[kind].map((c) => lastOrigin.get(c)).find(Boolean) ?? tab;

    hosting = (message) => {
      if (message.type === "invoke") {
        const workerId = nextWorkerId++;
        invokes.set(workerId, { tab: message.tab, id: message.id });
        lastOrigin.set(message.channel, message.tab);
        post({ type: "invoke", id: workerId, channel: message.channel, params: message.params });
      } else if (message.type === "reply") {
        post({ type: "reply", id: message.id, result: message.result, error: message.error });
      } else if (message.type === "resume") {
        post({ type: "resume" });
      } else if (message.type === "hello" && host === tab) {
        toTabs({ type: "host", host: tab });
      }
    };

    worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      switch (message.type) {
        case "ready":
          toTabs({ type: "host", host: tab });
          receive({ type: "host", host: tab });
          break;
        case "failed":
          deliver({ type: "failed", error: message.error, tab: ALL_TABS });
          break;
        case "result": {
          const origin = invokes.get(message.id);
          invokes.delete(message.id);
          if (origin)
            deliver({ type: "result", ...origin, result: message.result, error: message.error });
          break;
        }
        case "event":
          deliver({
            type: "event",
            channel: message.channel,
            params: message.params,
            tab: ALL_TABS,
          });
          break;
        case "request":
          deliver({
            type: "request",
            tab: originOf(message.kind),
            id: message.id,
            kind: message.kind,
            params: message.params,
          });
          break;
        case "effect": {
          const { type: _type, ...effect } = message;
          const target =
            effect.kind === "badge"
              ? ALL_TABS
              : effect.kind === "notify"
                ? tab
                : originOf(effect.kind);
          deliver({ type: "effect", tab: target, effect });
          break;
        }
      }
    });
  }

  // The lock is held until this tab closes; the next waiting tab then hosts.
  const resetDemo = __DEMO__ && new URLSearchParams(location.search).has("reset-demo");
  if (resetDemo) history.replaceState(null, "", location.pathname + location.hash);
  void navigator.locks.request(`${NAME}:backend`, async () => {
    // Holding the lock, no tab has the demo's cache open: start it over.
    if (resetDemo) {
      const root = await navigator.storage.getDirectory();
      for (const name of [".otter-mail-demo", "demo-files"]) {
        await root.removeEntry(name, { recursive: true }).catch(() => {});
      }
    }
    startHosting();
    return new Promise<never>(() => {});
  });
  toTabs({ type: "hello" });

  return {
    invoke<T>(invokedChannel: string, params?: unknown): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          channel: invokedChannel,
          params,
          sent: host !== null,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        if (host !== null) send({ type: "invoke", tab, id, channel: invokedChannel, params });
      });
    },
    resume(): void {
      send({ type: "resume" });
    },
  };
}
