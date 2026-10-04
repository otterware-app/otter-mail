# Otter Mail relay

https://relay.mail.otterware.app, a Cloudflare Worker. It gives Otter Mail seven things (the
Mac app works without it; the web app needs it):

- **Otter accounts.** Sign in with Google once per Mac, and the mailboxes you use come along to
  every Mac. The relay keeps the list of linked addresses (Gmail, or IMAP with its server
  settings) and their display names and colors. Each Mac still signs in to each mailbox itself;
  the relay never holds Gmail tokens or IMAP passwords. Linking a Gmail account needs a Google ID
  token for it; an IMAP link proves nothing, so it never receives Gmail pushes, and a mailbox
  can't switch between Gmail and IMAP without being unlinked first (409).
- **Preferences that follow you.** Settings, views, keybindings, the agent's settings and
  UI choices like the theme, as sections of JSON per Otter account, plus the Hermes API key,
  sealed with a key derived from the auth secret. A change is pushed to the account's other
  devices over the same WebSocket as mail. See `src/preferences.ts`.
- **The OpenRouter agent.** `/v1/agent/*` serves the AI SDK tool loop, connection, chat history,
  streaming turns, tool results and cancellation. One `AgentHub` Durable Object per Otter
  account keeps the OpenRouter key sealed using the auth secret and histories in chunked
  storage. Mac, web and iPhone send only the tools they can execute, and answer tool requests
  on the initiating device with local approvals. Tool results can contain mail; Gmail tokens
  and IMAP passwords remain on the device. Signing out stops that device's turns; deleting
  the Otter account deletes the agent's key and history. Deploy the `AgentHub` binding and
  `v2` migration in `wrangler.jsonc` together with this API and the updated clients.
- **Projects.** The conversations, links and notes of one piece of work, until it's settled
  (`packages/contracts/src/projects.ts`). Three tables: the projects, their threads (mailbox
  and Gmail thread ID, never a subject) and their links, each written on its own so devices and
  agents changing different parts of a project don't overwrite each other; every write sends
  the `projects` event. Agents that run elsewhere (Hermes) manage them over MCP at `/mcp`
  (Streamable HTTP, stateless) with an agent token made in Settings; the relay keeps its
  SHA-256 hash. The tools are the contracts' `project-tools.ts`, the same the Mac app gives
  Claude and Codex. See `src/projects.ts` and `src/mcp.ts`.
- **Gmail sign-in for the web app.** A browser can't keep a Google refresh token by itself, so
  the relay does the OAuth exchange with the web client and seals the refresh token (only the
  relay can open it, and only for the Otter user it was issued to). The browser keeps the sealed
  token and asks `/v1/gmail/token` for fresh access tokens. Nothing is stored here. See
  `src/gmail.ts`.
- **Realtime mail.** Each Mac asks Gmail (`users.watch`) to publish its mailboxes' changes to the
  `gmail-push` Pub/Sub topic. Pub/Sub pushes each notification (`{ emailAddress, historyId }`,
  no content) to the relay, which forwards it over WebSocket to the Macs of whoever linked that
  address. They sync the change from Gmail within a couple of seconds, instead of on the next poll.
- **A tunnel to mail servers for the web app.** A browser can't open TCP connections, so
  `/v1/tunnel` pipes a WebSocket to an IMAP or SMTP server (mail ports only, public hosts only).
  The web app does TLS inside it, so the relay carries ciphertext; it logs host, port, byte
  counts and duration, once per tunnel. It runs in the plain Worker, not a Durable Object:
  a Worker bills CPU time, and an IDLE connection is hours of waiting. Tunnels close after 30
  minutes without a byte. See `src/tunnel.ts`; the protocol is in the contracts.

  So it isn't a free proxy for anyone with an Otter account, and costs nothing per tunnel beyond
  the request (no Durable Object, no KV):
  - **Where.** Mail ports only, on DNS names or public IPv4 addresses. A DNS name is checked by
    its spelling only; that it doesn't resolve somewhere private is Cloudflare's doing:
    `connect()` refuses "Cloudflare IPs, `localhost`, and private network IPs"
    ([TCP sockets, Troubleshooting](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)).
  - **Linked or not.** The servers (host and port) of the user's linked IMAP mailboxes, read from
    D1 with one query after the session check, get 30 tunnels a minute and 200 MB each way per
    tunnel. Any other host gets 6 a minute and 1 MB each way: adding a mailbox checks its
    password before linking it, and a login fits in far less. Linking a host proves nothing (an
    IMAP link is just settings), but it puts the host on record against the account.
  - **How often.** Workers' rate limiting bindings (`ratelimits` in `wrangler.jsonc`), keyed by
    user id: counted in memory per Cloudflare location, loosely, and not billed separately; they
    work in `wrangler dev` and the tests too. Over the rate, the WebSocket closes at once with
    `TUNNEL_CLOSE.rateLimited`. Concurrent tunnels aren't counted (that would take a Durable
    Object); the rate bounds them.
  - **Memory.** The client's bytes are written to the socket one frame at a time; a client more
    than 8 MB ahead of the server is cut off. A Worker's WebSocket has no `bufferedAmount`, so
    the server's bytes are read at most 4 MB a second (after 8 MB): a client that stops reading
    lets the backlog grow only that fast, until the byte cap closes the tunnel.

```
Gmail ──users.watch──▶ Pub/Sub topic gmail-push ──push (OIDC)──▶ /push/gmail
                                                                   │ linked_accounts
Mac ◀──── WebSocket /v1/events ◀── UserHub (Durable Object, one per user) ◀┘
```

## Code map

- `src/worker.ts`: routes (Hono). `/v1/auth/*` is better-auth; `/v1/me`, `/v1/accounts`,
  `/v1/preferences`, `/v1/projects`, `/v1/agent-tokens`, `/v1/events` and `/v1/tunnel` need a
  session; `/mcp` takes an agent token; `/push/gmail` takes Pub/Sub pushes.
- `src/tunnel.ts`: the web app's TCP tunnel (`cloudflare:sockets`), and which hosts and ports
  it may reach.
- `src/auth.ts`: better-auth: Google sign-in (ID tokens from the Mac app, the redirect flow for
  the web app), sessions (bearer tokens for the Mac app, a cookie shared with mail.otterware.app
  for the web app; one per device, 90 days, renewed with use), device list, account deletion.
  Signing a session out closes its sockets.
- `src/identity.ts`: shared Otter sign-in and account deletion pages. Drive uses the relay as
  an OIDC provider with PKCE; see [shared identity](../../docs/shared-identity.md).
- `src/gmail.ts`: the web app's Gmail sign-in popup, and token refreshes.
- `src/preferences.ts`: merging preference sections, sealing the Hermes key.
- `src/projects.ts`: projects, their threads and links; the project tools' store.
- `src/mcp.ts`: agent tokens, and the MCP server agents reach projects through.
- `src/keys.ts`: keys derived from the auth secret, one per purpose.
- `src/google-jwt.ts`: verifies Google-signed JWTs (jose): ID tokens, and Pub/Sub's push tokens.
- `src/user-hub.ts`: the Durable Object holding each user's sockets (hibernating).
- `src/schema.ts`, `src/store.ts`: the D1 schema (Drizzle) and the queries (linked accounts,
  preferences).
- `migrations/`: generated with `pnpm db:generate` from `src/schema.ts`.
- API types shared with the app: `packages/contracts/src/relay.ts`.

## Working on it

```sh
pnpm --filter @otter-mail/relay test        # unit + end-to-end tests in workerd (local D1, DO)
pnpm --filter @otter-mail/relay dev         # wrangler dev on :8787
pnpm --filter @otter-mail/relay db:generate # after changing src/schema.ts
```

The end-to-end tests run the real Worker with a local D1 and Durable Object; a local JWKS server
plays Google and signs the ID and push tokens.

## Deploying

Cloudflare Workers Builds deploys on every push to `main` that touches `infra/relay/`,
`packages/contracts/` or `pnpm-lock.yaml` (trigger "Deploy relay from main" on the
`otter-mail-relay` Worker): it installs the workspace from the repo root and runs
`pnpm --filter @otter-mail/relay run deploy`, which applies D1 migrations and deploys. Builds and
logs are in the Cloudflare dashboard (Workers → otter-mail-relay → Deployments) and on the
commit's checks. `site/` deploys the same way ("Deploy site from main").

The Relay smoke test workflow checks production every 6 hours (and on demand): it signs in with a
real Google ID token, links the address, publishes a notification to the real topic, waits for it
on the socket, and deletes the account. To run it from a laptop:

```sh
pnpm --filter @otter-mail/relay smoke   # needs gcloud; Token Creator on relay-smoke
```

A manual deploy, if ever needed: `pnpm --filter @otter-mail/relay run deploy` with wrangler
credentials (`wrangler login`, or `CLOUDFLARE_API_TOKEN`).

## Google Cloud setup (project `otter-mail`, done once)

- Topic `gmail-push`; `gmail-api-push@system.gserviceaccount.com` has Pub/Sub Publisher on it.
- Service account `gmail-push-relay@otter-mail.iam.gserviceaccount.com`: Pub/Sub signs push
  requests as it (the relay checks the token's audience and email). Nobody else may impersonate
  it.
- Service account `relay-smoke@otter-mail.iam.gserviceaccount.com`: the smoke test's identity.
- Workload Identity pool `github`, provider `otter-mail`: GitHub Actions in
  `otterware-app/otter-mail` (only) may mint `relay-smoke` ID tokens and publish to `gmail-push`. No
  service account keys exist.
- Push subscription `gmail-push-relay` → `https://relay.mail.otterware.app/push/gmail`, OIDC
  token with that URL as audience; 10 minutes retention (a missed notification only delays a
  sync: the app still polls every few minutes).

Secrets (`wrangler secret put …`): `BETTER_AUTH_SECRET` (also keys the Gmail token sealing),
`GOOGLE_WEB_CLIENT_SECRET` (the "Web application" OAuth client, whose ID is `GOOGLE_WEB_CLIENT_ID`
in `wrangler.jsonc`). Locally, put them in `.dev.vars` (gitignored).

## Shared identity service

Production authentication is owned by [Otter Accounts](https://github.com/otterware-app/otter-accounts),
with a dedicated Worker and D1 database at `accounts.otterware.app`. The relay keeps legacy
Mail auth URLs working through the private `ACCOUNTS` service binding (`MailIdentity` entrypoint).
`IdentityLifecycle` handles session disconnects and account deletion in Mail. Mail's Google Gmail
permissions, sealed refresh tokens, profiles and application data remain here. See
[shared identity](../../docs/shared-identity.md) for the compatibility and rollout details.

`pnpm dev` generates a standalone local config without the production service binding; its
local database and fake/developer identities remain independent of production Accounts.
