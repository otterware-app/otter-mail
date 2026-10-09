# Shared Otter identity

[Otter Accounts](https://github.com/otterware-app/otter-accounts) owns the shared Better Auth
identity at `https://accounts.otterware.app/v1/auth`. It has its own Cloudflare Worker and
D1 database; Mail retains only the local user profile needed by its application tables.
Discovery is at `/v1/auth/.well-known/openid-configuration` on Accounts.

Mail's existing Google identities, user IDs, session tokens, auth secret and signing keys
are preserved. Installed clients still call the Mail relay: its private `ACCOUNTS` binding
forwards auth requests and verifies API sessions. The relay's `IdentityLifecycle` RPC closes
revoked sessions' WebSockets and deletes Mail data when Accounts deletes an identity.
Neither RPC interface is exposed over public HTTP.

Mail browser sign-in uses the fixed `otter-mail` OIDC client with S256 PKCE, a host-bound
state cookie and the exact callback `https://relay.mail.otterware.app/v1/auth/callback/otter`.
The callback validates the ID token and sets the original Mail cookie for the central session.
Google's existing `/v1/auth/callback/google` registration remains: requests for new Accounts
flows redirect to Accounts, where Better Auth verifies the original host-bound state cookie.
Gmail mailbox authorization and sealed refresh tokens stay in the Mail relay.
Accounts' session answers name the account's sign-in methods (`google`, `microsoft`,
`password`); the relay passes them on in `/v1/me` (`RelayUser.signInMethods`), and the web
app adds the matching mailbox right after an Otter sign-in: Gmail for Google, Outlook for
Microsoft, none for a password alone.

Drive is the fixed first-party client `otter-drive`: authorization code + S256 PKCE,
exact redirects, and only `openid profile email`. Dynamic registration is disabled.
OAuth tokens cannot authenticate Mail API requests. Signing keys are encrypted in D1
with the existing Mail auth secret; retain that secret.

Drive's user ID is the same canonical Mail subject. The migration explicitly verifies
both existing identities and re-keys the Drive user and all references, including
sessions, ownership, attribution and API keys. It removes the old password identity.
Automatic account linking by email is disabled. A future Clerk integration can map
Clerk subjects to these stable Otter IDs without re-keying application data.

## Personal and shared drives

Drive no longer uses Better Auth organizations. `chris` becomes the personal drive,
`zentio` a shared drive, with the same IDs, slugs, documents, versions and R2 keys.
Folders nest recursively inside either drive. Shared drive invitations grant view or
edit access throughout the drive, including future subfolders. Owners manage invitations
and can transfer a shared drive to a signed-in collaborator. Each new verified Otter
identity gets its own private drive.

API keys belong to individuals. Migrated organization keys retain a scope limiting them
to their original drive subtree. Membership is checked on every API request, including
CLI requests; signed document previews also recheck access. Downloaded copies cannot be
revoked. Thumbnail capabilities expire within ten minutes, with five-minute private caching.
The old organization header and list endpoint remain read compatibility for installed CLIs.

## Sessions and deletion

Accounts uses host-only `__Host-otter-accounts.*` cookies. Mail cookies retain their
`mail.otterware.app` scope; Drive cookies are host-only. Never
broaden either to `.otterware.app`, which includes executable uploaded content.
The Mail web app starts its normal OIDC sign-in as it opens when it has no session, and the
Drive login page does when Accounts has one. otterware.app's nav checks Accounts too, to show
"Account" instead of "Sign in". The status check uses credentialed CORS restricted to those
origins and exposes no identity or token.

Both web apps' **Sign out of Otter** buttons navigate through exact-origin POST forms:
Accounts ends its browser session, the Mail relay clears its browser session and cookie,
then Drive clears its browser session and cookie. This also clears preserved legacy sessions
that predate Accounts. Every hop rejects untrusted origins; return destinations are fixed.
A failed hop stops with an error instead of reporting successful logout. Other browsers,
native Mail sessions, CLI sessions and API keys remain signed in.

Revoking a device session still sends signed OIDC back-channel logout to associated Drive
sessions. That notification is best effort if Drive is unavailable; explicit browser sign-out
also visits Drive directly, so it does not rely on notification delivery.

Issuing a Drive identity records an `identity_apps` link. The legacy Mail delete endpoint
refuses linked identities before removing any sessions. `/otter/account` requires a recent
sign-in, same-origin request and explicit confirmation. It sends a short-lived signed
request to Drive first. Drive refuses while the user owns documents or shared drives:
private documents must be deleted, and shared drives transferred or deleted first. Once
released, Drive atomically removes the user's folders, memberships, keys and sessions and
retains a subject tombstone. Documents in other people's shared drives remain. Mail then
removes the app link and identity. Retrying partial failures is idempotent.

## Moving to the independent Accounts service

The Accounts repo owns its deployment config, identity schema and tests. This repo owns
Mail's profile projection and lifecycle adapter. The Drive repo configures its issuer.
All three deploy separately; Otter Code still uses Clerk.

Pause relay account requests with `IDENTITY_MODE=paused` while copying the auth tables into
Accounts. Preserve auth secrets before import. Keep Accounts in `MAINTENANCE=true` until
counts and foreign keys match. Then enable Accounts, set the relay to `IDENTITY_MODE=accounts`,
and update Drive's issuer. Existing Mail sessions remain valid through the private binding.
Remove stale authentication rows from Mail after verification; do not remove its user profiles.
Do not roll back to the old identity database after the new service has accepted writes.

For standalone local Mail development and tests, `scripts/local-config.ts` removes the service
binding and selects the local identity implementation. Production always uses Accounts.

## Original Mail/Drive identity migration

1. Back up both production D1 databases privately and record Time Travel bookmarks and
   user/session/document/version/file/key counts. Exports contain authentication material.
2. Apply Mail's additive migrations and deploy the relay. Existing Mail clients keep working.
3. Prepare and test the Drive build before its maintenance window. Apply migrations 0005
   and 0006, then run its `admin:seed -- --remote --otter-subject VERIFIED_MAIL_ID
--link-existing` command after verifying both identities. The re-key is one transaction.
4. Record the existing user's Mail `identity_apps` link for `otter-drive`, then immediately
   deploy Drive. Migration 0006 replaces organization tables; the old Worker cannot serve
   that schema. Preserve both apps' existing auth and content-signing secrets.
5. Verify canonical IDs, ownership, counts, login, CLI credentials, key scope and membership
   revocation. Merge the tested commits and verify Workers Builds deployed those commits.

The Mail changes are additive and can be rolled back independently after Drive is no longer
using the issuer. Drive rollback requires coordinating the old Worker with the old schema;
do not simply redeploy it over the new database. Prefer a forward fix. A backup restore must
happen with writes paused and must account for any new data created since that backup.

## Local verification

Use separate local D1 databases. Set Mail's `BETTER_AUTH_URL`, `DRIVE_ORIGIN`, and Drive's
`OTTER_AUTH_URL` to their local origins, and adjust the local OAuth client's exact callback
and back-channel URL. Never add local or wildcard redirects to the production client.
Relay tests use a mock Google signer; Drive tests use a mock OIDC issuer, the real Better Auth
library and all SQL migrations. Ownership migration tests cover every user reference.
