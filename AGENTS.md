# Otter Mail

Otter Mail is a calm, fast Gmail client: an Electron app for macOS, and the same app in the
browser at https://mail.otterware.app. It is laid out like Otter Code (our fork of T3 Code): a
pnpm monorepo built with Vite+ (`vp`); the Mac app ships through GitHub Releases with
auto-update.

What each app supports (Mac, web, iPhone; Gmail vs IMAP): `docs/features.md`. Keep it current
when a feature lands or goes.

## Where code lives

- `packages/core`: the mail backend, shared by both apps: Gmail API client, quota, the SQLite
  mail cache, sync, the JSON stores, the Otter account (better-auth client), mailboxes synced
  across devices, realtime push, and the handlers the UI calls. It is plain TypeScript: anything
  platform-specific goes through the `Platform` interface (`src/platform.ts`).
- `apps/desktop`: the Electron main process (`src/main.ts`: windows, menus, the tray, the Dock,
  updates), the preload, and the mail backend: core in a utility process (`src/backend.ts`) with
  the desktop platform (`src/platform.ts`: node:sqlite, and safeStorage, dialogs and
  notifications asked of main). Main forwards the windows' invokes to it (`src/backend-host.ts`,
  messages in `src/backend-protocol.ts`), so syncing never holds up the app itself.
  - `src/handlers/`: the Mac-only handlers (tray, default mail app, …); `backend.ts` there holds
    the ones the backend serves.
  - `src/services/`: Google sign-in (loopback OAuth), tray, Apple's translator, the agent panel's
    browser (`browser.ts`: its session, the Web Store, popups and permissions; `extensions.ts`
    with `src/extensions-preload.ts`: Chrome's extension APIs Electron lacks), the local agents
    (Claude, Codex; Hermes is in core) and the MCP server that gives them, and other agents on
    the Mac with a token, Otter Mail's tools, default mail app.
  - `src/windows/`: the main window, the menu-bar popover, and where their pages load from.
  - `src/updates.ts`: electron-updater against GitHub Releases.
- `apps/web`: the React renderer, one build for both apps. `index.html` is the main window,
  `tray-popover.html` the menu-bar mini inbox. UI primitives live in `src/components/ui/`.
  Where the main window is (mailbox, label, conversation, Settings pane) is its route
  (`src/main/router.tsx`, TanStack Router): in the hash in the Mac app, real paths on the web
  (`/you@gmail.com/INBOX/<id>`, `/all/inbox`, `/settings/appearance`).
  `src/main/browser/` is the agent panel's browser (Mac): `<webview>` tabs beside the chats, and
  `openLink`, where links from mail and chat go.
  `src/web/` is the browser shell: core in a Web Worker (SQLite WASM on OPFS) hosted by one
  tab for every open tab (`backend.ts`), and the bridge that stands in for the preload. What only the Mac app has is off in `desktopBridge.features`.
- `apps/ios`: Otter Mail for iPhone, a native SwiftUI app (iOS 27, Liquid Glass): ChatGPT's
  layout (a drawer of mailboxes you swipe through), Otter Code's list rows. Its own Swift code,
  not the TypeScript core: it signs in to Google itself (the "iOS" OAuth client, PKCE), talks to
  Gmail directly, caches on disk, and follows the Otter account through the relay (mailboxes,
  preferences under the same keys, live events). `Resources/` holds the themes and demo mailbox,
  exported from `packages/shared` by `pnpm ios:resources`. See its README.
- `packages/contracts`: types shared by both sides, including `DesktopBridge`, the
  `window.desktopBridge` API the preload exposes, and the relay's API (`src/relay.ts`).
- `packages/shared`: what every app shows the same, the iPhone app included: the color themes
  (`./themes`) and the demo mailbox (`./demo-mailboxes`). The web app imports it; the iPhone app
  bundles it as JSON.
- `infra/relay`: https://relay.mail.otterware.app, a Cloudflare Worker (Hono, better-auth,
  Drizzle on D1, a Durable Object per user). Otter accounts, the Gmail accounts linked to them,
  the account's preferences (core's `services/preferences.ts` syncs them), its projects (core's
  `services/projects.ts`; agents elsewhere reach them over the relay's MCP server), and realtime mail: Gmail → Pub/Sub → relay → WebSocket to each signed-in device. It never sees
  mail; the web app's Gmail tokens pass through it (never stored), the Mac app's never do. See its
  README.
- `native/translator`: a Swift command-line helper for Apple's on-device Translation. It reads a
  JSON request on stdin and prints JSON. Building it needs full Xcode (macOS 26 SDK).
- `scripts/`: dev runner, desktop packaging (`build-desktop-artifact.ts`), release helpers.
- `assets/`: app icons like T3 Code's: `prod/` for releases, `dev/` for the blueprint variant that
  unpackaged runs wear. `pnpm icons:export` regenerates the dev icon and both `.icns` files.
- `changelog/`: notes on Mac and web releases (`<version>.md`, images in `images/`), shown on
  otterware.app/mail/changelog (the website repository copies them hourly) and on the version's
  GitHub Release (workflows copy it there); the app only links there. A note is marketing, written only when the user asks for one (the
  `write-changelog` skill). Format in `packages/shared/src/changelog.ts`.
- `site/`: https://mail.otterware.app, a Cloudflare Worker: the web app, at `/` and any other
  page that isn't a file (the app's own routes). Otter Mail's page, privacy policy and terms are
  on https://otterware.app/mail/ (the `website` repository, with every Otterware app's page);
  their old addresses here redirect there.
- Deploys: Cloudflare Workers Builds deploys `infra/relay` and `site/` on pushes to `main` that
  touch them; GitHub Actions smoke-tests the relay every 6 hours (keyless Google Cloud access).

## How the pieces talk

The app is local-first: it talks to Gmail directly and renders from its SQLite cache. The Otter
account (the user button by Back in Settings) is who you are; mailboxes are the Gmail accounts
it holds, which follow you to every device, with push from the relay. The Mac app works without
it; the web app needs it (the relay keeps its Gmail sign-ins alive).

- Renderer → backend: `window.desktopBridge.invoke(channel, params)` → a handler registered with
  core's `handle(channel, …)` (served over Electron IPC, or Worker messages on the web), or an
  `ipcMain.handle` for the Mac-only ones.
- Backend → renderer: `broadcast(channel, params)` → `window.desktopBridge.on(channel, listener)`.
- Keep channel names stable; both sides refer to them by string.
- Renderer code never touches Electron, Node or the backend directly. Anything new goes through a
  handler; anything platform-specific in core goes through the Platform.

## Dev

- `pnpm install`, then `pnpm dev`: the web app on :5833 with a local relay on :8787 (open it in
  a browser, e.g. the T3 preview). `pnpm dev:desktop` runs the Mac app (Vite dev server +
  main-process watcher + Electron with reload); `pnpm dev:web` the web app alone. Both apps render
  the same `apps/web`, so UI work is checked in the browser. See docs/development.md.
- `pnpm dev:ios`: the iPhone app in the simulator (it has the same demo mailbox, from the welcome
  screen).
- `pnpm dev:demo`: the web app on a seeded demo mailbox (a pretend Gmail, no Google or Otter
  account, no relay). Build and test against it rather than the user's real accounts; see the
  `test-otter-mail` skill (`.agents/skills`).
- `pnpm start` runs the built app unpackaged; `pnpm dist:desktop:dmg` builds a DMG in `release/`.
- Data homes (`apps/desktop/src/paths.ts`, as in T3 Code): the installed app uses
  `~/.otter-mail/userdata`; dev runs use `~/.otter-mail/dev`, or `<worktree>/.otter-mail` in a
  linked worktree. `pnpm dev:desktop --home <dir>` overrides. Never point dev at the installed app's home.
- Main-process logs: the terminal, and `logs/main.log` in the state directory.

## Releases

Stable only (no nightlies). The Mac app (and web) and the iPhone app release separately, each with
its own version:

- Mac: run the Release workflow from `main` with a patch/minor/major bump, or push a `vX.Y.Z`
  tag. Installed apps download updates on their own and offer "Restart to update" in the sidebar.
  A release never needs a changelog note: don't write one, or ask about one, unless the user asks.
- iPhone: run the Release iPhone workflow from `main` when `apps/ios` (or what it bundles from
  `packages/shared`) has changed. It uploads to TestFlight and tags `ios-vX.Y.Z`.

`docs/runbook.md` is the short version of shipping each part; details in `docs/release.md`.

## Verifying

Before handing work back, run and fix:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm fmt`

For UI or behavior changes, run the app and check the change in it, at a 1600x1000 viewport.
For the iPhone app, build it (`pnpm dev:ios`, or `xcodebuild` as its README shows) and check the
change in the simulator, in light and dark.

## Taste

- Small, obvious code. Don't add machinery a change doesn't need.
- Match the surrounding code: its naming, comment density and idioms.
- The mail cache is local-first: the UI renders from SQLite and sync catches up. Keep IPC
  payloads small and never block the renderer on Gmail.
- The Mac app targets macOS only (Apple Translation, the Dock badge, the menu-bar popover); the
  web app runs in current browsers. Gate Mac-only UI with `features`, never with ad-hoc checks.
- Each app shows only what works on it. Hide what it doesn't have; don't show it disabled or
  labeled "Available in the Mac app" (an error explaining why something just failed may say so).
