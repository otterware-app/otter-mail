# Releases

The short version, for every part including the web app and relay: `docs/runbook.md`.

Mac releases are GitHub Releases of this repository, built by `.github/workflows/release.yml`.
New releases support Apple Silicon Macs only (arm64). Intel Macs can keep using older releases,
but no longer receive compatible updates.
The iPhone app ships separately, with its own version, through `.github/workflows/release-ios.yml`
([The iPhone app](#the-iphone-app)).
The Mac and Linux app follow [Otter Code's stable and nightly release trains](https://github.com/otterware-app/otter-code/blob/main/.github/workflows/release.yml). Settings → General
chooses the update channel on this computer. Both channels use the same installed app, mailbox
cache and account data; switching installs the selected channel's build and icon. The default
channel follows the installed build until the user chooses one.

Installed apps check at launch and every four hours, download updates in the background, and
show "Restart to update" in the sidebar. macOS also installs when the app quits; Linux asks for
the admin password on restart. The default ivory icon identifies stable, the purple night sky
identifies nightly, and the blue blueprint identifies unpackaged development runs. The web's
favicon follows its build too; the hosted web app still deploys from main. iPhone has only stable
(TestFlight and App Store) and dev (Debug) icons.

## Release cycle

1. Land changes on `main` through pull requests (CI must pass).
2. **Nightly:** the Release workflow publishes on every push to `main`, including every merged PR.
   Each run builds that push's exact commit; there is no time gate or scheduled polling.
   For an immediate build, run Actions → Release → `channel=nightly`, or
   `gh workflow run release.yml -f channel=nightly`.
3. A nightly previews the next patch version after the latest stable tag, for example
   `0.13.10-nightly.20261013.123`. It is a GitHub prerelease, never the latest stable release,
   and carries only `nightly-mac.yml`, `nightly-linux.yml` and `nightly-linux-arm64.yml` feeds.
   Nightly runs do not change package versions on main.
4. **Stable:** run Actions → Release → `channel=stable`, or
   `gh workflow run release.yml -f channel=stable`. It builds the exact commit of the newest
   published nightly, using the stable version that nightly previewed. An optional
   `-f version=1.0.0` overrides the version, keeping that tested commit. A published nightly
   must exist first. To release another commit already on main, push a stable `vX.Y.Z` tag.
5. Both channels build an Apple Silicon DMG + ZIP on `macos-15` and Linux .debs (x64 and arm64)
   on `ubuntu-24.04`, with the same signing and notarization settings. Stable publishes as
   GitHub's latest release with only `latest-*` feeds, includes an existing changelog note if
   there is one, and records the released version in `apps/*/package.json` on main.

Each train queues its releases without canceling publishers, so consecutive merges each get
their own nightly. Version-bump commits pushed by the workflows' `GITHUB_TOKEN` do not trigger
another workflow run. Manual runs must select the default branch;
release commits must belong to it. Nightly tags are excluded from the tag trigger. Returning
from nightly to stable allows the version downgrade until the stable build is installed; automatic
stable checks never take prereleases. Other local prerelease builds have no update feed.

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

On Linux, the same with `--platform linux --arch x64`; install the old .deb with
`sudo apt install ./Otter-Mail-0.9.0-amd64.deb`. "Restart to update" installs the new one with
dpkg, asking for the admin password (pkexec), and starts it again. Linux builds aren't signed:
apt checks the update's SHA-512 from the feed.

## Google OAuth client

Release builds need the Google OAuth client, or the app can't sign in (the workflow fails early
without it). Under Settings → Secrets and variables → Actions:

- Variable `OTTER_MAIL_GOOGLE_CLIENT_ID`: the "Desktop app" client ID from the `otterware`
  project.
- Secret `OTTER_MAIL_GOOGLE_CLIENT_SECRET`: its client secret.
- Variable `OTTER_MAIL_GOOGLE_LEGACY_CLIENT_ID` and secret
  `OTTER_MAIL_GOOGLE_LEGACY_CLIENT_SECRET`: the original `otter-mail` Desktop client.
  Keep these for existing grants; the new client is used for new sign-ins.

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

`pnpm dist:desktop:deb` (on Linux) builds the .deb for x64; `--arch arm64` builds the arm64
one on the same machine. It installs to `/opt/otter-mail` with `otter-mail` on the PATH, an
`otter-mail.desktop` that handles mailto: links, and depends on what Debian 12+ and
Ubuntu 22.04+ ship (GTK 3, NSS, libnotify, libsecret, xdg-utils).

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
