import "vite-plus/test/config";
import * as NodeFS from "node:fs";
import { defineConfig } from "vite-plus";

import pkg from "./package.json" with { type: "json" };

/**
 * Build-time config from the environment, falling back to the repo's
 * gitignored .env.local and .env (KEY=VALUE lines). Holds the Google OAuth
 * client, which must not be committed.
 */
function buildEnv(key: string): string {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  for (const file of ["../../.env.local", "../../.env"]) {
    const url = new URL(file, import.meta.url);
    if (!NodeFS.existsSync(url)) continue;
    for (const line of NodeFS.readFileSync(url, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match?.[1] === key) return match[2]!.replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return "";
}

// Everything but Electron itself is bundled into the main-process and preload
// files, so the packaged app ships without a node_modules folder.
const isExternal = (id: string) => id === "electron" || id.startsWith("electron/");

const shared = {
  format: "cjs",
  outDir: "dist-electron",
  dts: false,
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
  define: {
    __APP_VERSION__: JSON.stringify(process.env.OTTER_MAIL_VERSION?.trim() || pkg.version),
    __GOOGLE_CLIENT_ID__: JSON.stringify(buildEnv("OTTER_MAIL_GOOGLE_CLIENT_ID")),
    __GOOGLE_CLIENT_SECRET__: JSON.stringify(buildEnv("OTTER_MAIL_GOOGLE_CLIENT_SECRET")),
  },
  deps: {
    alwaysBundle: (id: string) => !id.startsWith("node:") && !isExternal(id),
    neverBundle: isExternal,
    onlyBundle: false,
  },
} as const;

export default defineConfig({
  pack: [
    {
      ...shared,
      entry: ["src/main.ts"],
      clean: true,
      outputOptions: { codeSplitting: false },
      // electron-chrome-web-store's preload, for the Web Store's pages: the
      // library looks for it next to main.cjs when there's no node_modules.
      copy: { from: "node_modules/electron-chrome-web-store/dist/chrome-web-store.preload.js" },
    },
    {
      // The mail backend's utility process (backend-host.ts forks it).
      ...shared,
      entry: ["src/backend.ts"],
      clean: false,
      outputOptions: { codeSplitting: false },
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      ...shared,
      entry: ["src/preload.ts"],
      clean: false,
    },
    {
      // The browser's extensions' preload (services/extensions.ts).
      ...shared,
      entry: ["src/extensions-preload.ts"],
      clean: false,
      outputOptions: { codeSplitting: false },
    },
  ],
});
