import { prepareTodoistPopup, closeTodoistPopup, authorizeTodoistPopup } from "./todoist-auth";
/**
 * `window.desktopBridge` in a browser: the same API the desktop's preload
 * gives the renderer, backed by the mail backend (backend.ts: a Web Worker
 * shared by every open tab). The renderer can't tell the difference, except
 * through `features`, which switch off what only the Mac app has.
 *
 * A few things belong to the page itself: window-level channels (settings
 * navigation, ⌘W), and whatever needs the user's click to be allowed (file
 * pickers, Google's and Microsoft's sign-in popups). Those start right when the renderer
 * invokes the channel, and the backend's request picks up what they return.
 */

import type { OutlookSignInResult } from "@otter-mail/contracts/relay";
import type {
  DesktopBridge,
  NativeThemeInfo,
  ThemeSource,
  UpdateState,
} from "@otter-mail/contracts";

import { connectBackend } from "./backend";
import { DEFAULT_APP_ICON, isAppIcon } from "@otter-mail/shared/app-icons";
import { detectLanguage, hasBuiltInTranslator, translate } from "./translator";
import {
  SIGN_IN_CANCELLED,
  type GoogleSignInResult,
  type PageEffect,
  type PageRequests,
} from "./protocol";

const RELAY_URL = import.meta.env.VITE_RELAY_URL || "https://relay.mail.otterware.app";
const THEME_SOURCE_KEY = "otter:theme-source";
const TITLE = __DEMO__ ? "Otter Mail (demo)" : "Otter Mail";
const APP_ICON_KEY = "otter:app-icon";
if (__DEMO__) document.title = TITLE;

type Listener = (params: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
function emit(channel: string, params?: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener(params);
}

function appIcon(): string {
  const stored = localStorage.getItem(APP_ICON_KEY);
  return isAppIcon(stored) ? stored : DEFAULT_APP_ICON;
}

window.addEventListener("storage", (event) => {
  if (event.key === APP_ICON_KEY || event.key === null) emit("appIcon:changed", appIcon());
});

// ── Things that need the user's click ──────────────────────────────────────

/** Actions started when the renderer invoked their channel, for the worker's request to collect. */
const started: { [K in keyof PageRequests]?: Promise<PageRequests[K]["result"]> } = {};

function pickFiles(): Promise<PageRequests["pickFiles"]["result"]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("cancel", () => resolve([]));
    input.addEventListener("change", async () => {
      const files = [...(input.files ?? [])];
      resolve(
        await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        ),
      );
    });
    input.click();
  });
}

let signInPopup: Window | null = null;

/** The relay's mailbox sign-ins: Gmail's (`/v1/gmail/…`) and Outlook's (`/v1/outlook/…`). */
type SignInResults = { gmail: GoogleSignInResult; outlook: OutlookSignInResult };
type SignInProvider = keyof SignInResults;
const PROVIDER_NAMES: Record<SignInProvider, string> = { gmail: "Google", outlook: "Microsoft" };

type SignInMessage = { result?: SignInResults[SignInProvider]; error?: string };

/**
 * A sign-in finished in this tab: when the browser blocks the popup, the
 * consent page opens here instead, and the relay sends the answer back in the
 * URL (`#gmail-sign-in=…`, `#outlook-sign-in=…`).
 */
let returnedSignIn: (SignInMessage & { provider: SignInProvider }) | null = (() => {
  const match = /^#(gmail|outlook)-sign-in=(.+)$/.exec(location.hash);
  if (!match) return null;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const message = JSON.parse(decodeURIComponent(match[2]!)) as SignInMessage;
    return { ...message, provider: match[1] as SignInProvider };
  } catch {
    return null;
  }
})();

/** The relay's sign-in popup for a mailbox; resolves with what it posts back. */
function signIn<P extends SignInProvider>(
  provider: P,
  loginHint?: string,
): Promise<SignInResults[P]> {
  const failed = `${PROVIDER_NAMES[provider]} sign-in failed.`;
  const returned = returnedSignIn?.provider === provider ? returnedSignIn : null;
  if (returned) returnedSignIn = null;
  if (returned?.result) return Promise.resolve(returned.result as SignInResults[P]);
  if (returned) return Promise.reject(new Error(returned.error ?? failed));

  const url = new URL(`${RELAY_URL}/v1/${provider}/authorize`);
  if (loginHint) url.searchParams.set("login_hint", loginHint);
  signInPopup?.close();
  const popup = window.open(url, `otter-${provider}-sign-in`, "popup,width=520,height=680");
  if (!popup) {
    // Popup blocked: sign in in this tab; the answer comes back when it reloads.
    location.assign(url);
    return new Promise(() => {});
  }
  signInPopup = popup;
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedCheck);
      if (signInPopup === popup) signInPopup = null;
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; result?: SignInResults[P]; error?: string };
      if (
        event.origin !== new URL(RELAY_URL).origin ||
        data?.type !== `otter:${provider}-sign-in`
      ) {
        return;
      }
      done();
      if (data.result) resolve(data.result);
      else reject(new Error(data.error ?? failed));
    };
    const closedCheck = setInterval(() => {
      if (!popup || popup.closed) {
        done();
        reject(new Error(SIGN_IN_CANCELLED));
      }
    }, 500);
    window.addEventListener("message", onMessage);
  });
}

// ── Effects ────────────────────────────────────────────────────────────────

function saveBytes(name: string, bytes: Uint8Array, open: boolean): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  if (open) {
    window.open(url, "_blank", "noopener");
  } else {
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    link.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The message a clicked notification opens. */
let pendingOpenMessage: { accountId: string; messageId: string } | null = null;

function applyEffect(effect: PageEffect): void {
  switch (effect.kind) {
    case "notify":
      if ("Notification" in window && Notification.permission === "granted") {
        const notification = new Notification(effect.title, {
          body: [effect.subtitle, effect.body].filter(Boolean).join(" · "),
        });
        notification.addEventListener("click", () => {
          window.focus();
          notification.close();
          if (!effect.open) return;
          pendingOpenMessage = effect.open;
          emit("mail:open");
        });
      }
      break;
    case "badge":
      document.title = effect.count > 0 ? `(${effect.count}) ${TITLE}` : TITLE;
      void navigator.setAppBadge?.(effect.count).catch(() => {});
      break;
    case "download":
    case "open":
      saveBytes(effect.name, effect.bytes, effect.kind === "open");
      break;
  }
}

// ── The backend ────────────────────────────────────────────────────────────

const backend = connectBackend({
  onEvent: emit,
  async onRequest(kind, params) {
    if (kind === "todoistSignIn") {
      const p = params as PageRequests["todoistSignIn"]["params"];
      if (p.close) {
        closeTodoistPopup();
        return "" as never;
      }
      return authorizeTodoistPopup(p.url!) as never;
    }
    if (kind === "detectLanguage") {
      return detectLanguage((params as PageRequests["detectLanguage"]["params"]).text) as never;
    }
    if (kind === "translate") {
      const { texts, source, target } = params as PageRequests["translate"]["params"];
      return translate(texts, source, target) as never;
    }
    const loginHint = (params as { loginHint?: string } | undefined)?.loginHint;
    const action =
      started[kind] ??
      (kind === "pickFiles"
        ? pickFiles()
        : signIn(kind === "outlookSignIn" ? "outlook" : "gmail", loginHint));
    delete started[kind];
    return action as never;
  },
  onEffect: applyEffect,
  onFailed: (error) => console.error("The mail backend failed to start:", error),
});

// ── Channels the page answers itself ───────────────────────────────────────

let settingsTarget: unknown = null;

const pageChannels: Record<string, (params: unknown) => unknown> = {
  "appIcon:get": appIcon,
  "appIcon:set": (id) => {
    if (!isAppIcon(id)) throw new Error("Unknown app icon.");
    localStorage.setItem(APP_ICON_KEY, id);
    emit("appIcon:changed", id);
    return id;
  },
  "window:openSettings": (params) => {
    settingsTarget = params;
    emit("settings:open");
  },
  "window:getSettingsTarget": () => {
    const target = settingsTarget;
    settingsTarget = null;
    return target;
  },
  "window:takePendingOpenMessage": () => {
    const target = pendingOpenMessage;
    pendingOpenMessage = null;
    return target;
  },
  "window:closeMain": () => {},
  "app:takePendingMailto": () => null,
  "edit:nativeUndo": () => document.execCommand("undo"),
  "edit:nativeRedo": () => document.execCommand("redo"),
};

async function invoke<T>(channel: string, params?: unknown): Promise<T> {
  const local = pageChannels[channel];
  if (local) return (await local(params)) as T;

  // Start what needs the click now, while it counts as the user's.
  if (channel === "todoist:signIn") prepareTodoistPopup();
  if (channel === "gmail:pickAttachments") started.pickFiles = pickFiles();
  if (channel === "gmail:addAccount" && !__DEMO__) {
    started.googleSignIn = signIn("gmail", (params as { email?: string } | undefined)?.email);
  }
  if (channel === "gmail:addOutlookAccount" && !__DEMO__) {
    started.outlookSignIn = signIn("outlook", (params as { email?: string } | undefined)?.email);
  }
  if (channel === "gmail:cancelAddAccount") signInPopup?.close();

  if (channel === "otter:signIn") {
    const result = await backend.invoke<{ redirectTo?: string } | null>(channel, {
      ...(params as object),
      // Back to the page it was opened at: a link to a message, say.
      callbackURL: location.href,
    });
    if (result?.redirectTo) location.assign(result.redirectTo);
    return result as T;
  }
  if (channel === "otter:signOut" && !__DEMO__) {
    const form = document.createElement("form");
    form.method = "post";
    form.action = `${RELAY_URL}/v1/auth/browser-sign-out/start`;
    document.body.appendChild(form);
    form.submit();
    return undefined as T;
  }
  let result: T;
  try {
    result = await backend.invoke<T>(channel, params);
  } catch (error) {
    if (channel === "todoist:signIn") closeTodoistPopup();
    throw error;
  }
  // Signed out (or the account deleted): back to the start, which signs in again.
  if (channel === "otter:signOut" || channel === "otter:deleteAccount") location.assign("/");
  return result;
}

// ── Theme (a browser can't change prefers-color-scheme; store the choice) ──

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function themeSource(): ThemeSource {
  const stored = localStorage.getItem(THEME_SOURCE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function themeInfo(): NativeThemeInfo {
  const source = themeSource();
  return {
    shouldUseDarkColors: source === "system" ? darkQuery.matches : source === "dark",
    themeSource: source,
    shouldUseHighContrastColors: window.matchMedia("(prefers-contrast: more)").matches,
    prefersReducedTransparency: window.matchMedia("(prefers-reduced-transparency: reduce)").matches,
  };
}

const updatesDisabled: UpdateState = {
  status: "disabled",
  currentVersion: __APP_VERSION__,
  availableVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: "The web app is always up to date.",
  manualDownloadUrl: null,
};

export const webBridge: DesktopBridge = {
  platform: "web",
  features: {
    windowControls: null,
    vibrancy: false,
    historyButtons: false,
    launchAtLogin: false,
    dockBadge: false,
    defaultMailApp: false,
    translation: hasBuiltInTranslator,
    dragOut: false,
    openFiles: false,
    externalAgent: false,
    localAgents: false,
    browser: false,
  },
  invoke,
  on(channel, listener) {
    let set = listeners.get(channel);
    if (!set) listeners.set(channel, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  },
  openExternal: async (url) => void window.open(url, "_blank", "noopener"),
  nativeTheme: {
    getInfo: async () => themeInfo(),
    async setThemeSource(source) {
      if (source === "system") localStorage.removeItem(THEME_SOURCE_KEY);
      else localStorage.setItem(THEME_SOURCE_KEY, source);
      window.dispatchEvent(new Event("otter:theme-change"));
    },
  },
  updates: {
    getState: async () => updatesDisabled,
    check: async () => updatesDisabled,
    download: async () => updatesDisabled,
    install: async () => {},
    onState: () => () => {},
  },
};

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") backend.resume();
});

// ⌘Z / ⇧⌘Z: the Mac app's Edit › Undo and Redo send edit:undo and edit:redo
// (mail actions). Text fields keep the browser's own undo.
window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey)) return;
  if (event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]")) return;
  event.preventDefault();
  emit(event.shiftKey ? "edit:redo" : "edit:undo");
});

// Notifications need permission, which browsers only ask for after a click.
if ("Notification" in window && Notification.permission === "default") {
  window.addEventListener("pointerdown", () => void Notification.requestPermission(), {
    once: true,
  });
}

/**
 * The web app needs an Otter account (it holds the Gmail sign-ins): sign in
 * first. The demo's mailboxes need none.
 */
export async function requireOtterAccount(): Promise<void> {
  if (__DEMO__) return;
  const state = await invoke<{ user: unknown }>("otter:getState");
  if (!state.user) await invoke("otter:signIn");
  // Back from signing in to Gmail or Outlook in this tab: finish adding the mailbox.
  if (returnedSignIn?.result) {
    const channel =
      returnedSignIn.provider === "outlook" ? "gmail:addOutlookAccount" : "gmail:addAccount";
    void invoke(channel, { email: returnedSignIn.result.email });
  }
  webBridge.on("otter:state", (next) => {
    if (!(next as { user: unknown }).user) location.assign("/");
  });
}
