# Runbook

How each part of Otter Mail gets from `main` to people, what to check, and what to do when it
breaks. The details behind each step are in `docs/release.md`, `infra/relay/README.md` and
`apps/ios/README.md`.

| Part           | Ships                       | You do                                 |
| -------------- | --------------------------- | -------------------------------------- |
| Web app, relay | on merge to `main`          | nothing                                |
| Mac, Linux app | when you run Release        | one click                              |
| iPhone app     | when you run Release iPhone | one click, then TestFlight / App Store |

## Web app and relay

Cloudflare Workers Builds deploys `site/` (the web app, https://mail.otterware.app) and `infra/relay`
(https://relay.mail.otterware.app) on every push to `main` that touches them. The relay's
database and secrets stay with the existing workers. The old mail site redirects to `.app`;
the old relay still serves installed apps. See [domain migration](domain-migration.md) for
the Google and GitHub settings that go with these URLs. D1 migrations run before deployment.

- **Check:** the commit's checks on GitHub ("Workers Builds: …"), or Cloudflare → Workers →
  the worker → Deployments. The relay smoke test (Actions → Relay smoke test) runs every 6 hours;
  run it by hand after a risky relay change.
- **Roll back:** Cloudflare → the worker → Deployments → pick the last good one → Rollback. Then
  revert on `main` so the next deploy doesn't bring it back. Migrations don't roll back: fix
  forward.

## Mac and Linux app

1. Actions → **Release** → Run workflow → `patch`, `minor` or `major` (or
   `gh workflow run release.yml -f bump=minor`).
2. It builds arm64 (Apple Silicon), signs with the Developer ID, notarizes, builds the Linux
   .debs (x64, arm64), publishes one GitHub Release and bumps the version on `main`.
3. Installed apps update themselves ("Restart to update" in the sidebar).

A changelog note is not part of a release. When you want one, it can land on `main` before or
after (`changelog/<version>.md`, the `write-changelog` skill); the site shows it once that version
is out, and the GitHub Release carries it too, above the generated notes (the Release workflow adds
it, or the Changelog notes workflow once it lands after the release).

- **Check:** the run is green and its log says "macOS signing and notarization enabled." (not
  "Building UNSIGNED").
- **Bad release:** release a fixed `patch`. To stop it spreading first, edit the GitHub Release
  and untick "Set as the latest release" (apps update from the latest one).
- **Signing fails:** the secrets are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (see `docs/release.md`). The Developer ID certificate
  runs until 2031.

## iPhone app

Released on its own, with its own version (`ios-vX.Y.Z` tags), only when `apps/ios` or what it
bundles from `packages/shared` has changed. A Mac release doesn't need one.

1. Actions → **Release iPhone** → Run workflow → `patch`, `minor` or `major` (or
   `gh workflow run release-ios.yml -f bump=patch`). It builds `main` on GitHub's `xcode-27`
   runner and uploads it (about 10 min), then tags the commit and bumps the version on `main`.
   The same from this Mac, if GitHub is down: `pnpm release:ios` (needs Xcode 27 and
   `~/.otter-mail/signing`).
2. Apple processes it (10–30 min). The internal group **Otter team** gets it automatically.
3. External testers: App Store Connect → Otter Mail: Calm Email → TestFlight → **Testers** →
   Builds → + → pick the build. The first build of a new version goes through Beta App Review
   (about a day); later builds of that version don't. Public link:
   https://testflight.apple.com/join/KPpsSdgX
4. App Store (when a build is good): Distribution → the version → pick the build → **Submit for
   Review** (about a day), then release it.

- **Check:** App Store Connect → TestFlight shows the build as "Ready to Test" (or "Ready to
  Submit" for external groups).
- **Bad build:** TestFlight → the build → Expire Build. On the App Store there's no rollback: submit
  a fixed build (you can ask for an expedited review).
- **Check the run:** green, and nothing is tagged or bumped unless the upload succeeded, so a
  failed run can simply be run again.
- **Upload refused:** the error names the problem (icon, version already used, signing). The
  Apple Distribution certificate and the "Otter Mail App Store" profile expire 2027-09-29: make a
  new certificate in the developer portal, regenerate the profile with it, and update the
  `IOS_DISTRIBUTION_P12`, `IOS_DISTRIBUTION_P12_PASSWORD` and `IOS_PROVISIONING_PROFILE` secrets
  (and this Mac's keychain, for `pnpm release:ios`).
- TestFlight builds expire after 90 days.

## iPhone APNs signing and transport

Before enabling push, apply the relay D1 migrations and configure the APNs team/key/private-key
Worker secrets. Use application topics `dev.otterware.mail.dev` (sandbox) and
`dev.otterware.mail` (production), with matching signed APS environments. Provision the app and
its embedded notification extension with App Groups/Keychain Sharing. Release signing also
needs `IOS_NOTIFICATION_PROVISIONING_PROFILE` and a regenerated main profile; see
[Apple setup](../apps/ios/README.md#apple-setup-and-verification) and
[relay APNs configuration](../infra/relay/README.md#verified-iphone-apns).

Check live sandbox arrival on a provisioned iPhone and production in TestFlight, using a test
mailbox. Connect background notifications, open/sync, then background the app, send new mail, verify the sender and
preview and tap to the correct mailbox/thread. Check light/dark, two mailboxes, Inbox/All/Off,
label/read changes, locked device after first unlock, offline/timeout fallback, token
rotation, remote session revocation and unlink. Simulator injection only checks local payload/
tap flow; it cannot prove live APNs or extension network delivery. No exact badge is sent.
The server verifies arrivals and renews provider watches with the explicitly connected grant;
read/label changes alone do not generate alerts. The ordinary extension cannot suppress an
already submitted alert, so failed phone enrichment can leave the relevant new-mail fallback.
Without a server connection, Gmail watches still rely on a device renewing within seven days.
See [verified background notifications](#verified-background-notifications) for grant setup and checks.

## Accounts and access

- **Apple:** team 838JVGY7W4 (chris.kafrouni@gmail.com, Account Holder). App Store Connect app 6817249947. The API key in `~/.otter-mail/signing` has the Developer role: it uploads builds but
  can't create App IDs, profiles or review submissions (do those in the browser).
- **Google Cloud:** project `otter-mail`. Until Gmail access is verified, only accounts listed as
  test users (Google Auth Platform → Audience, 100 max) can sign in. See
  `docs/google-verification.md`.
- **Cloudflare:** the `otter-mail-relay` and site workers.
- **Back up `~/.otter-mail/signing`** (a password manager works). Losing it means new
  certificates and keys from Apple's portals.

## Verified background notifications

Before merging a notification-service change, confirm the dedicated
`NOTIFICATION_CREDENTIAL_SECRET` and separate Outlook notification app ID/secret are configured
on `otter-mail-relay`. Use `pnpm dlx cf@latest auth whoami` first; `cf` and Wrangler have separate
logins. Preserve the existing Workers Builds deployment script: it applies D1 migrations on merge,
including the notification credential/authorization tables and the NotificationMailbox DO binding.
See [provider configuration](../infra/relay/README.md#provider-grant-configuration).

After deployment, connect a dedicated demo mailbox using the app's limited consent. Verify that
full-mail grants are rejected, status becomes ready, and read/label-only events do not submit
APNs. Exercise Off / Inbox / All, a read during coalescing, mixed inbox/non-inbox arrivals, unlink,
remote session revocation, token rotation and reconnect. Test Google/Microsoft expiry and IMAP
UIDVALIDITY/copy behavior. Use only the demo fixtures for mail; never log credentials or fetch
private users' mail to diagnose push. D1 holds encrypted credentials and routing/cursors, not mail.

Check signed iPhone delivery and taps while locked after first unlock. Generic text must describe
confirmed new mail; offline/timeout/expired phone credentials can prevent preview enrichment.
Simulator injection checks local presentation/tap flow, not live APNs or extension networking.
The app list cache still synchronizes from the provider; alert enrichment is not a whole-inbox
background sync. APNs is best effort and cannot recall an already submitted alert.

A stopped connection appears in Settings → Mailboxes → Background notifications. `reauthorize`
needs user consent/password again; `retry` backs off transient failures. Check OAuth client-secret
expiry, registered redirect URLs, server granted scopes and subscription renewal when investigating.
Do not solve an enrichment problem by adding a server mail cache or proxy. Disconnecting deletes
that account/mailbox's credential and delivery state. If a provider cannot be reached, preserve its
cursor and avoid submitting speculative alerts.
