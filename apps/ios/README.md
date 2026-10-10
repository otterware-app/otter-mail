# Otter Mail for iPhone

A native SwiftUI app (iOS 27, Liquid Glass), the sibling of the Mac and web apps (`apps/desktop` and
`apps/web`, one TypeScript app). It shares their Otter account, mailboxes, themes and settings, not
their code.

## Design

- **ChatGPT's frame.** The mail list is the page; a swipe from the left (or a tap on its title)
  slides it aside to show the drawer: a page per mailbox (All first) that you swipe through, as on
  the desktop, each with its folders and labels, then Compose and Settings. Settings is ChatGPT's grouped sheet.
- **The desktop's rows.** Who and when, the subject, a line of the latest message; the mailbox's dot
  in All mailboxes. Swipe for read, archive and trash; long-press for the rest.
- **iOS's own bars.** The list's bottom bar has compact search and agent buttons on the right; Compose lives in the
  sidebar. The reader has compact glass buttons for Archive and Trash on the left and Reply on the right.
  Tap Reply for the sender, or hold it for Reply, Reply all and Forward.
- **Every theme.** The themes are the desktop's (`Resources/Themes.json`), light and dark, blended
  the same way (`Theme/Theme.swift`).
- **App icons.** Appearance has an independent icon picker for the seven built-in palettes.
  UIKit remembers the choice on this iPhone. `pnpm icons:themes` exports the alternate icons and
  their previews from the existing brand artwork, together with the Mac and web variants.

## How it works

Like the Mac app, the phone signs in to Google and Microsoft itself and talks to Gmail and
Microsoft Graph directly, and to IMAP and SMTP servers directly too (`docs/imap.md`,
`docs/outlook.md`). Full device grants stay on-device. Explicit background-notification connections
add limited server grants (or an encrypted IMAP password), while mail content still loads directly.

- `Account/GoogleAuth.swift`: Google sign-in per mailbox with the otterware project's "iOS" OAuth
  client (no secret; PKCE; Google returns to the client ID's reversed form). Refresh tokens stay in
  the Keychain.
- `Account/MicrosoftAuth.swift`: Microsoft sign-in per Outlook mailbox (work, school and
  personal), the same app registration as the relay's, as a public client: PKCE, Microsoft
  returning to `msauth.<bundle id>://auth`. The address is Graph's `/me` `mail` (else the sign-in
  name). Microsoft rotates refresh tokens: each refresh keeps the new one in the Keychain.
- `Account/Relay.swift`: the Otter relay (`packages/contracts/src/relay.ts`). Signing in hands it
  the Google ID token (the relay accepts the iOS client's, see `GOOGLE_IOS_CLIENT_ID`); then the
  linked mailboxes, the preferences, and the `/v1/events` socket while the app is open.
- `Account/Session.swift`: the demo or the signed-in account, and keeping it in step: mailboxes
  linked on any device show here (signed out until this phone signs in to them), preferences sync
  both ways under the other apps' keys (`ui` and `settings` sections), relay events trigger syncs.
- `Mail/MailSync.swift`: sync, local-first: cached on disk, changes shown at once then written
  through the mailbox's `MailProvider` (`Mail/MailProvider.swift`, core's provider seam).
- `Gmail/`: the Gmail provider: the Gmail API (`GmailAPI.swift`), messages out (`MIME.swift`),
  history-based sync; `users.watch` is renewed daily so pushes reach the relay.
- `Outlook/`: the Outlook provider (`OutlookProvider.swift`), through Microsoft Graph
  (`GraphAPI.swift`: immutable ids, 4 requests in flight, Retry-After, `$batch`). Folders and
  categories are labels with core's ids (`OutlookFolders.swift`); threads are conversations, read
  whole when any of their messages changes; each followed folder has a delta (the inbox, Sent and
  Drafts, then folders once opened). Bodies and files come from the MIME source
  (`MIMEParser.swift`); writes are PATCHes and moves, replies `createReply`, drafts updated in
  place; search is Outlook's KQL (`OutlookSearch.swift`). A Graph subscription points at the
  relay, so its `mail` events sync the mailbox while the app is open.
- `Imap/`: the IMAP provider (`ImapProvider.swift`): folders as labels, flags, UID/CONDSTORE sync,
  IDLE on the inbox while the app is open. Its IMAP and SMTP clients run over Network.framework
  with the system's TLS (`MailSocket.swift`; STARTTLS goes through `URLSessionStreamTask`, which
  can start TLS mid-connection). `MailDiscovery.swift` finds the servers for an address (known
  providers, then Thunderbird's autoconfig, then the domain's MX host). The password stays in the Keychain; the settings
  follow the Otter account. Debug builds trust any certificate from localhost, to test against
  GreenMail or Dovecot in Docker.
- `Agent/`: OpenRouter (`OpenRouter.swift`) connects to the relay's AI SDK agent; its key and
  chats stay on the server. `AgentMailTools.swift` executes mail tools through `MailStore`,
  with approvals in the chat. Hermes (`Hermes.swift`) connects to the user's agent server;
  its settings and sealed key follow the Otter account. Both share the `assistant` settings
  section with Mac/web. The Mac's local Codex and Claude providers are omitted.
- `Mail/`: the model and `MailStore`, which screens render from. `DemoMail.swift` loads the demo.
- `Home/`, `Reader/`, `Compose/`, `Settings/`: the screens.

Also: Apple's on-device Translation (on request, or automatically for languages you don't read),
background refresh with notifications (Settings › Notifications) and the unread badge,
attachments in Quick Look, one-click unsubscribe, and signatures edited as Gmail keeps them.

## Running

```sh
pnpm dev:ios               # build, then run in the simulator (production relay)
pnpm dev:ios --relay local # against `pnpm dev`'s relay on :8787
```

Or open `OtterMail.xcodeproj` in Xcode (27 or later). The welcome screen offers the demo mailbox,
the same pretend mail as `pnpm dev:fake`; build and test against it rather than real accounts.

Debug builds are `dev.otterware.mail.dev`, release builds `dev.otterware.mail`. The Google "iOS"
client is registered for the former. The project signs with team 838JVGY7W4; to run on your
iPhone, pick it in Xcode, or from the command line:

```sh
xcodebuild -project apps/ios/OtterMail.xcodeproj -scheme OtterMail -destination 'platform=iOS,id=<udid>' \
  -derivedDataPath apps/ios/.build -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <udid> "apps/ios/.build/Build/Products/Debug-iphoneos/Otter Mail.app"
```

(`xcrun devicectl list devices` gives the UDID. Without an Apple account signed in to Xcode, add
`-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID` with an App Store Connect
API key.)

Unit tests (`OtterMailTests`, Swift Testing) run in the simulator:

```sh
xcodebuild -project apps/ios/OtterMail.xcodeproj -scheme OtterMail -destination 'platform=iOS Simulator,name=iPhone 17' test
```

Shipping: the Release iPhone workflow builds and uploads to TestFlight (`pnpm release:ios` does
the same from a Mac); see `docs/release.md`. The app has its own version, `MARKETING_VERSION` in
the Xcode project, apart from the Mac app's.

`Resources/Themes.json` and `Resources/DemoMailboxes.json` are exported from `packages/shared` by
`pnpm ios:resources` (`dev:ios` and releases run it); rerun it after changing the palettes or the
demo mailbox.

## Verified background notifications

Gmail, Outlook and IMAP use one APNs pipeline. Background alerts are an explicit, per-mailbox
connection to the Otter account (Settings → Mailboxes → the mailbox → Background notifications).
New Gmail and Outlook mailbox setup offers the additional limited provider consent as part of
setup. IMAP asks explicitly before storing its password with Otter. The existing device sign-in
continues to read mail directly; connecting notifications does not replace it or transfer full
Gmail/Microsoft grants between devices. A server connection is shared by the account's devices.

The relay verifies a new message and its current unread/folder state **before** submitting an
alert, and rechecks just before APNs. Read/archive/label changes, watch renewal, initial sync and
an unconnected mailbox do not create alerts. Inbox admits unread inbox arrivals; All also admits
unread arrivals elsewhere, excluding sent, drafts, junk and trash. Account/device settings use the
more restrictive filter. Off stops future submissions once the relay receives the change.

APNs carries only a generic “New mail. Open Otter Mail to read it.” alert, normal sound, and
allowlisted user/mailbox/provider/message identifiers. It carries no sender, subject, preview,
message body, attachment, provider credential or unread badge. The embedded
`OtterMailNotificationService` fetches the indicated message **directly from Gmail, Microsoft
Graph or the IMAP server**, then adds sender, subject and a bounded preview locally. The event's
ending marker is never used as a history baseline. Version 1 compatibility retains the older
on-device history reader; the new relay never submits unverified version 1 change alerts.

The generic fallback now corresponds to a verified arrival. It remains if the phone is offline,
Google/Microsoft access was revoked, the IMAP UIDVALIDITY changed, credentials are locked, or the
22-second deadline expires. Ordinary extensions cannot suppress an accepted alert: mail read on
another device after submission can still appear, and APNs/extension execution are best effort.
No restricted Apple filtering entitlement is required. Foreground generic alerts are suppressed
by the supported presentation delegate. Local alerts are disabled only for mailboxes connected
to this push pipeline, so a second background/local alert isn't generated for the same arrival.
Unconnected mailboxes keep local notification behavior.

Gmail's server grant is limited to `gmail.metadata`; the reader requests only message IDs,
labels and history. This permission can also read headers, but the notification service does not
request sender/subject headers or content. Google's actual granted scopes are checked at exchange
and on every refresh; broader grants are rejected. The existing Google web client/registered
callback can issue this separate limited grant. Outlook uses a separate Microsoft app registration
with `User.Read`, `Mail.ReadBasic` and `offline_access`; it cannot share the full-mail application's
refresh-token authority. IMAP credentials normally authorize mailbox content even though the
watcher reads UIDs, flags, INTERNALDATE and Message-ID (stored only as a deduplication hash).
Server credentials are encrypted at rest under a dedicated Worker secret. No server mail cache,
body download or notification-enrichment proxy is added. Disconnecting notifications deletes the
grant and stops its watcher; unlink/account deletion cascades deletion. Revoked/expired Otter
sessions lose device routing; a watcher pauses when no enabled authorized devices remain.

The server renews Gmail watches and Outlook subscriptions, so renewal no longer depends on
opening the phone within seven days. A five-minute reconciliation also catches dropped provider
events. IMAP uses bounded IDLE cycles for the inbox; other eligible folders are scanned in rotating
batches. UIDVALIDITY rebases never announce old mail. Message-ID hashes and arrival dates prevent
ordinary copies/moves from becoming new-mail alerts. Alerts coalesce in five-second bursts, with
at least 30 seconds between submissions per mailbox and bounded transient-error retries.
Subscriptions, grants and device sessions can still expire or be revoked; reconnect when Settings
says authorization is required. Opening the app always syncs directly from the provider.

`NotificationShared/` contains the direct readers, coordinated OAuth refresh, shared Keychain and
App Group configuration. Existing Google/Microsoft refresh tokens and IMAP passwords migrate by
copy/verify/delete from the original private Keychain group. Shared provider secrets and access
tokens use `AfterFirstUnlockThisDeviceOnly`: enrichment can work on a locked phone **after the
first unlock since reboot**, and falls back before that. Otter session credentials stay private to
the app. Cross-process locks serialize refresh; removal/replacement checks prevent an in-flight
refresh from restoring deleted credentials. Debug/release storage, topics and tokens are separate.

Enriched Gmail/Outlook taps open the mailbox/conversation, fetching it directly if absent from the
cache. IMAP taps resolve the notified UID into its local thread, loading the folder if needed.
Generic taps open the mailbox and sync. Notification previews render Markdown as plain text and
keep link labels. The demo needs no Google, Microsoft, IMAP, Apple or Otter credentials.

### Apple setup and verification

Register App IDs for `dev.otterware.mail.dev` / `dev.otterware.mail` and their `.notifications`
extensions. Enable Push Notifications on the **app**, and App Groups/Keychain Sharing on both
app and extension. Provision both targets for their matching group:
`group.dev.otterware.mail.dev.notifications` (Debug),
`group.dev.otterware.mail.notifications` (Release). The app-private Keychain group stays first
for migration. The `APNS_ENVIRONMENT` build setting and signed `aps-environment` must match:
Debug `development` → sandbox; Release/TestFlight `production` → production. If signing with a
custom development profile, keep the plist environment consistent with that profile.

The shared App Group also grants Keychain access under its unprefixed group name. Keep only the
app-private prefixed group in `keychain-access-groups`; adding the App Group there fails signed
archives against the profiles' prefixed Keychain allowlist. Google token queries select the App
Group explicitly, while existing Otter sessions remain in the app-private default group.

Regenerate the main App Store profile with the new capabilities, and add the extension's
“Otter Mail Notifications App Store” profile. The release workflow also needs
`IOS_NOTIFICATION_PROVISIONING_PROFILE` (base64); see `docs/release.md`. Configure the relay's
APNs signing key and allowed topics as described in `infra/relay/README.md`. The APNs key is
separate from the App Store Connect upload key; never put either in this checkout.

Run the normal Xcode build and `OtterMailTests`, including `NotificationTests` (history paging,
labels, rebase, failures, cancellation and the completion race). Check the demo in light/dark.
For a signed-in test account, permit notifications and test Inbox/All/Off, locked-device
arrival, multiple mailboxes, a generic tap and a thread absent from the local cache.

A simulator payload can exercise display/tap wiring:

```json
{
  "aps": {
    "alert": {
      "title": "Otter Mail",
      "body": "Mailbox updated. Open Otter Mail to check your mail."
    },
    "mutable-content": 1
  },
  "otter": {
    "version": 1,
    "userId": "<test-account-id>",
    "email": "<test-mailbox>",
    "historyId": "<new-change-marker>",
    "mode": "inbox"
  }
}
```

Save it outside the repository and run `xcrun simctl push booted dev.otterware.mail.dev <payload>`.
Payload injection does **not** prove live APNs, or that the service extension ran/fetched Gmail
on that simulator. Verify live sandbox delivery on a provisioned iPhone and production delivery
in TestFlight. Use a test Gmail, with a baseline established by opening/syncing before sending
new mail. Validate timeout/offline fallback, token rotation, remote revocation/unlink and the
first unlock after reboot. CI's iPhone job builds the app and extension on the Xcode 27 runner,
runs the native tests and captures the demo in light/dark. Linux development cannot run these
checks locally. Live APNs, extension Gmail access and signed-in notification/tap/preference
checks still require a provisioned iPhone; CI's demo screenshots do not cover them.

Sources: [Apple extension requirements](https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications),
[Apple filtering entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.filtering),
[Keychain sharing](https://developer.apple.com/documentation/security/sharing-access-to-keychain-items-among-a-collection-of-apps),
[Gmail push/watch renewal](https://developers.google.com/workspace/gmail/api/guides/push),
[Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).
