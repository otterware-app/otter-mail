/**
 * What the desktop app can do on each operating system, as the renderer sees
 * it (`desktopBridge.features`). Plain data: the sandboxed preload imports it.
 */

import type { BridgeFeatures } from "@otter-mail/contracts";

const everywhere = {
  historyButtons: true,
  launchAtLogin: true,
  defaultMailApp: true,
  dragOut: true,
  openFiles: true,
  externalAgent: true,
  localAgents: true,
  browser: true,
} satisfies Partial<BridgeFeatures>;

const mac: BridgeFeatures = {
  ...everywhere,
  windowControls: "left",
  dockBadge: true,
  // Apple's Translation, through native/translator.
  translation: true,
};

const linux: BridgeFeatures = {
  ...everywhere,
  windowControls: "right",
  dockBadge: false,
  translation: false,
};

export function featuresFor(platform: NodeJS.Platform): BridgeFeatures {
  return platform === "darwin" ? mac : linux;
}
