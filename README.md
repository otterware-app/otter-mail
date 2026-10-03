# Otter Mail

Gmail, calm and fast. A macOS app, and the same app in your browser at
[mail.otterware.app](https://mail.otterware.app).

- Several Gmail accounts side by side, or combined into one inbox
- Gmail labels, plus saved views that filter across accounts
- A local SQLite cache with full-text search, so mail opens instantly and works offline
- A menu-bar mini inbox, new-mail notifications, and a Dock unread badge
- On-device translation of mail in other languages (Apple Translation on the Mac, Chrome's
  built-in translator on the web; nothing leaves your device)
- Calendar invitations you can answer in place, and one-click unsubscribe
- An agent that works on your mail through Claude Code, Codex or Hermes
- Keyboard shortcuts for everything, editable in Settings

## Mac app and web app

Both run the same app and the same mail backend (`packages/core`); what a browser can't do is
switched off in the web app.
Mac releases support Apple Silicon Macs (arm64).

| Feature                                                       | Mac app                           | Web app in Chrome                              | Web app in other browsers                      |
| ------------------------------------------------------------- | --------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Several Gmail accounts, combined inbox, labels, saved views   | ✓                                 | ✓                                              | ✓                                              |
| Read, search, compose, drafts, attachments                    | ✓                                 | ✓                                              | ✓                                              |
| Calendar invitations answered in place, one-click unsubscribe | ✓                                 | ✓                                              | ✓                                              |
| Local cache                                                   | ✓ every message, readable offline | ✓ lists and opened messages, in the browser    | ✓ lists and opened messages, in the browser    |
| New mail in seconds (Gmail push)                              | ✓ also with the window closed     | ✓ while a tab is open                          | ✓ while a tab is open                          |
| New-mail notifications                                        | ✓                                 | ✓ while a tab is open (browser permission)     | ✓ while a tab is open (browser permission)     |
| Unread badge                                                  | Dock                              | Tab title (and the app badge, where supported) | Tab title (and the app badge, where supported) |
| Otter account: mailboxes on every device, device list         | Optional                          | Required (it keeps the Gmail sign-ins alive)   | Required (it keeps the Gmail sign-ins alive)   |
| Settings, views, theme, agent settings on every device        | With an Otter account             | ✓                                              | ✓                                              |
| Signatures, kept in Gmail                                     | ✓                                 | ✓                                              | ✓                                              |
| Gmail sign-in                                                 | Tokens stay on your Mac           | Through our relay (tokens pass, never stored)  | Through our relay (tokens pass, never stored)  |
| Keyboard shortcuts, edited in Settings                        | ✓                                 | ✓                                              | ✓                                              |
| Menu-bar mini inbox, launch at login                          | ✓                                 | –                                              | –                                              |
| Default mail app (mailto: links)                              | ✓                                 | –                                              | –                                              |
| On-device translation                                         | ✓ Apple Translation               | ✓ Chrome's built-in translator                 | –                                              |
| Agents                                                        | Claude Code, Codex, Hermes        | Hermes                                         | Hermes                                         |
| Drag attachments out to Finder                                | ✓                                 | –                                              | –                                              |
| Updates                                                       | Automatic                         | Always the latest                              | Always the latest                              |

## Install

Download the latest DMG from [Releases](https://github.com/otterware-app/otter-mail/releases).
Installed apps update themselves from the same page. Or open
[mail.otterware.app](https://mail.otterware.app) in your browser.

## Develop

```sh
corepack enable
pnpm install
pnpm dev
```

See [docs/development.md](docs/development.md) for the full setup and
[docs/release.md](docs/release.md) for how releases are cut. Contributions are welcome;
start with [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
