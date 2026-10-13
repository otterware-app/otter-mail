/**
 * Preload: the only bridge between renderer windows and the main process.
 * Exposes `window.desktopBridge` (see @otter-mail/contracts). Renderer code
 * never sees ipcRenderer itself.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  UPDATE_STATE_CHANNEL,
  type DesktopBridge,
  type NativeThemeInfo,
  type ThemeSource,
  type UpdateState,
} from "@otter-mail/contracts";

import { featuresFor } from "./os/features.js";

function subscribe(channel: string, listener: (params: unknown) => void): () => void {
  const handler = (_event: IpcRendererEvent, params: unknown) => listener(params);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  platform: process.platform,
  // What this OS's app can do; the renderer hides the rest.
  features: featuresFor(process.platform),
  invoke: <T>(channel: string, params?: unknown) =>
    ipcRenderer.invoke(channel, params) as Promise<T>,
  on: subscribe,
  openExternal: async (url: string) => {
    const opened = (await ipcRenderer.invoke("shell:openExternal", url)) as boolean;
    if (!opened) throw new Error("Failed to open URL");
  },
  nativeTheme: {
    getInfo: () => ipcRenderer.invoke("nativeTheme:getInfo") as Promise<NativeThemeInfo>,
    setThemeSource: (source: ThemeSource) =>
      ipcRenderer.invoke("nativeTheme:setThemeSource", source) as Promise<void>,
  },
  updates: {
    getState: () => ipcRenderer.invoke("updates:getState") as Promise<UpdateState>,
    check: () => ipcRenderer.invoke("updates:check") as Promise<UpdateState>,
    setChannel: (channel) =>
      ipcRenderer.invoke("updates:setChannel", channel) as Promise<UpdateState>,
    download: () => ipcRenderer.invoke("updates:download") as Promise<UpdateState>,
    install: () => ipcRenderer.invoke("updates:install") as Promise<void>,
    onState: (listener) =>
      subscribe(UPDATE_STATE_CHANNEL, (state) => listener(state as UpdateState)),
  },
};

contextBridge.exposeInMainWorld("desktopBridge", bridge);
