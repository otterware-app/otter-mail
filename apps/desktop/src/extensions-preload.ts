/**
 * Preload for the browser session's extensions (services/extensions.ts):
 * their service workers and their own pages (popups, options). It gives
 * them what Chrome has and Electron doesn't: `chrome.action` (the toolbar
 * button), the rest of `chrome.tabs`, `chrome.windows`, and
 * `chrome.runtime.openOptionsPage`, each answered by the main process. Web
 * pages in the session get nothing from it.
 */

import { contextBridge, ipcRenderer } from "electron";

/** The extension's id from its address: a page's, or (no `location` in a worker's preload) its worker's. */
function ownExtensionId(): string | null {
  const own = (where: { protocol: string; host: string }) =>
    where.protocol === "chrome-extension:" ? where.host : null;
  if (typeof location !== "undefined") return own(location);
  try {
    return contextBridge.executeInMainWorld({
      func: () => (self.location.protocol === "chrome-extension:" ? self.location.host : null),
    }) as string | null;
  } catch {
    return null;
  }
}

const extensionId = ownExtensionId();

if (extensionId) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  ipcRenderer.on("crx:event", (_event, name: string, args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args);
  });

  const bridge = {
    call: (name: string, args: unknown[]) =>
      ipcRenderer.invoke("crx:call", extensionId, name, args),
    listen: (name: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener);
      void ipcRenderer.invoke("crx:listen", extensionId, name);
    },
  };

  // Runs in the extension's own world: everything it needs is inside it.
  const install = (bridge: {
    call: (name: string, args: unknown[]) => Promise<unknown>;
    listen: (name: string, listener: (...args: unknown[]) => void) => void;
  }) => {
    type Namespace = Record<string, Record<string, unknown>>;
    // Chromium has `browser` beside `chrome` (the cross-browser name), its own
    // object: extensions read either, so both get the same APIs.
    const { chrome, browser } = globalThis as { chrome?: Namespace; browser?: Namespace };
    const roots = [...new Set([chrome, browser])].filter((root): root is Namespace => !!root);
    if (roots.length === 0) return;

    // Electron's own API objects may not take plain assignment.
    const put = (target: Record<string, unknown>, values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) {
        try {
          target[key] = value;
        } catch {
          // falls through to defineProperty
        }
        if (target[key] === value) continue;
        try {
          Object.defineProperty(target, key, {
            value,
            writable: true,
            configurable: true,
            enumerable: true,
          });
        } catch (error) {
          console.error(`Couldn't add chrome API ${key}:`, error);
        }
      }
    };

    // Chrome's two styles: a trailing callback, or a promise.
    const method =
      (name: string, prepare?: (args: unknown[]) => unknown[]) =>
      (...args: unknown[]) => {
        const callback =
          typeof args[args.length - 1] === "function"
            ? (args.pop() as (value?: unknown) => void)
            : null;
        const result = bridge.call(name, prepare ? prepare(args) : args);
        if (!callback) return result;
        result.then(
          (value) => callback(value),
          (error: unknown) => {
            console.error(`chrome.${name}:`, error);
            callback();
          },
        );
        return undefined;
      };

    const event = (name: string) => {
      const listeners = new Set<(...args: unknown[]) => void>();
      let listening = false;
      return {
        addListener(listener: (...args: unknown[]) => void) {
          listeners.add(listener);
          if (listening) return;
          listening = true;
          bridge.listen(name, (...args) => {
            for (const each of listeners) {
              try {
                each(...args);
              } catch (error) {
                console.error(error);
              }
            }
          });
        },
        removeListener: (listener: (...args: unknown[]) => void) => listeners.delete(listener),
        hasListener: (listener: (...args: unknown[]) => void) => listeners.has(listener),
        hasListeners: () => listeners.size > 0,
      };
    };

    // ImageData doesn't cross into the main process: its pixels do.
    const pixels = (details: Record<string, unknown>) => {
      const imageData = details.imageData;
      if (!imageData) return details;
      const sets =
        imageData instanceof ImageData
          ? { [imageData.width]: imageData }
          : (imageData as Record<string, ImageData>);
      return {
        ...details,
        imageData: Object.fromEntries(
          Object.entries(sets).map(([size, data]) => [
            size,
            { width: data.width, height: data.height, data: Array.from(data.data) },
          ]),
        ),
      };
    };

    const action = {
      setTitle: method("action.setTitle"),
      getTitle: method("action.getTitle"),
      setIcon: method("action.setIcon", ([details, ...rest]) => [
        pixels(details as Record<string, unknown>),
        ...rest,
      ]),
      setPopup: method("action.setPopup"),
      getPopup: method("action.getPopup"),
      setBadgeText: method("action.setBadgeText"),
      getBadgeText: method("action.getBadgeText"),
      setBadgeBackgroundColor: method("action.setBadgeBackgroundColor"),
      getBadgeBackgroundColor: method("action.getBadgeBackgroundColor"),
      setBadgeTextColor: method("action.setBadgeTextColor"),
      getBadgeTextColor: method("action.getBadgeTextColor"),
      enable: method("action.enable"),
      disable: method("action.disable"),
      isEnabled: method("action.isEnabled"),
      openPopup: method("action.openPopup"),
      getUserSettings: method("action.getUserSettings"),
      onClicked: event("action.onClicked"),
      onUserSettingsChanged: event("action.onUserSettingsChanged"),
    };
    const patch = (chrome: Namespace) => {
      put(chrome, { action });
      // Manifest V2's name for it, which some still read.
      if (!chrome.browserAction) put(chrome, { browserAction: action });

      // Electron's chrome.tabs keeps what it does well (messaging, scripting);
      // the tab strip's side is this app's.
      if (!chrome.tabs) put(chrome, { tabs: {} });
      put(chrome.tabs!, {
        TAB_ID_NONE: -1,
        get: method("tabs.get"),
        getCurrent: method("tabs.getCurrent"),
        query: method("tabs.query"),
        create: method("tabs.create"),
        update: method("tabs.update"),
        remove: method("tabs.remove"),
        goBack: method("tabs.goBack"),
        goForward: method("tabs.goForward"),
        captureVisibleTab: method("tabs.captureVisibleTab"),
        onCreated: event("tabs.onCreated"),
        onUpdated: event("tabs.onUpdated"),
        onActivated: event("tabs.onActivated"),
        onRemoved: event("tabs.onRemoved"),
        onHighlighted: event("tabs.onHighlighted"),
        onReplaced: event("tabs.onReplaced"),
        onMoved: event("tabs.onMoved"),
        onAttached: event("tabs.onAttached"),
        onDetached: event("tabs.onDetached"),
        onZoomChange: event("tabs.onZoomChange"),
      });

      put(chrome, {
        windows: {
          WINDOW_ID_NONE: -1,
          WINDOW_ID_CURRENT: -2,
          get: method("windows.get"),
          getCurrent: method("windows.getCurrent"),
          getLastFocused: method("windows.getLastFocused"),
          getAll: method("windows.getAll"),
          create: method("windows.create"),
          update: method("windows.update"),
          remove: method("windows.remove"),
          onCreated: event("windows.onCreated"),
          onRemoved: event("windows.onRemoved"),
          onFocusChanged: event("windows.onFocusChanged"),
          onBoundsChanged: event("windows.onBoundsChanged"),
        },
      });

      // Electron has none of these; extensions read them as they start.
      const random = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`;
      if (!chrome.contextMenus) {
        put(chrome, {
          contextMenus: {
            ContextType: {
              ALL: "all",
              PAGE: "page",
              FRAME: "frame",
              SELECTION: "selection",
              LINK: "link",
              EDITABLE: "editable",
              IMAGE: "image",
              VIDEO: "video",
              AUDIO: "audio",
              ACTION: "action",
            },
            ItemType: {
              NORMAL: "normal",
              CHECKBOX: "checkbox",
              RADIO: "radio",
              SEPARATOR: "separator",
            },
            ACTION_MENU_TOP_LEVEL_LIMIT: 6,
            // Returns its id at once, as Chrome's does.
            create: (properties: Record<string, unknown> = {}, callback?: () => void) => {
              const { onclick: _onclick, ...rest } = properties;
              const id = (rest.id as string | undefined) ?? random("menu");
              bridge.call("contextMenus.create", [{ ...rest, id }]).then(
                () => callback?.(),
                (error: unknown) => {
                  console.error(error);
                  callback?.();
                },
              );
              return id;
            },
            update: method("contextMenus.update"),
            remove: method("contextMenus.remove"),
            removeAll: method("contextMenus.removeAll"),
            onClicked: event("contextMenus.onClicked"),
          },
        });
      }
      if (!chrome.notifications) {
        put(chrome, {
          notifications: {
            TemplateType: { BASIC: "basic", IMAGE: "image", LIST: "list", PROGRESS: "progress" },
            PermissionLevel: { GRANTED: "granted", DENIED: "denied" },
            create: (...args: unknown[]) => {
              const callback =
                typeof args[args.length - 1] === "function"
                  ? (args.pop() as (id: string) => void)
                  : null;
              const [first, second] = args;
              const id = typeof first === "string" ? first : random("notification");
              const options = typeof first === "string" ? second : first;
              const result = bridge.call("notifications.create", [id, options]).then(() => id);
              if (!callback) return result;
              result.then(callback, () => callback(id));
              return undefined;
            },
            update: method("notifications.update"),
            clear: method("notifications.clear"),
            getAll: method("notifications.getAll"),
            getPermissionLevel: method("notifications.getPermissionLevel"),
            onClicked: event("notifications.onClicked"),
            onClosed: event("notifications.onClosed"),
            onButtonClicked: event("notifications.onButtonClicked"),
            onPermissionLevelChanged: event("notifications.onPermissionLevelChanged"),
            onShowSettings: event("notifications.onShowSettings"),
          },
        });
      }
      if (!chrome.downloads) {
        put(chrome, {
          downloads: {
            download: method("downloads.download"),
            search: method("downloads.search"),
            pause: method("downloads.pause"),
            resume: method("downloads.resume"),
            cancel: method("downloads.cancel"),
            erase: method("downloads.erase"),
            open: method("downloads.open"),
            show: method("downloads.show"),
            showDefaultFolder: method("downloads.showDefaultFolder"),
            onCreated: event("downloads.onCreated"),
            onChanged: event("downloads.onChanged"),
            onErased: event("downloads.onErased"),
            onDeterminingFilename: event("downloads.onDeterminingFilename"),
          },
        });
      }
      if (!chrome.privacy) {
        // Chrome's ChromeSetting objects, kept per extension in the main process.
        const setting = (name: string) => ({
          get: method("privacy.get", (args) => [name, ...args]),
          set: method("privacy.set", (args) => [name, ...args]),
          clear: method("privacy.clear", (args) => [name, ...args]),
          onChange: event(`privacy.onChange:${name}`),
        });
        const group = (prefix: string, names: string[]) =>
          Object.fromEntries(names.map((name) => [name, setting(`${prefix}.${name}`)]));
        put(chrome, {
          privacy: {
            services: group("services", [
              "alternateErrorPagesEnabled",
              "autofillAddressEnabled",
              "autofillCreditCardEnabled",
              "autofillEnabled",
              "passwordSavingEnabled",
              "safeBrowsingEnabled",
              "safeBrowsingExtendedReportingEnabled",
              "searchSuggestEnabled",
              "spellingServiceEnabled",
              "translationServiceEnabled",
            ]),
            network: group("network", ["networkPredictionEnabled", "webRTCIPHandlingPolicy"]),
            websites: group("websites", [
              "doNotTrackEnabled",
              "hyperlinkAuditingEnabled",
              "protectedContentEnabled",
              "referrersEnabled",
              "thirdPartyCookiesAllowed",
            ]),
          },
        });
      }
      if (!chrome.webNavigation) {
        put(chrome, {
          webNavigation: {
            getFrame: method("webNavigation.getFrame"),
            getAllFrames: method("webNavigation.getAllFrames"),
            onBeforeNavigate: event("webNavigation.onBeforeNavigate"),
            onCommitted: event("webNavigation.onCommitted"),
            onDOMContentLoaded: event("webNavigation.onDOMContentLoaded"),
            onCompleted: event("webNavigation.onCompleted"),
            onErrorOccurred: event("webNavigation.onErrorOccurred"),
            onCreatedNavigationTarget: event("webNavigation.onCreatedNavigationTarget"),
            onHistoryStateUpdated: event("webNavigation.onHistoryStateUpdated"),
            onReferenceFragmentUpdated: event("webNavigation.onReferenceFragmentUpdated"),
            onTabReplaced: event("webNavigation.onTabReplaced"),
          },
        });
      }

      if (!chrome.permissions) {
        put(chrome, {
          permissions: {
            contains: method("permissions.contains"),
            getAll: method("permissions.getAll"),
            request: method("permissions.request"),
            remove: method("permissions.remove"),
            addHostAccessRequest: method("permissions.addHostAccessRequest"),
            removeHostAccessRequest: method("permissions.removeHostAccessRequest"),
            onAdded: event("permissions.onAdded"),
            onRemoved: event("permissions.onRemoved"),
          },
        });
      }
      if (!chrome.commands) {
        put(chrome, {
          commands: {
            getAll: method("commands.getAll"),
            update: method("commands.update"),
            reset: method("commands.reset"),
            onCommand: event("commands.onCommand"),
          },
        });
      }
      if (chrome.extension && !chrome.extension.getViews) {
        put(chrome.extension, { getViews: () => [] });
      }
      if (chrome.management && !chrome.management.setEnabled) {
        put(chrome.management, { setEnabled: method("management.setEnabled") });
      }
      if (chrome.runtime && !chrome.runtime.openOptionsPage) {
        put(chrome.runtime, { openOptionsPage: method("runtime.openOptionsPage") });
      }
    };
    for (const root of roots) patch(root);
  };

  contextBridge.executeInMainWorld({ func: install, args: [bridge] });
}
