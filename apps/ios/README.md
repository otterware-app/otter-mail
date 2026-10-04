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
