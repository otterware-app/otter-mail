import type { DesktopBridge } from "@otter-mail/contracts";

declare global {
  /** The app's version (apps/web/package.json, bumped with each release). */
  const __APP_VERSION__: string;
  /** Demo mode (VITE_DEMO=1): a made-up mailbox, no Google or Otter account (src/web/demo). */
  const __DEMO__: boolean;

  interface Window {
    /** Exposed by the Electron preload script (apps/desktop), or src/web/bridge.ts in a browser. */
    desktopBridge: DesktopBridge;
  }
}
