# Otter Mail relay

https://relay.mail.otterware.app, a Cloudflare Worker. It gives Otter Mail eight things (the
Mac app works without it; the web app needs it):

- **Otter accounts.** Sign in with Google once per Mac, and the mailboxes you use come along to
  every Mac. The relay keeps the list of linked addresses (Gmail, Outlook, or IMAP with its server
  settings) and their display names and colors. Each Mac still signs in to each mailbox itself;
  the relay never holds Gmail or Microsoft tokens or IMAP passwords. Linking a Gmail account needs
  a Google ID token for it, an Outlook one a Microsoft ID token (`src/microsoft-jwt.ts`); an IMAP
  link proves nothing, so it never receives Gmail or Outlook pushes, and a mailbox can't switch
  providers without being unlinked first (409).
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
- **Outlook for the web app.** The same for Microsoft (`src/outlook.ts`): the relay's
  confidential client does the exchange (a browser's Microsoft refresh tokens last a day),
  asks Graph which mailbox signed in, and seals the refresh token. Microsoft rotates refresh
  tokens, so `/v1/outlook/token` answers a freshly sealed one each time.
- **Realtime mail.** Each Mac asks Gmail (`users.watch`) to publish its mailboxes' changes to the
  `gmail-push` Pub/Sub topic. Pub/Sub pushes each notification (`{ emailAddress, historyId }`,
  no content) to the relay, which forwards it over WebSocket to the Macs of whoever linked that
  address. They sync the change from Gmail within a couple of seconds, instead of on the next poll.
  Outlook has no Pub/Sub: each device subscribes its Outlook mailboxes with Microsoft Graph,
  using the `notificationUrl` and `clientState` `/v1/outlook/watch` gives it, and Graph posts
  straight to `/push/outlook/:email`. The `clientState` is an HMAC of the address (keyed from the
  auth secret), so a notification without it is acknowledged (202) and dropped; with it, devices
  of whoever linked the address as Outlook get a `mail` event (`historyId` ""). No iPhone
  alerts for Outlook yet.
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
  session; `/mcp` takes an agent token; `/push/gmail` takes Pub/Sub pushes, `/push/outlook/:email`
  Graph's.
- `src/tunnel.ts`: the web app's TCP tunnel (`cloudflare:sockets`), and which hosts and ports
  it may reach.
- `src/auth.ts`: better-auth: Google sign-in (ID tokens from the Mac app, the redirect flow for
  the web app), sessions (bearer tokens for the Mac app, a cookie shared with mail.otterware.app
  for the web app; one per device, 90 days, renewed with use), device list, account deletion.
  Signing a session out closes its sockets.
- `src/identity.ts`: shared Otter sign-in and account deletion pages. Drive uses the relay as
  an OIDC provider with PKCE; see [shared identity](../../docs/shared-identity.md).
- `src/gmail.ts`: the web app's Gmail sign-in popup, and token refreshes.
- `src/outlook.ts`: the same for Outlook, and Graph subscriptions' `clientState`.
- `src/preferences.ts`: merging preference sections, sealing the Hermes key.
- `src/projects.ts`: projects, their threads and links; the project tools' store.
- `src/mcp.ts`: agent tokens, and the MCP server agents reach projects through.
- `src/keys.ts`: keys derived from the auth secret, one per purpose.
- `src/google-jwt.ts`: verifies Google-signed JWTs (jose): ID tokens, and Pub/Sub's push tokens.
- `src/microsoft-jwt.ts`: verifies Microsoft ID tokens, and which address one proves.
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

## Google Cloud setup (project `otterware`, number `997327858649`)

- Topic `gmail-push`; `gmail-api-push@system.gserviceaccount.com` has Pub/Sub Publisher on it.
- Service account `gmail-push-relay@otterware.iam.gserviceaccount.com`: Pub/Sub signs push
  requests as it (the relay checks the token's audience and email). Nobody else may impersonate
  it.
- Service account `relay-smoke@otterware.iam.gserviceaccount.com`: the smoke test's identity.
- Workload Identity pool `github`, provider `otter-mail`: GitHub Actions in
  `otterware-app/otter-mail` (only) may mint `relay-smoke` ID tokens and publish to `gmail-push`. No
  service account keys exist.
- Push subscription `gmail-push-relay` → `https://relay.mail.otterware.app/push/gmail`, OIDC
  token with that URL as audience; 10 minutes retention (a missed notification only delays a
  sync: the app still polls every few minutes).

Secrets: `BETTER_AUTH_SECRET` (also keys Gmail token sealing), `GOOGLE_GMAIL_CLIENT_SECRET`
(the current Web client, `GOOGLE_GMAIL_CLIENT_ID`), and the original
`GOOGLE_WEB_CLIENT_SECRET` (the previous Web client, `GOOGLE_WEB_CLIENT_ID`).
Locally, put them in `.dev.vars` (gitignored). Preserve both original secrets.

The original `otter-mail` project remains active for existing Google grants and installed
apps. Google refresh tokens belong to their issuing OAuth client. Sealed web grants record
that client; grants without a client field use the original Web client. Native apps retain
their original credentials when refreshing existing grants. New sign-ins use `otterware`.
`/v1/me` retains the original `pushTopic` for older apps and adds `pushTopics`, indexed by
the Google project number. Updated apps select the topic for their grant; Gmail requires the
watch topic to belong to the OAuth client's project. Both projects' authenticated push
subscriptions deliver to the same relay, which accepts exactly their two service accounts.
Do not delete the old clients, topic, subscription, or signing account while old grants exist.

## Microsoft setup (Outlook)

One app registration in Microsoft Entra (portal.azure.com → App registrations) serves the web
app through the relay; the desktop app may use the same one or its own.

- **Supported account types:** accounts in any organizational directory and personal Microsoft
  accounts (`common`, which `MICROSOFT_AUTHORITY` in `packages/contracts/src/microsoft.ts` uses).
- **Platforms:** Web, redirect URI `https://relay.mail.otterware.app/v1/outlook/callback`
  (`http://localhost:8787/v1/outlook/callback` for `pnpm dev`); Mobile and desktop
  applications, redirect URI `http://localhost` (the desktop app's loopback sign-in).
- **API permissions:** Microsoft Graph, delegated, as `OUTLOOK_SCOPES`: `openid`, `email`,
  `profile`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
  `MailboxSettings.ReadWrite`, `Calendars.ReadWrite`.
- **Token configuration:** add the optional claim `xms_edov` to the ID token. A work account's
  `email` claim is whatever its admin typed; it proves the address only with `xms_edov` (the
  tenant verified the domain). Without it, a work mailbox links only when its address is the
  sign-in name (`preferred_username`). Personal accounts' `email` is Microsoft's own.
- **Certificates & secrets:** a client secret, as the Worker secret `MICROSOFT_CLIENT_SECRET`.
  It expires (24 months at most): rotate it before then.

Variables: `MICROSOFT_CLIENT_ID` (the registration's application ID; empty, the web app has no
Outlook and `/v1/me` says `outlook: false`), `MICROSOFT_CLIENT_SECRET`, and
`MICROSOFT_DESKTOP_CLIENT_IDS` (comma-separated: the desktop and iPhone apps' client IDs, when
they differ, so their ID tokens can link mailboxes). `MICROSOFT_JWKS_URL`,
`MICROSOFT_TOKEN_URL` and `MICROSOFT_GRAPH_URL` exist for the tests only.

## Shared identity service

Production authentication is owned by [Otter Accounts](https://github.com/otterware-app/otter-accounts),
with a dedicated Worker and D1 database at `accounts.otterware.app`. The relay keeps legacy
Mail auth URLs working through the private `ACCOUNTS` service binding (`MailIdentity` entrypoint).
`IdentityLifecycle` handles session disconnects and account deletion in Mail. Mail's Google Gmail
permissions, sealed refresh tokens, profiles and application data remain here. See
[shared identity](../../docs/shared-identity.md) for the compatibility and rollout details.

`pnpm dev` generates a standalone local config without the production service binding; its
local database and fake/developer identities remain independent of production Accounts.

## Verified iPhone APNs

`PUT /v1/push/device` replaces the authenticated session's token/topic/environment, Off/Inbox/All
mode and list of already-linked Gmail, Outlook or IMAP mailboxes. `DELETE` removes that device.
Other-user/unlinked mailboxes, unsupported topic/environment combinations, and extra content or
credential fields are rejected. `push_devices`, `push_mailboxes` and `push_revocations` contain
routing/lifecycle metadata. The provider grants below are an explicit addition to the original
device-only privacy model; none is a server mail cache or enrichment proxy.

`GET /v1/notification-connections` returns the account's connection status and configured providers,
never credentials. `POST /v1/notification-connections/authorize` starts a limited Gmail/Outlook
OAuth grant for an already-linked mailbox. A single-use, ten-minute PKCE request binds the mailbox,
user and originating Otter session; revocation/unlink wins an in-flight exchange. Gmail reuses the
registered `/v1/gmail/callback` URL, with a different state-signing key/audience than normal web
sign-in. Outlook returns to `/v1/notifications/callback`. Native callbacks contain only success/error;
web/desktop popups contain no tokens. The provider's profile must match the chosen mailbox.
`PUT /v1/notification-connections/imap` explicitly accepts the local IMAP password and matching
server settings. A public TLS/STARTTLS IMAP server is required. Remote settings edits cannot
redirect a previously stored password to another host. `DELETE /v1/notification-connections/:email`
deletes credentials, pending authorization and delivery state, and stops the watcher.

`notification_connections` holds AES-GCM encrypted credentials under
`NOTIFICATION_CREDENTIAL_SECRET`, with user/mailbox/provider bound into the encrypted claims.
A generation/CAS check prevents refresh/removal races from restoring an old grant. Actual Gmail
scopes are checked at exchange and each refresh: `gmail.metadata`, identity scopes only; broader
grants are rejected. The reader requests message IDs, labels and history, not sender/subject headers.
The permission itself can read headers. Outlook uses a **separate** Entra application with
`Mail.ReadBasic` and `User.Read`, not the application's full-mail client: Microsoft refresh tokens
can acquire other permissions previously consented to that same app. IMAP passwords generally
permit content access, even though the watcher requests only UIDs, flags, INTERNALDATE and
Message-ID; only its deduplication hash is persisted.

One `NotificationMailbox` Durable Object serializes each user/mailbox's provider work. It stores
only cursors, deduplication IDs/hashes and a durable outbox. Gmail `messageAdded` history uses a
persisted pre-change cursor; watch ending IDs never become starting baselines. Initial/stale
history rebases do not announce old mail. Outlook tracks immutable IDs and received dates.
IMAP uses bounded inbox IDLE cycles, read-only EXAMINE/FETCH, UIDVALIDITY baselines and rotating
batches for other eligible folders; old copies/moves are excluded by hashes and arrival dates.
Gmail watches and Outlook subscriptions renew on the server. A five-minute reconciliation catches
missed Google/Microsoft events; a revoked grant stops reading and asks for reauthorization.
Watchers pause when no enabled, unexpired, authorized APNs devices remain. IMAP IDLE requires a
live outbound TCP connection and incurs Durable Object duration charges while active.

Raw Pub/Sub and Graph events still authenticate and fan out over WebSocket. They never directly
submit an alert. Only verified arrivals enter UserHub's durable five-second coalescing window,
with a 30-second mailbox cooldown and separate receipt namespace from legacy Gmail history IDs.
Before APNs, ownership/session/settings and the message's **current** unread/folder state are
checked again. Inbox and All devices retain their own eligible selection during mixed bursts.
Retries are bounded; errors log category/status only, never provider responses or credentials.
Token transfer/rotation is atomic. Unlink/account deletion cascades credentials and routes;
legacy auth hooks and central Accounts `IdentityLifecycle.disconnect` remove revoked routing.

The APNs allowlist is “New mail. Open Otter Mail to read it.”, normal sound and
`otter: {version:2,userId,email,provider,historyId,messageId,mode}` (IMAP also has folder/UIDVALIDITY).
No sender, subject, preview, body, attachment, provider token or unread badge is sent to Apple.
The existing application topic, `mutable-content: 1`, alert push type, priority 10, per-mailbox
collapse ID and expiration 0 remain. The phone fetches/enriches directly from its provider.
A generic fallback is now a confirmed arrival, rather than an arbitrary change. An ordinary
extension still cannot recall an accepted alert: read/Off/sign-out after submission or phone
network/credential/timeout failures may leave a generic **new-mail** notification. No restricted
Apple filtering entitlement is needed. See [phone behavior](../../apps/ios/README.md#verified-background-notifications).

### Provider grant configuration

Set `NOTIFICATION_CREDENTIAL_SECRET` to a dedicated random secret using the `cf` CLI, never a
tracked file. For local `DEV_DEMO` only, the auth secret can supply the encryption key. Existing
Google web client/secret and `/v1/gmail/callback` issue the separate metadata-only grant; optional
`NOTIFICATION_GOOGLE_CLIENT_ID` / `NOTIFICATION_GOOGLE_CLIENT_SECRET` select a dedicated web client
with that callback. `NOTIFICATION_GOOGLE_PUSH_TOPIC` can override the matching project's topic;
otherwise current/legacy topics are selected by client project number. Do not delete the legacy
Google client/topic while it is used. Server-side metadata remains a Google restricted scope;
complete applicable OAuth verification/security assessment requirements for public distribution.

Create a separate Microsoft app registration (accounts in any directory + personal accounts),
with only delegated `User.Read`, `Mail.ReadBasic`, identity scopes and `offline_access`. Web redirects:
`https://relay.mail.otterware.app/v1/notifications/callback` and
`http://localhost:8787/v1/notifications/callback`. Configure
`NOTIFICATION_MICROSOFT_CLIENT_ID` / `NOTIFICATION_MICROSOFT_CLIENT_SECRET`; the service rejects the
full-mail app's client ID. Rotate the secret before its expiry. Corporate tenant policies may
require administrator consent. Keep the existing full-mail registration untouched.

For local protocol tests only, `NOTIFICATION_IMAP_TEST_TARGET` permits the exact synthetic
host/port and bypasses TLS for that fixture. Never set it in a deployed environment. Likewise,
`NOTIFICATION_GOOGLE_API_ORIGIN`, Google/Microsoft token/Graph overrides and `APNS_TEST_ORIGIN`
are only test transports. Production connections never accept client-supplied API origins.

Configure Apple without committing keys:

```sh
# From infra/relay, for the intended environment; do not run as part of a code-only task.
pnpm dlx cf@latest auth whoami
CLOUDFLARE_ACCOUNT_ID='<account-id>' pnpm dlx cf@latest workers secrets bulk \
  --worker otter-mail-relay --file /secure/path/to/apns-secrets.json
```

`cf` and Wrangler have separate login state. Create the input file outside the checkout,
restrict it to the owner (`chmod 600`), and delete it after uploading. Its format is:

```json
{
  "secrets": {
    "APNS_TEAM_ID": { "name": "APNS_TEAM_ID", "type": "secret_text", "text": "<team-id>" },
    "APNS_KEY_ID": { "name": "APNS_KEY_ID", "type": "secret_text", "text": "<key-id>" },
    "APNS_PRIVATE_KEY": {
      "name": "APNS_PRIVATE_KEY",
      "type": "secret_text",
      "text": "<complete PKCS#8 .p8 contents with JSON-escaped newlines>"
    }
  }
}
```

The bulk patch preserves secrets not named in the input. Pass the file path, never secret
values in command arguments or logs. Retain the original `.p8` in secure signing storage.

Use an Apple APNs ES256 signing key for team `838JVGY7W4` authorized for both allowed topics
(or separate configured deployments/keys for a restricted topic key). `APNS_PRIVATE_KEY` is the
PKCS#8 `.p8` contents; this is **not** the App Store Connect upload key. Keep key ID/team ID in
Worker secrets too. Allowed topics are `APNS_SANDBOX_TOPIC=dev.otterware.mail.dev` and
`APNS_PRODUCTION_TOPIC=dev.otterware.mail` in `wrangler.jsonc`. Do not substitute the extension
bundle ID. Local optional variables are listed in `.dev.vars.example`; missing signing
credentials return 503 on registration, leaving the phone's local notification behavior.

Provider JWTs are reused for 50 minutes. APNs 410/BadDeviceToken/DeviceTokenNotForTopic removes
only the failing registration, without deleting a newer rotation (or a registration newer than
Apple's 410 timestamp). Network/429/5xx and an expired provider JWT retry with durable delays,
at most three attempts, with per-session receipts avoiding resending to successful recipients.
5xx retries wait at least 15 minutes; excessive provider-token updates wait 20 minutes.
Other rejections are not retried; only HTTP status is logged, never a token, key, response text
or payload. Receipt/marker dedup is best effort: an ambiguous transport failure or crash after
Apple accepted a request can still duplicate an alert. Collapse IDs coalesce pending pushes;
they cannot provide transactional exactly-once presentation.

The Workers HTTPS `fetch` transport is used; `node:http2` is a nonfunctional Workers stub.
Local workerd/Node mocks do not prove Apple's HTTP/2 connection or live delivery. Verify real
sandbox and TestFlight production delivery after provisioning. Never configure
`APNS_TEST_ORIGIN` in a deployed Worker: it exists only for the local mock test server.

`pnpm test` tests actual workerd/D1 routing, user isolation, token transfer, sign-out/revocation/
delete/unlink cleanup, burst dedup and Off changes before an alarm fires, plus SQLite lifecycle
races, APNs payload privacy, signed headers, response classification and invalid-token safety.
No Apple/Google credentials are needed. Apply D1 migrations before enabling this build; deploy
and release are separate operator actions.

Official references: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns),
[APNs errors](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns),
[Workers stub modules](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules).
