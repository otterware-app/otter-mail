# Development

## Prerequisites

- An Apple Silicon Mac with macOS 26 or newer (the translator uses Apple's Translation framework).
- Node 24 (`engines` in `package.json`) and pnpm 11 via `corepack enable`.
- Full Xcode 26 or newer, selected with `sudo xcode-select -s /Applications/Xcode.app`, to build
  `native/translator`. Without it the app still runs; translation just fails.

## Commands

| Command                  | What it does                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `pnpm install`           | Installs dependencies and the git pre-commit hook (formats staged files).          |
| `pnpm dev`               | The web app and a local relay (see [The web app](#the-web-app)).                   |
| `pnpm dev:desktop`       | Vite dev server + main-process watcher + Electron, restarting on main changes.     |
| `pnpm dev:web`           | The web app alone, against `VITE_RELAY_URL`.                                       |
| `pnpm dev:demo`          | The web app on a made-up mailbox, no accounts (see [Demo mailbox](#demo-mailbox)). |
| `pnpm dev:mail`          | A local IMAP server with a seeded mailbox (see [IMAP locally](#imap-locally)).     |
| `pnpm dev:ios`           | Builds the iPhone app and runs it in the simulator (see `apps/ios/README.md`).     |
| `pnpm ios:resources`     | Re-exports the themes and demo mailbox the iPhone app bundles.                     |
| `pnpm start`             | Runs the built app unpackaged (`pnpm build` first).                                |
| `pnpm build`             | Builds `apps/web/dist` and `apps/desktop/dist-electron`.                           |
| `pnpm build:translator`  | Builds the Swift translator helper.                                                |
| `pnpm typecheck`         | TypeScript across the workspace.                                                   |
| `pnpm lint` / `pnpm fmt` | Oxlint and Oxfmt through Vite+.                                                    |
| `pnpm dist:desktop:dmg`  | Unsigned DMG + ZIP for this Mac's architecture in `release/`.                      |

The dev commands pick ports from the worktree path, so several checkouts can run at once. Set
`OTTER_MAIL_PORT_OFFSET` to choose one yourself. `t3.json` sets up new T3 Code worktrees (install,
then symlinks to the main checkout's `.env.local` and `infra/relay/.dev.vars`) and offers both dev
commands as scripts.

## Agent development

For local developer tests, keep `OPENROUTER_API_KEY` in the repository's ignored `.env` or
`.env.local`. The app never uses that key as a default for visitors. Connect the demo through
Settings › Agents; each private browser session supplies and stores its own key on the server.
Production connections use each Otter account's own key stored on the relay.

The demo's default model is `openrouter/free`; override it with `OPENROUTER_MODEL` in the
repository's env files. Linked worktrees also read the main checkout's model setting, with
worktree values and environment variables taking precedence. No env value enters the browser.

## Data homes

Like T3 Code, data lives under a home, `~/.otter-mail` (or `OTTER_MAIL_HOME`), with one state
directory per kind of run, so development never shares a database with the installed app:

| Run                                                    | State directory                                |
| ------------------------------------------------------ | ---------------------------------------------- |
| Installed app                                          | `~/.otter-mail/userdata`                       |
| `pnpm dev:desktop` / `pnpm start` in the main checkout | `~/.otter-mail/dev`                            |
| `pnpm dev:desktop` / `pnpm start` in a linked worktree | `<worktree>/.otter-mail/userdata` (gitignored) |
| `pnpm dev:desktop --home <dir>`                        | `<dir>/userdata`                               |

`--home` wins over the worktree default, which wins over an ambient `OTTER_MAIL_HOME`: an
inherited variable pointing at `~/.otter-mail` would otherwise put a branch on the installed
app's database. The rules live in `apps/desktop/src/paths.ts` and
`apps/desktop/scripts/dev-home.mjs`.

A state directory holds the mail cache (`mail-cache.db`), accounts, Google tokens
(`google-tokens.json`, encrypted with a Keychain key), settings, views, keybindings, Chromium's
profile in `chromium/` and logs in `logs/main.log`. Delete it to start fresh.

- Each state directory signs in to its accounts separately. Dev runs are named
  "Otter Mail (Dev)" and use their own Keychain key, so they can't read the installed app's tokens.
- Nothing is ever copied between homes.
- Renderer logs are in the DevTools console (View → Toggle Developer Tools).

## Google sign-in

Accounts sign in through the browser with PKCE and a loopback redirect (`127.0.0.1`), using the
"Desktop app" OAuth client of the `otter-mail` Google Cloud project. The client ID and secret are
baked in at build time and never committed: copy `.env.example` to `.env.local` and fill them in
(Credentials: https://console.cloud.google.com/auth/clients?project=otter-mail). The same
`OTTER_MAIL_GOOGLE_CLIENT_ID` / `OTTER_MAIL_GOOGLE_CLIENT_SECRET` variables override the baked-in
values at runtime.

The same client signs in to the Otter account (`infra/relay`): with a Gmail account already on the
Mac, the app proves the identity with a fresh ID token from that account's refresh token, no
browser needed; otherwise it runs the same browser flow with identity scopes only.
`OTTER_MAIL_RELAY_URL` points the app at another relay (e.g. `http://127.0.0.1:8787` for
`pnpm --filter @otter-mail/relay dev`).

The consent screen is published but not yet verified by Google, so sign-in shows an "unverified
app" warning and is capped at 100 users. The home page, privacy policy and terms it links to are
on https://otterware.app/mail/ (the `website` repository); the web app, at
https://mail.otterware.app, is `site/`, which Cloudflare Workers Builds deploys on every push to
`main` that touches it (as it does the relay, see `infra/relay/README.md`).

## The web app

The same renderer runs in a browser, with the mail backend (`packages/core`) in a Web Worker
(`apps/web/src/web`). It needs an Otter account, so `pnpm dev` runs a local relay next to it
(applying the relay's local D1 migrations first) and points the app at it:

```sh
# once (gitignored): the relay's secrets
printf 'BETTER_AUTH_SECRET=any-long-local-secret\nGOOGLE_WEB_CLIENT_SECRET=...\n' > infra/relay/.dev.vars
pnpm dev    # the app on http://localhost:5833, the relay on http://localhost:8787
```

Signing in with Google locally uses the web OAuth client from `wrangler.jsonc`, whose redirect
URIs include `http://localhost:8787/...`, so it works in the main checkout (worktrees' relays sit
on another port). The production relay only accepts its own origin, so `pnpm dev:web` alone is
for pointing `VITE_RELAY_URL` at a relay you run yourself. The browser's data (the mail
cache and files) lives in the site's OPFS storage: clear site data to start fresh.

## IMAP locally

`pnpm dev:mail` (Docker) runs a mail server on this machine to add as an IMAP mailbox:
Dovecot, as in core's protocol tests, with special-use folders and a few seeded threads for
`me@otter.test`, and Mailpit catching what it sends (http://localhost:8025). It prints the
settings to enter: password `pass`, IMAP on `localhost` port 31993 (TLS), SMTP on 31465 (TLS).
`pnpm dev:mail down` stops it and drops its mail: the next run starts from the seed again.

Both apps verify certificates, so the server's comes from a dev CA made once per checkout in
`.otter-mail/dev-mail/` (gitignored). The dev runner trusts it when it exists, and only there:

- `pnpm dev`: the web app's TLS (`apps/web/src/web/tls.ts`) adds it to Mozilla's roots through
  `VITE_DEV_MAIL_CA`, read in dev builds only. The local relay runs with
  `TUNNEL_ALLOW_PRIVATE=true`, which lets its tunnel reach `localhost` and any port; the
  production relay (`wrangler.jsonc`) never sets it and allows only mail ports on public hosts.
- `pnpm dev:desktop`: `NODE_EXTRA_CA_CERTS`, which the Mac app's backend process honors.

The web app still needs an Otter account to open the tunnel (sign in as usual). Delete
`.otter-mail/dev-mail/` and rerun `pnpm dev:mail` for a new CA.

## Demo mailbox

`pnpm dev:demo` runs the web app alone with `VITE_DEMO=1`: no relay, no Google or Otter account.
The backend's Worker puts a pretend Gmail in front of `fetch` (`apps/web/src/web/demo`), seeded
with two mailboxes, "Personal" (`demo@otter.example`) and "Work" (`sam@acme.example`): a few weeks
of threads, newsletters with unsubscribe links, attachments, calendar invitations, drafts, spam
and trash, and plenty of non-ASCII names. Use it to build and test without your own accounts.

- Archiving, labels, stars, trash, sending and drafts change the pretend mailbox and go into its
  history feed, so sync behaves as it does against Gmail. Search knows the common operators
  (`in:`, `is:`, `label:`, `category:`, `from:`, `has:attachment`, …) plus free text.
- Calendar RSVPs go out as email replies (no calendar); avatars fall back to initials; the Otter
  account (signing in, devices, synced preferences) is unavailable.
- The demo keeps its own storage (OPFS `.otter-mail-demo` and `demo-files/`, lock and channel
  `otter-mail-demo`), apart from real mail on the same origin. Add `?reset-demo` to the address
  to start over (close other demo tabs first).
- Real builds leave all of it out: `__DEMO__` is `false` unless `VITE_DEMO=1`.

`pnpm --filter @otter-mail/site build` assembles the deployable site (the web app) in
`site/dist`.
