# Releases

The short version, for every part including the web app and relay: `docs/runbook.md`.

Mac releases are GitHub Releases of this repository, built by `.github/workflows/release.yml`.
New releases support Apple Silicon Macs only (arm64). Intel Macs can keep using older releases,
but no longer receive compatible updates.
The iPhone app ships separately, with its own version, through `.github/workflows/release-ios.yml`
([The iPhone app](#the-iphone-app)).
There is one channel, stable, like T3 Code's stable train (no nightlies). Installed apps check for
a new release at launch and every few hours, download it in the background, and show a card at
the bottom of the sidebar: "Restart to update". It also installs the next time the app quits (⌘Q,
Dock → Quit, logging out).

## Release cycle

1. Land changes on `main` through pull requests (CI must pass).
2. Cut a release from `main`:
   - Actions → Release → Run workflow, choose `patch`, `minor` or `major`; or
   - `gh workflow run release.yml -f bump=patch` (or `-f version=1.0.0` for an exact version).

   The version is the latest `vX.Y.Z` tag with that bump. The very first release ships
   `apps/desktop/package.json`'s version (`0.1.0`).

3. The workflow builds `main`'s HEAD for arm64 on `macos-15` (DMG + ZIP, with
   `latest-mac.yml` and blockmaps for the updater), publishes the GitHub Release as the latest
   with the version's changelog note (`changelog/<version>.md`, if `main` has one) above notes
   generated since the previous release, and commits the new version to
   `apps/*/package.json` on `main`.

To release a specific commit instead (say, a fix on a release branch), push a tag:
`git tag v1.2.4 <commit> && git push origin v1.2.4`. A version with a suffix (`1.3.0-rc.1`) is
published as a GitHub prerelease with no update feed, for testing by hand.

### Testing the updater locally

Build a newer version into a folder, serve it, and point an older build at it:

```sh
node scripts/build-desktop-artifact.ts --arch arm64 --build-version 0.9.1 --output-dir /tmp/feed
OTTER_MAIL_UPDATE_URL=http://127.0.0.1:8791 \
  node scripts/build-desktop-artifact.ts --arch arm64 --build-version 0.9.0 --skip-build --output-dir /tmp/old
(cd /tmp/feed && python3 -m http.server 8791 --bind 127.0.0.1)
```

Run the 0.9.0 app from `/tmp/old` with `OTTER_MAIL_HOME=/tmp/test-home` so it stays off your
data. Unsigned builds download the update but macOS refuses to install it; the full flow needs
signed builds (below).

## Google OAuth client

Release builds need the Google OAuth client, or the app can't sign in (the workflow fails early
without it). Under Settings → Secrets and variables → Actions:

- Variable `OTTER_MAIL_GOOGLE_CLIENT_ID`: the "Desktop app" client ID from the `otter-mail`
  project.
- Secret `OTTER_MAIL_GOOGLE_CLIENT_SECRET`: its client secret.

## Signing and notarization

Without these secrets the workflow still publishes, but builds are ad hoc signed: Gatekeeper
blocks them on first open (right-click → Open), and macOS refuses to install their updates (the
sidebar card then says "Couldn't update").
Add them under Settings → Secrets and variables → Actions:

| Secret             | What it is                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `CSC_LINK`         | Base64 of a "Developer ID Application" certificate exported as `.p12` (`base64 -i cert.p12`). |
| `CSC_KEY_PASSWORD` | The password of that `.p12`.                                                                  |
| `APPLE_API_KEY`    | Contents of an App Store Connect API key (`AuthKey_XXXX.p8`) with the Developer role.         |
| `APPLE_API_KEY_ID` | That key's ID.                                                                                |
| `APPLE_API_ISSUER` | The issuer ID shown above the keys list in App Store Connect → Users and Access → Keys.       |

Optional repository variable: `XCODE_APP`, the Xcode to build with on the runner (for example
`/Applications/Xcode_26.0.app`). By default the newest Xcode 26+ on the image is used.

## Building locally

`pnpm dist:desktop:dmg` builds an unsigned Apple Silicon DMG. With the secrets above exported
(`APPLE_API_KEY` as a path to the `.p8`), `node scripts/build-desktop-artifact.ts --arch arm64
--signed` builds what CI builds. On a Mac that has the Developer ID identity in its keychain,
`CSC_NAME="Christophe Nicolas Kafrouni (838JVGY7W4)"` can stand in for `CSC_LINK` and
`CSC_KEY_PASSWORD`.

## The iPhone app

The iPhone app has its own version (`MARKETING_VERSION` in `apps/ios/OtterMail.xcodeproj`) and
its own tags (`ios-vX.Y.Z`), apart from the Mac app's: release it when it has changed, not with
every Mac release. It started from the Mac app's 0.5.6, the last shared version.

1. Actions → Release iPhone → Run workflow, choose `patch`, `minor` or `major`; or
   `gh workflow run release-ios.yml -f bump=patch` (or `-f version=1.0.0`). The version is the
   latest `ios-vX.Y.Z` tag with that bump (the first release ships the project's version).
2. The workflow builds `main`'s HEAD on GitHub's `xcode-27` runner with its default (release)
   Xcode, signs it for the App Store and uploads it to App Store Connect. The build number is the
   time (YYYYMMDDhhmm).
3. Only once the upload succeeded does it tag the commit `ios-vX.Y.Z` and commit the version to
   the Xcode project on `main`, so a failed run leaves nothing behind. It makes no GitHub Release:
   the Mac app updates from the latest one.
4. About half an hour later the build is in TestFlight for internal testers (everyone on the App
   Store Connect team). To put it in the App Store, pick the build in App Store Connect (Otter
   Mail: Calm Email → App Store) and submit it for review.

Both workflows push a version bump to `main`; each rebases before pushing, so they can run at the
same time.

The workflow and `scripts/release-ios.ts` (`pnpm release:ios [--version x.y.z]`, the same build
from a Mac with Xcode 27, if GitHub can't) sign with:

- The "Apple Distribution: Christophe Nicolas Kafrouni (838JVGY7W4)" identity: the
  `IOS_DISTRIBUTION_P12` secret (base64 of `~/.otter-mail/signing/apple-distribution.p12`) and
  `IOS_DISTRIBUTION_P12_PASSWORD`; on the Mac, the keychain.
- The "Otter Mail App Store" provisioning profile for `dev.otterware.mail`: the
  `IOS_PROVISIONING_PROFILE` secret (base64 of the `.mobileprovision`); on the Mac, Xcode ›
  Settings › Accounts, or downloaded from the developer portal.
- The extension's “Otter Mail Notifications App Store” profile for
  `dev.otterware.mail.notifications`: `IOS_NOTIFICATION_PROVISIONING_PROFILE` (base64).
  Regenerate the main profile with Push Notifications, App Groups and Keychain Sharing;
  enable the shared group `group.dev.otterware.mail.notifications` on both App IDs/profiles.
  The extension and app must be signed by the same team. The release script exports both.
- An App Store Connect API key: the `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`
  secrets the Mac release notarizes with; on the Mac, `~/.otter-mail/signing/AuthKey_<id>.p8` or
  `OTTER_MAIL_ASC_KEY`, `OTTER_MAIL_ASC_KEY_ID` and `OTTER_MAIL_ASC_ISSUER`.

The App Store app is "Otter Mail: Calm Email" (ID 6817249947); on the phone it's "Otter Mail".
Release builds sign in to Google with their own "iOS" OAuth client (for `dev.otterware.mail`);
development builds use the one for `dev.otterware.mail.dev`. The relay accepts both
(`GOOGLE_IOS_CLIENT_ID`). The demo mailbox shows only in development and TestFlight builds.
