# Otter Mail's domain and repository

Otter Mail moved on 30 September 2026 to `mail.otterware.app`, with its relay at
`relay.mail.otterware.app` and its repository at
https://github.com/otterware-app/otter-mail. The root Otterware website is a separate project.

## Cloudflare

Both domains use the existing `otter-mail-site` and `otter-mail-relay` workers in the same
Cloudflare account. Their Wrangler configurations are the source of truth for the custom
domains. Cloudflare creates their DNS records and TLS certificates. D1, Durable Objects,
`BETTER_AUTH_SECRET` and `GOOGLE_GMAIL_CLIENT_SECRET` are retained: changing the auth secret
would invalidate sessions and sealed Gmail refresh tokens.

The site returns a permanent **308** redirect from every `mail.otterware.dev` URL to the
same path and query string on `https://mail.otterware.app`. Its Worker runs before static
assets so `/app`, `/privacy/`, `/terms/`, asset URLs and unknown paths all redirect too.

Keep `relay.mail.otterware.dev` serving the relay directly. Installed Mac and iPhone versions
use it for bearer-token requests and WebSockets; an HTTP redirect is not a replacement for
that compatibility endpoint. New builds use `.app`. Keep renewing the old domain and
retaining its DNS and certificates while these clients remain in use.

The new relay configuration uses `.app` for `BETTER_AUTH_URL`, `APP_ORIGIN`, `COOKIE_DOMAIN`
and `PUSH_AUDIENCE`. Local development still overrides these settings with localhost URLs.

## Google Cloud

The domain migration retained the `otter-mail` project and its OAuth client IDs.
The later move to `otterware` keeps those clients for existing grants; see
[Google OAuth verification](google-verification.md) and [relay setup](../infra/relay/README.md#google-cloud-setup-project-otterware-number-997327858649).
For the original Google Auth Platform's
**Otter Mail - Web** client, retain the old URLs and localhost entries and add:

- JavaScript origin: `https://mail.otterware.app`
- Redirect URI: `https://relay.mail.otterware.app/v1/auth/callback/google`
- Redirect URI: `https://relay.mail.otterware.app/v1/gmail/callback`

Branding still links `https://mail.otterware.dev`, `/privacy/` and `/terms/` there, which
redirect to Otter Mail's pages on otterware.app (the home page to `https://otterware.app/mail/`,
not the app). Move them to `https://otterware.app/mail/`, `/mail/privacy/` and `/mail/terms/`
once Google's data-access review is done: saving branding updates a pending verification
request. Authorised domains include both `otterware.app` and `otterware.dev`. Verify ownership of the new domain in Google Search Console with the
project owner's Google account, retaining the verification DNS record. Google's branding
and data-access reviews are separate from deploying the app; the previously approved
branding may remain visible until new branding is approved.

Pub/Sub subscription `gmail-push-relay` points to
`https://relay.mail.otterware.app/push/gmail`, with that same URL as its OIDC audience and
`gmail-push-relay@otter-mail.iam.gserviceaccount.com` as its signing identity. Wait for the
new relay's TLS certificate to work before moving delivery. If certificate propagation
is delayed, temporarily deliver to the old relay URL while using the new audience.

The GitHub Workload Identity provider `github/otter-mail` trusts repository ID `1295151462`
and owner ID `334293156`, rather than a name that could be reused. The `relay-smoke` service
account's Token Creator binding and the `gmail-push` topic's Publisher binding use
`attribute.repository/otterware-app/otter-mail`. Remove the old owner bindings after the
transfer. `pnpm --filter @otter-mail/relay smoke` verifies Google sign-in, Pub/Sub delivery,
the event WebSocket and account deletion using only the smoke-test service account.

## GitHub and releases

Transfer the existing repository rather than creating a replacement. Its repository ID,
history, releases, issues, pull requests and repository secrets stay with it. GitHub
redirects the old repository and release URLs, so installed apps can keep fetching updates.
Do not create another repository at `ckafrouni/otter-mail`, which would remove those redirects.
New release builds and links use `otterware-app/otter-mail`.

Install **Cloudflare Workers and Pages** in the new organisation with access to `otter-mail`
and finish linking that installation to the existing Cloudflare account. Reconnect both
workers' build configurations to the transferred repository, keeping their `main` branch,
deploy commands, path filters, build token and environment variables. A successful manual
deploy alone does not verify that pushes still trigger automatic builds.

Mac/iPhone bundle IDs, Keychain services, Google OAuth client IDs and Apple signing identities
remain unchanged. Native releases are separate from deploying the site and relay.

## What users experience

Old web links redirect automatically. Browser cookies, OPFS mail caches, sealed tokens and
local preferences belong to an origin and do not transfer between `.dev` and `.app`.
Users sign in to Otter and their Gmail mailboxes again on the new site; Gmail mail is
downloaded again, and Otter-synced mailboxes and preferences follow their account. Local
browser data still exists under the old origin; preserve any unsynced work before moving.
Native apps retain their local caches, credentials and sessions.

## Verification

- Check the app, `/app`, and the redirects of `/privacy/` and `/terms/` on the new host over HTTPS.
- Check old-host redirects with paths and query strings, including static asset URLs.
- Check a cookie-authenticated request's CORS origin and session cookie domain on the relay.
- Run relay tests and the production smoke test after changing push or GitHub trust settings.
- Check Cloudflare builds from the new GitHub organisation and both native release workflows.
- Run `pnpm typecheck`, `pnpm lint`, `pnpm fmt`, and test the web and iPhone demo apps.
