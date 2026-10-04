/** A private local server for the demo. Uses the production AI SDK runtime. */
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { OpenRouterAgentServer } from "@otter-mail/core/agent-server";
import { loadEnv, type Plugin } from "vite-plus";

const COOKIE = "otter-agent-demo";

export function demoAgentServer(): Plugin {
  const agents = new Map<string, OpenRouterAgentServer>();
  return {
    name: "otter-demo-agent",
    apply: "serve",
    configureServer(server) {
      if (process.env.VITE_DEMO !== "1") return;
      const root = path.resolve(server.config.root, "../..");
      // Linked worktrees can share the main checkout's preferred development model.
      let shared = root;
      try {
        shared = path.dirname(
          path.resolve(
            root,
            execFileSync("git", ["rev-parse", "--git-common-dir"], {
              cwd: root,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim(),
          ),
        );
      } catch {
        /* A source archive has no Git checkout. */
      }
      const env = {
        ...loadEnv(server.config.mode, shared, "OPENROUTER_MODEL"),
        ...loadEnv(server.config.mode, root, "OPENROUTER_MODEL"),
      };
      server.middlewares.use("/api/agent", (req, res) => {
        void (async () => {
          try {
            const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
            const origin = `${protocol}://${req.headers.host}`;
            if (req.headers.origin && req.headers.origin !== origin) {
              res.writeHead(403).end("Invalid origin.");
              return;
            }
            const saved = req.headers.cookie
              ?.split(";")
              .map((part) => part.trim())
              .find((part) => part.startsWith(`${COOKIE}=`))
              ?.slice(COOKIE.length + 1);
            const id =
              saved && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(saved)
                ? saved
                : crypto.randomUUID();
            if (id !== saved)
              res.setHeader(
                "Set-Cookie",
                `${COOKIE}=${id}; Path=/api/agent; HttpOnly; SameSite=Strict; Max-Age=2592000${protocol === "https" ? "; Secure" : ""}`,
              );
            let agent = agents.get(id);
            if (!agent) {
              const home = path.resolve(server.config.root, "../../.otter-mail/agent-demo", id);
              const file = (name: string) => path.join(home, name);
              agent = new OpenRouterAgentServer(
                {
                  read: (name) => fs.readFile(file(name), "utf8").catch(() => null),
                  write: async (name, text) => {
                    await fs.mkdir(path.dirname(file(name)), { recursive: true, mode: 0o700 });
                    const tmp = `${file(name)}.${crypto.randomUUID()}.tmp`;
                    await fs.writeFile(tmp, text, { mode: 0o600 });
                    await fs.rename(tmp, file(name));
                  },
                  remove: (name) => fs.rm(file(name), { force: true }),
                  list: async (prefix) =>
                    (await fs.readdir(file(prefix)).catch(() => [] as string[])).map(
                      (name) => `${prefix}${name}`,
                    ),
                },
                process.env.OPENROUTER_MODEL || env.OPENROUTER_MODEL || "openrouter/free",
              );
              agents.set(id, agent);
            }
            const chunks: Uint8Array[] = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 75 * 1024 * 1024) {
                res.writeHead(413).end("Request too large.");
                return;
              }
              chunks.push(chunk);
            }
            const body = chunks.length ? Buffer.concat(chunks) : undefined;
            const request = new Request(`${origin}/api/agent${req.url || "/"}`, {
              method: req.method,
              headers: { "Content-Type": "application/json" },
              body: body && req.method !== "GET" ? body : undefined,
            });
            const response = await agent.fetch(request, id);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            if (!response.body) {
              res.end();
              return;
            }
            const reader = response.body.getReader();
            const close = () => {
              void reader.cancel().catch(() => {});
            };
            res.once("close", close);
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done || res.destroyed) break;
                res.write(value);
              }
            } finally {
              res.off("close", close);
              reader.releaseLock();
              res.end();
            }
          } catch {
            if (!res.headersSent) res.writeHead(500);
            res.end(JSON.stringify({ error: "The agent server could not complete this request." }));
          }
        })();
      });
      server.httpServer?.once("close", () => {
        for (const agent of agents.values()) agent.disconnectRuns();
      });
    },
  };
}
