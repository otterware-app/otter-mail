import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

import { demoAgentServer } from "./dev-agent-server";

import pkg from "./package.json" with { type: "json" };

const port = Number(process.env.PORT ?? 5833);

export default defineConfig({
  // Built files are loaded by the Electron shell (ottermail://app/) and served
  // at mail.otterware.app by the site Worker, both from the root. Absolute
  // paths, so a page loaded at a deep route (/you@gmail.com/INBOX/…) finds them.
  base: "/",
  plugins: [demoAgentServer(), react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  define: {
    __APP_DISPLAY_NAME__: JSON.stringify("Otter Mail"),
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Demo mode (`pnpm dev:demo`): a made-up mailbox, no Google or Otter account.
    __DEMO__: JSON.stringify(process.env.VITE_DEMO === "1"),
  },
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // The web app's backend runs in a module Web Worker, with SQLite as WASM.
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  server: {
    port,
    strictPort: true,
    host: "localhost",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        "todoist-callback": NodeURL.fileURLToPath(
          new URL("./todoist-callback/index.html", import.meta.url),
        ),
        main: NodeURL.fileURLToPath(new URL("./index.html", import.meta.url)),
        "tray-popover": NodeURL.fileURLToPath(new URL("./tray-popover.html", import.meta.url)),
      },
    },
  },
});
