import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as NodeURL from "node:url";
import "vite-plus/test/config";
import { defineConfig, type Plugin } from "vite-plus";

import { demoAgentServer } from "./dev-agent-server";

import pkg from "./package.json" with { type: "json" };
import { releaseChannel } from "../../packages/shared/src/release-channel";

const port = Number(process.env.PORT ?? 5833);

/** `pnpm dev:demo`: its mailboxes, signed in through the local relay (packages/contracts/src/demo.ts). */
const devDemo = Boolean(
  process.env.OTTER_MAIL_DEMO_MAILBOXES &&
  process.env.VITE_RELAY_URL?.startsWith("http://localhost:"),
);

/** The demo's mailboxes, for the backend to add: from the dev server only, never in a build. */
function demoMailboxes(): Plugin {
  return {
    name: "otter-demo-mailboxes",
    apply: "serve",
    configureServer(server) {
      if (!devDemo) return;
      server.middlewares.use("/__dev/demo-mailboxes", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(process.env.OTTER_MAIL_DEMO_MAILBOXES);
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Built files are loaded by the Electron shell (ottermail://app/) and served
  // at mail.otterware.app by the site Worker, both from the root. Absolute
  // paths, so a page loaded at a deep route (/you@gmail.com/INBOX/…) finds them.
  base: "/",
  plugins: [
    {
      name: "otter-build-icons",
      transformIndexHtml(html) {
        const channel =
          command === "serve"
            ? "dev"
            : releaseChannel(process.env.OTTER_MAIL_VERSION || pkg.version);
        return channel === "stable"
          ? html
          : html.replace(
              /href="\/(favicon\.(?:ico|svg)|apple-touch-icon\.png)"/g,
              `href="/icons/${channel}/$1"`,
            );
      },
    },
    demoAgentServer(),
    demoMailboxes(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  define: {
    __APP_DISPLAY_NAME__: JSON.stringify("Otter Mail"),
    __APP_VERSION__: JSON.stringify(process.env.OTTER_MAIL_VERSION?.trim() || pkg.version),
    // `pnpm dev:fake`: a made-up mailbox, no Google or Otter account.
    __DEMO__: JSON.stringify(process.env.VITE_DEMO === "1"),
    // `pnpm dev:demo`: real demo mailboxes, kept apart from the mail you develop with.
    __DEV_DEMO__: JSON.stringify(command === "serve" && devDemo),
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
      },
    },
  },
}));
