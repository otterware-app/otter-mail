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

Like the Mac app, the phone signs in to Google itself and talks to Gmail directly, and to IMAP and
SMTP servers directly too (`docs/imap.md`); the relay never sees its mail, tokens or passwords.

- `Account/GoogleAuth.swift`: Google sign-in per mailbox with the otter-mail project's "iOS" OAuth
  client (no secret; PKCE; Google returns to the client ID's reversed form). Refresh tokens stay in
  the Keychain.
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
the same pretend mail as `pnpm dev:demo`; build and test against it rather than real accounts.

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

## Private Gmail push

`OtterMailNotificationService` is embedded in the app. Gmail → Pub/Sub → relay carries only
`emailAddress` and `historyId`. The relay submits an APNs alert titled “Otter Mail”, with
“Mailbox updated. Open Otter Mail to check your mail.” and version/user/mailbox/history/filter metadata.
The generic fallback is silent; confirmed eligible mail gains the normal sound locally.
No sender, subject, preview, body, attachment, Gmail access token or refresh token goes through
this push path to Otter or Apple. APNs has no unread badge. The extension fetches only added
messages' headers/preview **directly from Gmail**, then changes the notification on this phone.
Enriched taps open that mailbox/thread, fetching it directly if it isn't cached; generic taps open
the mailbox and sync. The demo needs neither Google nor Apple configuration.

`NotificationShared/` contains the direct reader, shared OAuth refresh, Keychain access and
App Group markers. The app moves existing Google refresh tokens from its original private
Keychain group by copying/verifying before deletion. Google credentials and cached access tokens
use `AfterFirstUnlockThisDeviceOnly`, so enrichment can work while locked **after the first
unlock since reboot**; before that it falls back. Otter sessions and IMAP passwords stay in the
app's private Keychain. A nonblocking cross-process file lock serializes OAuth refresh, with
cancellation and replacement checks before saving; account/mailbox removal clears credentials
and markers. Debug and release have different groups and tokens.

The extension uses its own persisted pre-change history cursor, seeded after a successful app
sync. Once push is registered, app/WebSocket/background syncs leave that cursor to the extension
so they cannot consume its pending additions. It walks `messageAdded` history from that cursor, then checks the message's current unread
and label state. Off prevents registration delivery; Inbox enriches unread inbox mail; All also
enriches unread mail outside the inbox, excluding sent/drafts/spam/trash. Each alert also carries
the more restrictive account/device filter, so changing All to Inbox on another device limits
enrichment without sending any mail to the server. Relaxing that filter takes effect when this
phone refreshes its preferences and registration. Multiple eligible
messages produce one alert for the newest message among the last eight additions, with a count
of the eligible messages fetched. Each mailbox has its own cursor. A completed history walk
advances to Gmail's returned cursor, **never using the Pub/Sub ending marker as a starting
cursor**. Missing/404 history rebases from Gmail's profile without announcing existing mail.
An incomplete walk (over five pages), revoked credentials, offline state or the 22-second
local deadline preserves the original generic alert. Completion is guarded against expiry races.

Apple requires an alert and `mutable-content: 1` to run this extension, and allows about
30 seconds. Ordinary extensions cannot discard a submitted alert. This build does **not**
request Apple's restricted filtering entitlement. Read/archive/label changes, watch renewal,
duplicate delivery, or a filter mismatch can therefore show a generic alert even in Inbox mode.
Off and access removal stop future server submissions once received by the relay; already
submitted alerts cannot be recalled, and offline local sign-out/preferences cannot notify the
server until connectivity returns. The phone refuses enrichment for a removed/wrong account.
Foreground generic alerts are suppressed using the supported presentation delegate. Gmail local
alerts are disabled for successfully registered mailboxes (remembered across launches); IMAP
keeps its existing local behavior. If APNs accepts a push but delivery fails later, there is no
local-alert guarantee. Apple/Gmail push are best effort, not an exact new-mail counter.

The app renews Gmail watches daily when it runs and retains the returned expiration. Background
refresh also attempts renewal, but iOS decides whether it runs. Gmail watches expire in at most
seven days; an unopened phone may stop receiving pushes until it opens again (another signed-in
device can renew the same mailbox's watch). The extension does not renew watches, and the relay
has no phone Gmail tokens with which to do so. Gmail can also drop events; opening always syncs.

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
