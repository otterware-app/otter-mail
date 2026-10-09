#!/usr/bin/env node
// Runs the app for development, like Otter Code's runner: `pnpm dev` is the
// web app with a local relay, `pnpm dev:web` the web app alone, `pnpm dev:fake`
// the web app on a made-up mailbox (no accounts), and
// `pnpm dev:desktop` the web dev server, the main-process bundler in watch mode
// and Electron (restarted on main/preload changes). `pnpm dev:demo` and
// `pnpm dev:demo:desktop` are `pnpm dev` and `pnpm dev:desktop` opening on the
// demo mailboxes (packages/contracts/src/demo.ts). One Ctrl-C stops them all.
//
// Ports: 5833 in the main checkout. Linked git worktrees get a stable offset
// hashed from their path so several checkouts can run side by side.
// Override with OTTER_MAIL_PORT_OFFSET=<n> or PORT=<port>. The relay sits on
// 8787 plus the same offset.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { parseArgs, parseEnv } from "node:util";

import { resolveDevHome, resolveLinkedWorktree } from "../apps/desktop/scripts/dev-home.mjs";
import {
  DEMO_MAILBOXES_ENV,
  parseDemoMailboxes,
  type DemoMailbox,
} from "../packages/contracts/src/demo.ts";
import { localConfig } from "../infra/relay/scripts/local-config.ts";
import { buildTranslator, findTranslatorBinary, repoRoot } from "./build-translator.ts";
import { login } from "./demo-login.ts";
import { devMailbox, devMailCa, startDevMail } from "./dev-mail.ts";

const BASE_WEB_PORT = 5833;
const BASE_RELAY_PORT = 8787;
const MAX_HASH_OFFSET = 3000;
const SHUTDOWN_GRACE_MS = 3_000;

const MODES = [
  "dev",
  "dev:web",
  "dev:fake",
  "dev:desktop",
  "dev:demo",
  "dev:demo:desktop",
] as const;
type Mode = (typeof MODES)[number];

const HELP = `Usage: pnpm dev | dev:web | dev:fake | dev:desktop | dev:demo | dev:demo:desktop [options]

  pnpm dev               The web app (apps/web) and the relay (infra/relay) it signs
                         in through, on localhost. Open the printed URL in a browser.
  pnpm dev:web           Only the web app, against VITE_RELAY_URL (default:
                         production, which only accepts its own origin).
  pnpm dev:fake          Only the web app, on a made-up mailbox: no Google or Otter
                         account, no relay (VITE_DEMO=1, apps/web/src/web/demo).
  pnpm dev:desktop       The Mac app: the web dev server, \`vp pack --watch\`
                         (apps/desktop) and Electron against them.
  pnpm dev:demo          \`pnpm dev\`, opening on the demo mailboxes: .env.local's
  pnpm dev:demo:desktop  ${DEMO_MAILBOXES_ENV} and the local IMAP server's
                         (\`pnpm dev:mail\`, started for it). docs/development.md.

Ctrl-C stops everything.

Options:
  --home <dir>    Data home of the Mac app. Default: a linked worktree's own
                  .otter-mail, otherwise ~/.otter-mail/dev (never the installed
                  app's ~/.otter-mail/userdata); for the demo, its demo/ inside.
  --login         Demo runs: sign the demo Gmail mailboxes in to Google (Outlook ones to Microsoft) first
                  (once per machine), saving the sign-ins in .env.local.
  --dry-run       Print the resolved ports and commands, then exit.
  -h, --help      Show this help.

Environment:
  OTTER_MAIL_HOME         Data home, same as --home.
  OTTER_MAIL_REMOTE_DEBUGGING_PORT
                          Chrome DevTools port of the dev app (default: dev server
                          port + 1000; 0 turns it off). Playwright and agents attach
                          here with connectOverCDP.
  PORT                    Exact dev server port.
  OTTER_MAIL_PORT_OFFSET  Offset added to ${BASE_WEB_PORT} and the relay's ${BASE_RELAY_PORT}
                          (default: hashed from the worktree path in linked
                          worktrees, 0 otherwise). Google sign-in through the
                          local relay only works on ${BASE_RELAY_PORT}.
`;

export function hashOffset(seed: string): number {
  const digest = NodeCrypto.createHash("sha256").update(seed).digest();
  return (digest.readUInt32BE(0) % MAX_HASH_OFFSET) + 1;
}

/** Linked worktrees have a `.git` file (not directory) pointing at the main repo. */
export function resolvePortOffset(
  env: NodeJS.ProcessEnv,
  root: string,
): { offset: number; source: string } {
  const raw = env.OTTER_MAIL_PORT_OFFSET?.trim();
  if (raw) {
    const offset = Number(raw);
    if (!Number.isInteger(offset) || offset < 0 || BASE_WEB_PORT + offset > 65535) {
      throw new Error(`OTTER_MAIL_PORT_OFFSET must be a non-negative integer; received "${raw}".`);
    }
    return { offset, source: `OTTER_MAIL_PORT_OFFSET=${offset}` };
  }
  if (resolveLinkedWorktree(root)) return { offset: hashOffset(root), source: `worktree ${root}` };
  return { offset: 0, source: "default port" };
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < Math.min(start + 100, 65536); port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free dev server port between ${start} and ${start + 99}.`);
}

function ensureTranslator(): void {
  if (findTranslatorBinary()) return;
  console.log("[dev] Building native/translator (first run only)...");
  try {
    console.log(`[dev] Translator ready: ${buildTranslator({ quiet: true })}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[dev] Skipping the translator; in-app translation will be unavailable.\n${message}`,
    );
  }
}

/** The local relay needs its secrets and an up-to-date local D1 (idempotent). */
function prepareRelay(wrangler: string): void {
  const relayDir = NodePath.join(repoRoot, "infra/relay");
  if (!NodeFS.existsSync(NodePath.join(relayDir, ".dev.vars"))) {
    throw new Error(
      "infra/relay/.dev.vars is missing: it needs BETTER_AUTH_SECRET and GOOGLE_WEB_CLIENT_SECRET (see docs/development.md).",
    );
  }
  const migrate = NodeChildProcess.spawnSync(
    wrangler,
    ["d1", "migrations", "apply", "otter-mail-relay", "--local"],
    { cwd: relayDir, env: { ...process.env, CI: "1" }, encoding: "utf8" },
  );
  if (migrate.status !== 0) {
    throw new Error(`Couldn't migrate the relay's local database:\n${migrate.stderr}`);
  }
}

/**
 * The checkout's .env.local: in a T3 worktree a link to the main checkout's,
 * else the main checkout's own (the parent of git's common dir).
 */
function envLocalPath(): string {
  const own = NodePath.join(repoRoot, ".env.local");
  if (NodeFS.existsSync(own)) return own;
  const common = NodeChildProcess.execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return NodePath.join(NodePath.dirname(common.trim()), ".env.local");
}

/**
 * The Google client a demo sign-in is for: the Mac app's (.env.local), or the
 * local relay's web client, through the callback registered for it.
 */
function googleClient(app: "desktop" | "web", env: Record<string, string | undefined>) {
  if (app === "desktop") {
    const id = process.env.OTTER_MAIL_GOOGLE_CLIENT_ID ?? env.OTTER_MAIL_GOOGLE_CLIENT_ID;
    const secret =
      process.env.OTTER_MAIL_GOOGLE_CLIENT_SECRET ?? env.OTTER_MAIL_GOOGLE_CLIENT_SECRET;
    if (!id || !secret)
      throw new Error(".env.local needs OTTER_MAIL_GOOGLE_CLIENT_ID and _SECRET.");
    return { id, secret };
  }
  const relayDir = NodePath.join(repoRoot, "infra/relay");
  const id = /"GOOGLE_WEB_CLIENT_ID":\s*"([^"]+)"/.exec(
    NodeFS.readFileSync(NodePath.join(relayDir, "wrangler.jsonc"), "utf8"),
  )?.[1];
  const vars = NodePath.join(relayDir, ".dev.vars");
  const secret = NodeFS.existsSync(vars)
    ? parseEnv(NodeFS.readFileSync(vars, "utf8")).GOOGLE_WEB_CLIENT_SECRET
    : undefined;
  if (!id || !secret) throw new Error("infra/relay/.dev.vars needs GOOGLE_WEB_CLIENT_SECRET.");
  return { id, secret, redirectUri: `http://localhost:${BASE_RELAY_PORT}/v1/gmail/callback` };
}

/**
 * The Microsoft client a demo sign-in is for: the Mac app's public one
 * (.env.local), or the local relay's web client (infra/relay/.dev.vars),
 * through the callback registered for it.
 */
function microsoftClient(app: "desktop" | "web", env: Record<string, string | undefined>) {
  if (app === "desktop") {
    const id = process.env.OTTER_MAIL_MICROSOFT_CLIENT_ID ?? env.OTTER_MAIL_MICROSOFT_CLIENT_ID;
    if (!id) throw new Error(".env.local needs OTTER_MAIL_MICROSOFT_CLIENT_ID.");
    return { id };
  }
  const relayDir = NodePath.join(repoRoot, "infra/relay");
  const vars = NodePath.join(relayDir, ".dev.vars");
  const devVars = NodeFS.existsSync(vars) ? parseEnv(NodeFS.readFileSync(vars, "utf8")) : {};
  const id =
    devVars.MICROSOFT_CLIENT_ID ||
    /"MICROSOFT_CLIENT_ID":\s*"([^"]+)"/.exec(
      NodeFS.readFileSync(NodePath.join(relayDir, "wrangler.jsonc"), "utf8"),
    )?.[1];
  const secret = devVars.MICROSOFT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("infra/relay/.dev.vars needs MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.");
  }
  return { id, secret, redirectUri: `http://localhost:${BASE_RELAY_PORT}/v1/outlook/callback` };
}

/**
 * The demo runs' mailboxes (packages/contracts/src/demo.ts): .env.local's,
 * signed in to Google first with `--login`, then the local IMAP server's,
 * started for them.
 */
async function demoMailboxes(mode: Mode, signIn: boolean): Promise<DemoMailbox[]> {
  const file = envLocalPath();
  const env = NodeFS.existsSync(file) ? parseEnv(NodeFS.readFileSync(file, "utf8")) : {};
  const json = process.env[DEMO_MAILBOXES_ENV] ?? env[DEMO_MAILBOXES_ENV];
  let mailboxes = json ? parseDemoMailboxes(json) : [];
  const app = mode === "dev:demo:desktop" ? "desktop" : "web";
  if (signIn) {
    mailboxes = await login(file, mailboxes, app, {
      google: () => googleClient(app, env),
      microsoft: () => microsoftClient(app, env),
    });
  }
  if (!json) console.warn(`[dev] ${file} has no ${DEMO_MAILBOXES_ENV} (docs/development.md).`);
  for (const mailbox of mailboxes) {
    if (mailbox.provider !== "imap" && !mailbox.refreshTokens[app]) {
      console.warn(`[dev] ${mailbox.email} isn't signed in yet: run \`pnpm ${mode} --login\`.`);
    }
  }
  try {
    await startDevMail();
    mailboxes.push(devMailbox);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[dev] Skipping the local IMAP mailbox (is Docker running?): ${message}`);
  }
  return mailboxes;
}

const COLORS = ["\u001b[36m", "\u001b[35m", "\u001b[33m"];
const RESET = "\u001b[0m";

interface Task {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      login: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const mode = (positionals[0] ?? "dev") as Mode;
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}".\n\n${HELP}`);
  const desktop = mode === "dev:desktop" || mode === "dev:demo:desktop";
  const demo = mode === "dev:demo" || mode === "dev:demo:desktop";
  const relay = mode === "dev" || mode === "dev:demo";

  const { offset, source } = resolvePortOffset(process.env, repoRoot);
  const explicitPort = process.env.PORT?.trim();
  let port: number;
  let portSource: string;
  if (explicitPort) {
    port = Number(explicitPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`PORT must be a valid port number; received "${explicitPort}".`);
    }
    portSource = `PORT=${port}`;
  } else {
    const preferred = BASE_WEB_PORT + offset;
    port = values["dry-run"] ? preferred : await findFreePort(preferred);
    portSource = port === preferred ? source : `${source}; ${preferred} was busy`;
  }
  const devServerUrl = `http://localhost:${port}`;
  // The relay's origin is baked into the web app's sign-in and its CORS, so it
  // doesn't move to a free port: a busy one fails loudly instead.
  const relayPort = BASE_RELAY_PORT + offset;
  const relayUrl = `http://localhost:${relayPort}`;

  const vp = NodePath.join(repoRoot, "node_modules", ".bin", "vp");
  const wrangler = NodePath.join(repoRoot, "infra/relay/node_modules/.bin/wrangler");
  // Beside wrangler.jsonc, so Wrangler still finds the relay's .dev.vars.
  const relayConfig = NodePath.join(repoRoot, "infra/relay/.wrangler.local.jsonc");
  const tasks: Task[] = [
    { name: "web", command: vp, args: ["dev"], cwd: NodePath.join(repoRoot, "apps/web") },
  ];
  if (relay) {
    tasks.push({
      name: "relay",
      command: wrangler,
      args: [
        "dev",
        // Its own sign-in, not production's Otter Accounts (infra/relay/scripts/dev.ts).
        "--config",
        relayConfig,
        "--port",
        String(relayPort),
        "--local-upstream",
        `localhost:${relayPort}`,
        "--var",
        `BETTER_AUTH_URL:${relayUrl}`,
        "--var",
        `APP_ORIGIN:${devServerUrl}`,
        "--var",
        "COOKIE_DOMAIN:",
        // A local IMAP server for the web app (docs/development.md); never in production.
        "--var",
        "TUNNEL_ALLOW_PRIVATE:true",
        // The demo's sign-ins, without Google (infra/relay/src/worker.ts).
        ...(demo ? ["--var", "DEV_DEMO:true"] : []),
      ],
      cwd: NodePath.join(repoRoot, "infra/relay"),
    });
  }
  if (desktop) {
    tasks.push(
      {
        name: "pack",
        command: vp,
        args: ["pack", "--watch"],
        cwd: NodePath.join(repoRoot, "apps/desktop"),
      },
      {
        name: "electron",
        command: process.execPath,
        args: ["scripts/dev-electron.mjs"],
        cwd: NodePath.join(repoRoot, "apps/desktop"),
      },
    );
  }

  const devHome = resolveDevHome({ cwd: repoRoot, explicitHome: values.home });
  // The demo keeps its own data, apart from the mailboxes you develop with.
  const dataHome =
    demo && !values.home
      ? NodePath.join(devHome ?? NodePath.join(NodeOS.homedir(), ".otter-mail"), "demo")
      : devHome;
  const configuredDebugPort = process.env.OTTER_MAIL_REMOTE_DEBUGGING_PORT?.trim();
  const debugPort = !desktop
    ? 0
    : configuredDebugPort !== undefined && configuredDebugPort !== ""
      ? Number(configuredDebugPort)
      : values["dry-run"]
        ? port + 1000
        : await findFreePort(port + 1000);
  console.log(`[dev] ${devServerUrl} (${portSource})`);
  if (mode === "dev:fake") console.log("[dev] Made-up mailbox (?reset-demo starts it over)");
  if (relay) console.log(`[dev] Relay: ${relayUrl}`);
  if (desktop) {
    console.log(
      `[dev] Data: ${dataHome ? NodePath.join(dataHome, "userdata") : "~/.otter-mail/dev"}`,
    );
  }
  if (debugPort > 0) console.log(`[dev] DevTools: http://127.0.0.1:${debugPort}`);
  if (values["dry-run"]) {
    for (const task of tasks) {
      console.log(
        `[dev] ${task.name}: (cd ${task.cwd} && ${[task.command, ...task.args].join(" ")})`,
      );
    }
    return;
  }
  if (!NodeFS.existsSync(vp)) throw new Error("vite-plus is not installed. Run `pnpm install`.");

  stopLeftoverGroups();
  if (relay) {
    NodeFS.writeFileSync(relayConfig, localConfig());
    prepareRelay(wrangler);
  }
  const mailboxes = demo ? await demoMailboxes(mode, values.login) : [];
  if (desktop) {
    ensureTranslator();
    // A stale bundle would let Electron start before the first fresh build.
    NodeFS.rmSync(NodePath.join(repoRoot, "apps/desktop/dist-electron"), {
      recursive: true,
      force: true,
    });
  }

  // `pnpm dev:mail`'s CA, for its local mail server (docs/development.md).
  const trustDevMail = mode !== "dev:fake" && NodeFS.existsSync(devMailCa);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OTTER_MAIL_HOME: dataHome,
    OTTER_MAIL_REMOTE_DEBUGGING_PORT: String(debugPort),
    PORT: String(port),
    VITE_DEV_SERVER_URL: devServerUrl,
    ...(relay ? { VITE_RELAY_URL: relayUrl } : {}),
    ...(mode === "dev:fake" ? { VITE_DEMO: "1" } : {}),
    ...(demo ? { [DEMO_MAILBOXES_ENV]: JSON.stringify(mailboxes) } : {}),
    ...(trustDevMail
      ? {
          VITE_DEV_MAIL_CA: NodeFS.readFileSync(devMailCa, "utf8"),
          NODE_EXTRA_CA_CERTS: devMailCa,
        }
      : {}),
    FORCE_COLOR: process.env.FORCE_COLOR ?? (process.stdout.isTTY ? "1" : "0"),
  };

  const children = new Map<string, NodeChildProcess.ChildProcess>();
  let shuttingDown = false;

  const shutdown = async (exitCode: number): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true;
      const running = [...children.values()].filter((child) => child.exitCode === null);
      const exited = running.map(
        (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
      );
      for (const child of running) signalGroup(child, "SIGTERM");
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
      await Promise.race([Promise.all(exited), timeout]);
      for (const child of children.values()) signalGroup(child, "SIGKILL");
    }
    process.exit(exitCode);
  };

  tasks.forEach((task, index) => {
    const prefix = `${COLORS[index % COLORS.length]}[${task.name}]${RESET} `;
    // Detached: each task gets its own process group, so the terminal's Ctrl-C
    // reaches only this runner, which then stops every group in order.
    const child = NodeChildProcess.spawn(task.command, task.args, {
      cwd: task.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(task.name, child);
    for (const stream of [child.stdout, child.stderr]) {
      const target = stream === child.stderr ? process.stderr : process.stdout;
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        target.write(`${prefix}${line}\n`);
      });
    }
    child.once("error", (error) => {
      console.error(`${prefix}failed to start: ${error.message}`);
      void shutdown(1);
    });
    child.once("exit", (code, signal) => {
      if (shuttingDown) return;
      console.error(`${prefix}exited (${signal ?? code}); stopping dev.`);
      void shutdown(code ?? 1);
    });
  });

  recordGroups([...children.values()].flatMap((child) => (child.pid ? [child.pid] : [])));

  process.once("SIGINT", () => void shutdown(130));
  process.once("SIGTERM", () => void shutdown(143));
  process.once("SIGHUP", () => void shutdown(129));
}

// A runner killed outright (SIGKILL, a closed terminal tab) can't stop its
// detached task groups; the next run finds them in its file and stops them,
// so the dev server port is free again. One file per runner (named by its
// pid), so runs side by side (\`pnpm dev\` next to \`pnpm dev:desktop\`) leave
// each other alone.
const groupsDir = NodePath.join(repoRoot, "apps/desktop/.electron-runtime/dev-groups");

function recordGroups(pids: number[]): void {
  NodeFS.mkdirSync(groupsDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(groupsDir, `${process.pid}.json`), JSON.stringify(pids));
  process.once("exit", () =>
    NodeFS.rmSync(NodePath.join(groupsDir, `${process.pid}.json`), { force: true }),
  );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopLeftoverGroups(): void {
  let files: string[] = [];
  try {
    files = NodeFS.readdirSync(groupsDir);
  } catch {
    return;
  }
  for (const file of files) {
    const runner = Number.parseInt(file, 10);
    if (isAlive(runner)) continue;
    const path = NodePath.join(groupsDir, file);
    let pids: number[] = [];
    try {
      pids = JSON.parse(NodeFS.readFileSync(path, "utf8")) as number[];
    } catch {
      // Unreadable: drop it below.
    }
    for (const pid of pids) {
      // Only groups that still look like ours: the pid may have been reused.
      const command = NodeChildProcess.spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout;
      if (!/vite-plus|dev-electron\.mjs|wrangler/.test(command)) continue;
      console.log(`[dev] Stopping leftovers from an earlier run (pid ${pid})`);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    NodeFS.rmSync(path, { force: true });
  }
}

/** Signals the task's whole process group, so grandchildren (esbuild, Electron) go too. */
function signalGroup(child: NodeChildProcess.ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group is already gone.
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
