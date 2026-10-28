# Todoist feature boundary

Todoist is optional and device-local. It does not own mailbox sync, mail storage, Otter account
preferences, or relay data. Removing it requires no mail database migration. Todoist requests start when the user connects or opens its task features. Email data is sent
only when the user explicitly creates an email task (title, entered notes and conversation link).

## Owned modules

- `apps/web/src/main/integrations/todoist/`: all Todoist renderer UI and its API client.
  `index.ts` is the app-facing entry point: dialogs, email capture, browsing, settings.
  `api.ts` sends only `todoist:*` IPC calls; Todoist methods do not live in `mailApi`.
- `packages/contracts/src/todoist.ts` and the `./todoist` package export: input schemas and types.
- `packages/core/src/handlers/todoist.ts`: the feature's complete IPC registration.
- `packages/core/src/services/todoist.ts`, `todoist-auth.ts`, and their tests: API, safe
  mutation retries, PKCE, and token refresh. Mail access is limited to validating the chosen
  email and building its link. There are no scheduled Todoist background jobs.
- `apps/desktop/src/services/todoist-oauth.ts` and its test: temporary loopback callback.
- `apps/web/src/web/todoist-auth.ts`, `todoist-callback.ts`, and
  `apps/web/todoist-callback/`: browser popup and dedicated callback page.
- `apps/web/src/web/demo/todoist.ts`: fake Todoist service and device-local demo state.

`apps/web/src/lib/ipc.ts` is shared transport used by Gmail and Todoist. It contains no
Todoist logic and stays when the feature is removed. The normal Platform secret store, UI
primitives and task-event transport are also shared infrastructure.

## App entry points

The only renderer consumers of the feature's public entry point are `home-view.tsx`
(the global dialogs), `message-reader.tsx` (toolbar/menu), `message-list.tsx` (context menu),
`command-palette.tsx` (browse command), and `settings/settings-page.tsx` (settings pane).
Settings navigation, router validation, search entries and `SettingsPane` declare the
`integrations` settings route, which currently hosts only Todoist.

Backend startup registers `registerTodoistHandlers` in `packages/core/src/index.ts`.
`Platform.todoistSignIn` is implemented in the two platform files. Web popup routing is explicitly
named `todoistSignIn` in `web/protocol.ts`, `backend.ts`, and `bridge.ts`; it is not part of Google
sign-in. The demo fetch dispatcher installs the fake in `web/demo/gmail.ts`.

The web build's `todoist-callback` input and `site/scripts/build.ts` copy rule ship the OAuth
callback. The feature adds no relay endpoints, OAuth secrets in the build, or iPhone code.

## Removing Todoist

1. Remove the five renderer entry points listed above, then delete the renderer feature folder.
   Remove the `integrations` route/nav/search/type entries if no other integration uses that pane.
2. Remove startup's handler registration, the Todoist handler/services/tests, and the contract
   file/package export. Keep shared IPC and secret storage.
3. Remove `Platform.todoistSignIn`, both platform implementations, the desktop OAuth service/test,
   and the web `todoistSignIn` page-request/bridge routing and popup module.
4. Remove the callback page/script, its Vite build input, and the site copy rule.
5. Remove the fake service and its demo-fetch dispatch, plus Todoist's feature matrix section.
6. Run `rg -n -i todoist apps packages site docs` to check for remaining wiring. Run typecheck,
   lint, formatting, tests and a demo mailbox smoke test; build the site so a stale callback
   asset cannot mask a missing build reference.

## Stored state and external access

Production credentials use only three secret-store keys: `todoist-token`, `todoist-oauth`,
`todoist-client`. Normal Disconnect deletes the first two; the last caches public client
registration metadata. For complete removal, delete all three through `Platform.secrets.delete`
in a one-time cleanup before removing the feature (or leave these inert values until the
profile is cleared). Do not remove the shared secrets file or encryption key.

Demo state uses only `demo-todoist.json`. It is safe to remove that file independently of mail.
Query-cache keys and events are prefixed `todoist`; they are in-memory only. API tasks are not
copied into the mail database or synchronized through the relay.

Disconnect/removal does not delete users' tasks or revoke the authorization in Todoist itself.
Users can revoke Otter Mail from Todoist's integration settings. Existing task links continue to
open conversations through the normal mail route after the feature is removed.
