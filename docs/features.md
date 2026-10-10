# Features

Every user-facing feature and where it works, checked against the code. Mac and Web are the
same renderer (`apps/web`) over core, so they match unless noted; the iPhone app is its own
Swift code (`apps/ios`). Gmail, IMAP and Outlook are noted where they differ
([Outlook](outlook.md): Microsoft Graph, on Mac, Linux, web and iPhone).
The Mac app supports Apple Silicon Macs (arm64).
The Linux app is the same desktop app; it matches the Mac column except where
[Linux](#linux) says otherwise.

✓ supported · — not supported · a note means partly, or differently

An app shows only what it supports: what it doesn't have isn't listed, switched off, or pointed
to another app. This page is where they're compared.

## Linux

A .deb for Debian 12+ and Ubuntu 22.04+ (x64 and arm64), installed with apt, updating itself
from GitHub Releases. Everything in the Mac column works the same, except:

| Feature                    | Linux                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Window                     | frameless; minimize, maximize and close over the top bar's right end; no glass              |
| Shortcuts                  | Ctrl where the Mac uses ⌘, in shortcuts and clicks (shown so everywhere)                    |
| Closing the window         | quits (no Dock to bring it back); launching it again opens it                               |
| Open at login              | ✓ (an XDG autostart entry)                                                                  |
| Default mail app           | ✓ (xdg; the list is the apps that open mailto: links)                                       |
| Dock badge                 | —                                                                                           |
| Translation                | — (no on-device translator)                                                                 |
| Saved passwords and tokens | the desktop's keyring (GNOME Keyring, KWallet); elsewhere sealed with an app key, as Chrome |
| Updates                    | the .deb; "Restart to update" asks for the admin password (not installed on quit)           |
| Feedback to a local agent  | ✓ (x-terminal-emulator, or a chosen terminal)                                               |

## Getting started

| Feature                                                             | Mac                      | Web | iPhone              |
| ------------------------------------------------------------------- | ------------------------ | --- | ------------------- |
| Setup: a mailbox, the look, notifications, the agent, keys practice | ✓ (plus login, mail app) | ✓   | welcome screen only |
| Tour of the app on your own mail (⌘K, Settings → General)           | ✓                        | ✓   | —                   |

## Mailboxes & accounts

| Feature                                     | Mac                | Web                                 | iPhone                  |
| ------------------------------------------- | ------------------ | ----------------------------------- | ----------------------- |
| Add a Gmail mailbox (Google sign-in)        | ✓ (loopback OAuth) | ✓ (popup; tokens kept by the relay) | ✓ (PKCE)                |
| Add an IMAP mailbox, servers discovered     | ✓                  | ✓ (no domain autoconfig file: CORS) | ✓                       |
| Add an Outlook mailbox (Microsoft sign-in)  | ✓ (loopback OAuth) | ✓ (popup; tokens kept by the relay) | ✓ (PKCE)                |
| IMAP through the relay tunnel               | — (direct)         | ✓ (TLS 1.3 servers only)            | — (direct)              |
| Several mailboxes: on/off, reorder          | ✓                  | ✓                                   | ✓                       |
| Rail: switch, unread dots (a setting)       | ✓                  | ✓                                   | — (drawer)              |
| Rail of spaces: mailboxes, views, Projects  | ✓                  | ✓                                   | —                       |
| Sidebar collapsed: hover a space to peek    | ✓                  | ✓                                   | —                       |
| Combined mailbox (all accounts)             | ✓                  | ✓                                   | ✓ ("All")               |
| Rename and color a mailbox (synced)         | ✓                  | ✓                                   | ✓                       |
| Google profile picture per mailbox          | ✓ (kept current)   | ✓ (kept current)                    | —                       |
| Remove a mailbox (unlinks it everywhere)    | ✓                  | ✓                                   | ✓                       |
| Mailbox linked elsewhere shows "signed out" | ✓                  | ✓                                   | ✓                       |
| Demo mailbox                                | —                  | `pnpm dev:fake` only                | TestFlight / Xcode only |

## Reading

| Feature                                                                 | Mac                                                           | Web                                          | iPhone                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| Conversations, earlier messages collapsed                               | ✓                                                             | ✓                                            | ✓                                              |
| A link for each mailbox, conversation and Settings page; Back / Forward | ✓ (⌘[ ⌘], mouse buttons)                                      | ✓ (the browser's; a reload keeps your place) | —                                              |
| HTML mail, inline (cid) images                                          | ✓                                                             | ✓                                            | ✓                                              |
| Remote images                                                           | load; broken ones proxied by backend                          | load; proxy only where CORS lets             | load                                           |
| Remote-image blocking                                                   | —                                                             | —                                            | —                                              |
| Select and copy message text: a word, a sentence, any range             | ✓                                                             | ✓                                            | ✓                                              |
| Quoted text collapsed                                                   | ✓ (HTML and plain text)                                       | ✓                                            | plain text only                                |
| Attachments                                                             | preview in app, save, open in default app, drag out to Finder | preview in app, save                         | Quick Look, save / share                       |
| Unsubscribe (one-click, web, mailto)                                    | ✓                                                             | ✓                                            | ✓                                              |
| Conversation summary (people, files, list)                              | ✓                                                             | ✓                                            | —                                              |
| Sender hover card (write, search, ask)                                  | ✓                                                             | ✓                                            | —                                              |
| Gmail category chips                                                    | Gmail                                                         | Gmail                                        | —                                              |
| Folders: Inbox, Starred, Sent, Drafts, Important, All, Junk, Trash      | ✓ (Important: Gmail; Outlook: high importance)                | ✓                                            | ✓ (Important: Gmail; Outlook: high importance) |
| Print, show original                                                    | —                                                             | —                                            | —                                              |

## Organizing

| Feature                                  | Mac                                                                | Web                             | iPhone                                                   |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------- | -------------------------------------------------------- |
| Archive, trash, restore, junk / not junk | ✓                                                                  | ✓                               | ✓                                                        |
| Delete forever                           | ✓                                                                  | ✓                               | ✓                                                        |
| Empty Trash / Empty Junk                 | ✓                                                                  | ✓                               | —                                                        |
| Star (flag), read / unread               | ✓                                                                  | ✓                               | ✓                                                        |
| Mark all as read                         | —                                                                  | —                               | ✓                                                        |
| Multi-select and bulk actions            | ✓ (⌘/⇧-click, ⇧↑/⇧↓)                                               | ✓                               | ✓ (archive, trash, read, labels/folders)                 |
| Undo and redo (z ⌘Z, ⇧Z ⇧⌘Z)             | ✓                                                                  | ✓                               | Undo archive/trash (6 seconds)                           |
| Apply / remove labels                    | ✓ (IMAP: move to folder; Outlook: categories, or move to a folder) | ✓                               | ✓ (IMAP: move; Outlook: categories, or move to a folder) |
| Create, rename, delete labels            | ✓ (IMAP: folders; Outlook: categories; folders rename, delete)     | ✓                               | —                                                        |
| Label colors                             | edit (Gmail; Outlook: its preset colors)                           | edit (Gmail, Outlook)           | shown (Gmail, Outlook)                                   |
| Nested labels                            | ✓                                                                  | ✓                               | —                                                        |
| Drag conversations onto labels           | ✓                                                                  | ✓                               | —                                                        |
| Swipe actions                            | —                                                                  | —                               | ✓ (fixed)                                                |
| After archive: next / previous           | ✓                                                                  | ✓                               | ✓                                                        |
| Snooze                                   | ✓ (on this device, while open)                                     | ✓ (on this browser, while open) | —                                                        |

## Todoist

Implementation boundaries and removal steps: [Todoist feature guide](integrations/todoist.md).

Connect with Todoist in Settings → Integrations (browser consent with PKCE), or use a personal
API token. Credentials stay on each device; OAuth tokens refresh automatically. Todoist data
is fetched on demand and needs an internet connection. In `pnpm dev:fake`, Connect with Todoist
opens a pretend account, or use token `demo`; no requests are sent to Todoist. Demo filters
support search, today, overdue, 7 days, priorities and labels with `&` / `|`.

| Feature                                                           | Mac          | Web | iPhone |
| ----------------------------------------------------------------- | ------------ | --- | ------ |
| Browser sign-in, API token, reconnect, disconnect                 | ✓            | ✓   | —      |
| Create tasks from email (reader toolbar and reader/list menus)    | ✓            | ✓   | —      |
| Title, notes, project, natural-language due date, priority        | ✓            | ✓   | —      |
| Labels, project sections, shared-project assignees                | ✓            | ✓   | —      |
| Edit tasks, move projects/sections, reschedule or clear due dates | ✓            | ✓   | —      |
| Add/remove timed reminders from the task editor                   | ✓            | ✓   | —      |
| Clickable link back to the email in Otter Mail                    | ✓ (web link) | ✓   | —      |
| Browse active tasks by project, load more, refresh                | ✓            | ✓   | —      |
| Today & overdue, Upcoming (7 days), search and Todoist filters    | ✓            | ✓   | —      |
| Complete tasks (recurring tasks advance to their next occurrence) | ✓            | ✓   | —      |
| Open task in Todoist, create a task without an email              | ✓            | ✓   | —      |
| Command palette: Browse Todoist tasks                             | ✓            | ✓   | —      |

Reminders are delivered by Todoist using the user's notification settings and account
entitlements. Create the task first, then add a reminder in Edit. OAuth uses Todoist's public
client registration, so no client secret is bundled. The web callback is shipped with the site;
the Mac app receives its callback on a temporary localhost listener.

## Projects

A project keeps the conversations, documents, links and notes of one piece of work (a contract,
a deal) together until it's settled. Projects follow the Otter account; the relay keeps which
conversations are in one, never their mail.

| Feature                                                         | Mac                 | Web | iPhone |
| --------------------------------------------------------------- | ------------------- | --- | ------ |
| Projects in the rail: open ones in the sidebar, settled folded  | ✓                   | ✓   | —      |
| All projects: their conversations in one list, an overview page | ✓                   | ✓   | —      |
| Add conversations (menu, drag onto a project), remove them      | ✓                   | ✓   | —      |
| Conversations from every mailbox in one list                    | ✓                   | ✓   | —      |
| Notes, links                                                    | ✓                   | ✓   | —      |
| Documents: its conversations' attachments, as versions          | ✓                   | ✓   | —      |
| Settle, reopen                                                  | ✓                   | ✓   | —      |
| ⌘K: go to a project, new project; Recently viewed               | ✓                   | ✓   | —      |
| Synced through the Otter account                                | ✓ (offline: queued) | ✓   | —      |
| Uploaded files                                                  | —                   | —   | —      |

## Composing & sending

| Feature                                | Mac                                                     | Web                             | iPhone                                         |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| New, reply, reply all                  | ✓                                                       | ✓                               | ✓                                              |
| Forward                                | ✓ (with attachments)                                    | ✓                               | last message, with attachments                 |
| Cc / Bcc                               | ✓ / ✓                                                   | ✓                               | ✓ / ✓                                          |
| From: pick the mailbox                 | ✓                                                       | ✓                               | ✓                                              |
| Contact suggestions (from cached mail) | ✓                                                       | ✓                               | ✓ (recipient chips)                            |
| Attachments (25 MB)                    | ✓                                                       | ✓                               | ✓ (Photos / Files)                             |
| Rich text (bold, lists, links, quotes) | ✓                                                       | ✓                               | —                                              |
| Drafts                                 | autosaved, conflict-aware                               | ✓                               | local autosave/recovery; mailbox save on close |
| Undo send (10 s)                       | ✓                                                       | ✓                               | —                                              |
| Send later                             | ✓ (on this device, while open)                          | ✓ (on this browser, while open) | —                                              |
| Signatures                             | Gmail: saved in Gmail; IMAP, Outlook: synced preference | ✓                               | ✓ (same)                                       |
| Handles mailto: links                  | ✓ (default mail app)                                    | —                               | —                                              |

On iPhone, Compose lives in the sidebar. In a conversation, tap the compact Reply button to
reply to the sender, or hold it for Reply, Reply all and Forward; Trash sits beside Archive.

Scheduled sends and snoozes work with Gmail, IMAP and Outlook on Mac and web. The queue is local to
that device/browser, survives restarts, and runs overdue actions when the app next opens.
Snooze is available in the reader toolbar and a conversation's right-click menu.
“Scheduled & snoozed” appears only when the queue is nonempty and lists every mailbox's
pending actions: cancel a send to restore its
contents to Drafts, or return a snoozed conversation to Inbox early. A failed or interrupted
send stays there for review; check Sent before sending again, since delivery may be uncertain.
These are Otter Mail actions, separate from Gmail's own scheduled and snoozed folders.

## Search

| Feature                        | Mac                                                                                                     | Web | iPhone                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------ |
| Gmail: server search           | ✓ (all Gmail operators, paged; local when offline)                                                      | ✓   | ✓ (25 results, plus local)                 |
| IMAP: local search             | ✓ (in: from: to: subject: is: has: after: before: newer_than: older_than:)                              | ✓   | ✓ (from: to: subject: label: is: has:)     |
| Outlook: server search         | ✓ (Outlook's search; from: to: cc: subject: has: after: before: newer_than: older_than: in: is: label:) | ✓   | ✓ (same operators; 25 results, plus local) |
| Search chips / advanced search | ✓                                                                                                       | ✓   | —                                          |
| Search tabs in the sidebar     | ✓                                                                                                       | ✓   | —                                          |

## Calendar invitations

| Feature                             | Mac                                                                               | Web | iPhone |
| ----------------------------------- | --------------------------------------------------------------------------------- | --- | ------ |
| Invitation card (what, when, where) | ✓                                                                                 | ✓   | —      |
| Yes / No / Maybe                    | Gmail: Google Calendar; Outlook: Outlook calendar; IMAP: email reply to organizer | ✓   | —      |
| Google's RSVP links in the body     | ✓ (answered in place)                                                             | ✓   | —      |

## Contacts & avatars

| Feature       | Mac                                                                               | Web | iPhone        |
| ------------- | --------------------------------------------------------------------------------- | --- | ------------- |
| Sender photos | Gmail: contacts → Gravatar → domain logo → initials; IMAP, Outlook: from Gravatar | ✓   | initials only |

## Notifications & live mail

| Feature                                                    | Mac                          | Web                     | iPhone                                                               |
| ---------------------------------------------------------- | ---------------------------- | ----------------------- | -------------------------------------------------------------------- |
| New-mail notifications (Off / Inbox / All), click opens it | ✓                            | ✓ (browser)             | ✓ (verified APNs for connected Gmail, Outlook, IMAP; local fallback) |
| Gmail push via relay                                       | ✓ (with an Otter account)    | ✓                       | ✓ (WebSocket + verified APNs)                                        |
| Outlook push via relay (Graph subscription)                | ✓ (with an Otter account)    | ✓                       | ✓ (WebSocket + verified APNs)                                        |
| IMAP IDLE                                                  | ✓ (while running)            | ✓ (while a tab is open) | while open; server watcher for connected APNs                        |
| Background sync                                            | ✓ (15 s – 15 min, or manual) | ✓ (while a tab is open) | BGAppRefresh, ≥ 15 min                                               |
| Unread badge                                               | Dock                         | tab title, app badge    | app icon                                                             |

iPhone APNs alerts require a per-mailbox background-notification connection. Gmail uses a
server metadata grant; Outlook uses a separate basic-mail grant; IMAP uses an explicitly enabled,
encrypted server password. The server confirms arrivals and checks unread/folder filters before
sending. APNs receives only identifiers and a generic **confirmed new-mail** fallback. Sender,
subject and preview are fetched directly from the provider on the phone. No server mail cache or
notification-enrichment proxy is added. Grants permit metadata access (IMAP credentials normally
permit content); they are not end-to-end encrypted against Otter. Local alerts continue for
unconnected mailboxes. Watches/subscriptions renew on the server; Off/revocation/unlink stop future
routing. Apple delivery/enrichment remain best effort, and an already submitted alert cannot be
recalled. See [behavior and setup](../apps/ios/README.md#verified-background-notifications).

## Offline & sync

| Feature                               | Mac                                | Web                    | iPhone                               |
| ------------------------------------- | ---------------------------------- | ---------------------- | ------------------------------------ |
| Local cache                           | SQLite, whole mailbox              | SQLite WASM on OPFS    | JSON, newest 400 threads per mailbox |
| Gmail: first sync                     | every row over IMAP, in seconds    | Gmail API, inbox first | newest threads                       |
| Bodies downloaded for offline         | ✓ (inbox first, then newest first) | — (fetched on open)    | —                                    |
| New mail during a long sync           | ✓                                  | ✓                      | —                                    |
| Changes applied at once, synced after | ✓                                  | ✓                      | ✓ (no outbox)                        |

On iPhone, conversations zoom from their list rows (respecting Reduce Motion), the reader's navigation bar minimizes while scrolling, and selection morphs the glass buttons into bulk actions. The mail list keeps its header in place during search and returns to a compact search button when search closes.

## Settings & customization

| Feature                                                                                                          | Mac      | Web          | iPhone                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | -------- | ------------ | -------------------------------------------------------------------------- |
| 7 themes, a light and a dark pick; System / Light / Dark                                                         | ✓        | ✓            | ✓                                                                          |
| 7 app icons, picked independently in Appearance and remembered on each device                                    | ✓ (Dock) | ✓ (tab icon) | ✓ (Home Screen)                                                            |
| Your own themes (Otter Code's editor): duplicate, edit, import/export                                            | ✓        | ✓            | ✓ (worn and picked; made on the Mac or the web)                            |
| Panel animations                                                                                                 | ✓        | ✓            | —                                                                          |
| Contrast, glass opacity, font size, reading width                                                                | ✓        | ✓            | —                                                                          |
| Full-width messages: content edge to edge, without the side inset (off by default)                               | —        | —            | ✓                                                                          |
| Message list styles: Classic, With dividers                                                                      | ✓        | ✓            | ✓                                                                          |
| Collapsible day separators, on by default in every mail layout                                                   | ✓        | ✓            | ✓                                                                          |
| Overlay scrollbars in the mail panes and Settings, hidden when idle                                              | ✓        | ✓            | native                                                                     |
| Dim read message backgrounds, on by default in every mail layout                                                 | ✓        | ✓            | ✓                                                                          |
| Keyboard navigation highlights rows; Enter opens (optional open with arrows)                                     | ✓        | ✓            | —                                                                          |
| Configurable delay before keyboard previews are marked read (2 seconds by default); clicks mark read immediately | ✓        | ✓            | —                                                                          |
| Mail layouts: Split view, Full inbox, Floating                                                                   | ✓        | ✓            | —                                                                          |
| Floating reader: move, snap, resize, minimize, expand                                                            | ✓        | ✓            | —                                                                          |
| Frosted window frame (title bar and rail, by glass opacity)                                                      | ✓        | —            | —                                                                          |
| Keyboard shortcuts, rebindable (incl. move to label)                                                             | ✓        | ✓            | —                                                                          |
| Command palette (⌘K)                                                                                             | ✓        | ✓            | —                                                                          |
| Recently viewed, back and forward (Mac: title bar; web: browser's)                                               | ✓        | ✓            | —                                                                          |
| Reset customized preferences to their defaults (General, Appearance, agent preferences, mailbox name/color)      | ✓        | ✓            | —                                                                          |
| Settings search (/ or ⌘F in Settings)                                                                            | ✓        | ✓            | —                                                                          |
| Changelog (opens the site's, from ⌘K and Settings' ? menu)                                                       | ✓        | ✓            | —                                                                          |
| Views: filters across mailboxes, a space in the rail (icon or emoji)                                             | ✓        | ✓            | —                                                                          |
| Preferences synced through the Otter account                                                                     | ✓        | ✓            | ✓ (theme, advance, mailboxes, notifications, languages, agent, signatures) |

## Support

| Feature                                                                      | Mac | Web | iPhone |
| ---------------------------------------------------------------------------- | --- | --- | ------ |
| Bug or feature feedback, platform selection, and GitHub issue review         | ✓   | ✓   | —      |
| Anonymous diagnostics and export for a coding agent                          | ✓   | ✓   | —      |
| Open a support investigation in an installed Claude / Codex terminal session | ✓   | —   | —      |
| Return local-agent drafts and findings to the report preview                 | ✓   | —   | —      |
| Download diagnostics as a file and import an agent's Markdown draft          | ✓   | ✓   | —      |

The support playbook covers diagnosis, duplicate detection, issue review, and
optional fix PRs. See [support.md](support.md).

## Agents

| Feature                                                   | Mac                                         | Web                          | iPhone                                              |
| --------------------------------------------------------- | ------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Providers                                                 | OpenRouter, Claude, Codex, Hermes, OpenClaw | OpenRouter, Hermes, OpenClaw | OpenRouter, Hermes                                  |
| Chat, models, steer / stop, tool approval, history        | ✓                                           | ✓                            | ✓                                                   |
| Select and copy chat text                                 | ✓                                           | ✓                            | —                                                   |
| Changes after each agent turn, linking to results         | ✓ (Otter Mail tools)                        | ✓ (OpenRouter)               | —                                                   |
| Turn an agent off                                         | ✓                                           | ✓ (both)                     | ✓ (both; their buttons go)                          |
| Chat about a conversation (pointers, not mail)            | ✓ (also selections, quotes)                 | ✓                            | ✓ (a thread)                                        |
| Attach images and files to a chat                         | ✓                                           | ✓                            | —                                                   |
| Queued follow-ups                                         | ✓                                           | ✓                            | —                                                   |
| Closing the active tab returns to the last tab viewed     | ✓ (chats and pages)                         | ✓ (chats)                    | —                                                   |
| ⌘⇧B toggles the right panel                               | ✓                                           | ✓                            | —                                                   |
| Opening the right panel defaults to a browser tab         | ✓                                           | —                            | —                                                   |
| ⌘⇧F toggles the panel's full-width view                   | ✓                                           | ✓                            | —                                                   |
| ⌘T opens a tab, opening the panel if closed               | ✓ (start page)                              | ✓ (chat)                     | —                                                   |
| Drag to reorder right-panel tabs, with live animation     | ✓ (chats and pages, together)               | ✓ (chats)                    | —                                                   |
| Closing the last panel tab closes the panel               | ✓ (click or ⌘W)                             | ✓ (click)                    | —                                                   |
| Control + Tab returns to the most recently used panel tab | ✓ (chats and pages)                         | ✓ (chats)                    | —                                                   |
| Mail tools (OpenRouter; Claude, Codex on Mac)             | ✓ (every mailbox)                           | ✓ (OpenRouter)               | ✓ (OpenRouter; read, search, draft, send, organize) |
| Calendar tools (OpenRouter; Claude, Codex on Mac)         | ✓                                           | ✓ (OpenRouter)               | —                                                   |
| Theme tools: make, change and wear themes                 | ✓                                           | ✓ (OpenRouter)               | —                                                   |
| Project tools (OpenRouter; Claude, Codex on Mac)          | ✓                                           | ✓ (OpenRouter)               | —                                                   |
| View tools: make, change and delete views                 | ✓                                           | ✓ (OpenRouter)               | —                                                   |
| Projects for agents elsewhere (relay MCP, token)          | ✓ (Hermes)                                  | ✓ (Hermes)                   | ✓ (Hermes)                                          |
| Tools for other agents on the Mac (MCP, token)            | ✓ (Claude Code, Cursor, …)                  | —                            | —                                                   |

OpenRouter runs on Otter Mail's server with the AI SDK on Mac, web and iPhone. Connect an
OpenRouter API key in Settings › Agents while signed in to your Otter account; the key is
sealed on the server, never synced into preferences or sent back to the apps. Available models
come from OpenRouter's account-specific catalog and must support tools. Usage draws from
OpenRouter credits. Requests exclude providers that collect user data. Chats live on the server
and can be resumed on another device; they remain until the chat or Otter account is deleted.

The apps answer the server's tool requests through their mail backends, so mailbox credentials
stay on the device. Keep an app open during a turn. Relevant mail and attachment content goes
to the agent server and OpenRouter when a tool reads it. Changes ask first in Supervised mode;
read operations and saving drafts do not. Full access skips those prompts. On iPhone, the mail
tools read and search, inspect supported attachments, save new plain text drafts, send and
queue organization changes; calendar, project, theme and view tools are omitted. OpenRouter
follow-ups queue on Mac/web; steering is available with Hermes. The iPhone waits for the current
OpenRouter turn to finish before another question. `pnpm dev:fake` runs the same agent runtime
on the local Vite server, with a private browser session and server-side key storage.

Claude and Codex get Otter Mail's own tools (an MCP server in the Mac app's backend), so they
need no mail CLI: search, read and sort mail, download attachments, save drafts and send, in
any mailbox (Gmail, IMAP or Outlook), and list, add, change and answer events in Google Calendar or Outlook's calendar. A tool
that changes a mailbox asks first unless the chat has full access; drafts don't ask. They can
also make a theme or change one of the user's own, and wear a theme; a built-in never changes
(changing one makes a copy, worn in its place). They manage projects too (create, add
conversations and links, keep the notes, settle); Hermes gets the project tools from the relay,
with an agent token.

OpenClaw connects to the user's gateway over its WebSocket, as OpenClaw's own apps do (usually
`wss://<computer>.<tailnet>.ts.net`, with Tailscale Serve). Each install is a device with its own
key: a setup code from `openclaw qr` (or the gateway token) introduces it once, the user
approves it on the gateway (`openclaw devices approve`), and Settings › Agents walks through
those steps. Each device pairs on its own; the Hermes connection instead follows the Otter
account. The web app also
needs its site in the gateway's `gateway.controlUi.allowedOrigins`. Each chat is a gateway
session, so the gateway's other conversations can be resumed; the gateway's agents are the models
to pick. Replies, tool steps, steering and command approvals come through; it works on mail with
its own skills. The token and device key stay on the device.

Other agents on the Mac (Claude Code or Codex in a terminal, Cursor, …) get the same tools from
that server while the app is open, with a token made in Settings › Agents (its address stays the
same from launch to launch). Each token is read only, safe or full access, and nothing asks
again: safe is anything that can be undone (archive, label, trash, drafts, projects), never
sending mail or invitations or deleting for good. Agents that run in the cloud (Langdock,
claude.ai connectors) can't reach a server on the Mac.

## Browser

The agent panel's tabs hold pages as well as chats (ChatGPT's in-app browser). Links in mail and
chat open there by default; Settings › Browser can send them to the default browser instead. The
pages live in a session of their own, apart from the app's. A web page
can't embed other sites, so the web app opens links in a new browser tab as before.

| Feature                                                                    | Mac | Web | iPhone |
| -------------------------------------------------------------------------- | --- | --- | ------ |
| Pages as tabs beside the chats: back, forward, reload, address and search  | ✓   | —   | —      |
| ⌘W closes a chat or page, returning to the last tab viewed                 | ✓   | —   | —      |
| Links in mail and chat open in a tab or the default browser; ⌘-click flips | ✓   | —   | —      |
| Start page (⌘T): new chat, extensions, suggested sites; ⌘L for the address | ✓   | —   | —      |
| Panel fills the window (expand), for a page or a long chat                 | ✓   | ✓   | —      |
| Sign-in popups, links to other apps (asked first), mailto: opens a message | ✓   | —   | —      |
| Context menu, site info (clear a site's data), clear all browsing data     | ✓   | —   | —      |
| Chrome Web Store extensions: add (asked first), auto-update                | ✓   | —   | —      |
| Toolbar: pinned extensions, Extensions menu, badges, popups                | ✓   | —   | —      |
| Settings › Browser: extensions on/off, details, remove, developer mode     | ✓   | —   | —      |
| Extensions' context menu items and notifications                           | ✓   | —   | —      |
| Native messaging (an extension talking to its Mac app, e.g. 1Password's)   | ✓   | —   | —      |

Extensions install through electron-chrome-web-store (MIT) and run on Electron's extension
support, plus Otter Mail's own layer for what Chrome has and Electron doesn't
(`apps/desktop/src/services/extensions.ts` and its preload): `chrome.action`, the rest of
`chrome.tabs`, `chrome.windows`, `contextMenus`, `notifications`, `webNavigation`, `commands`,
`permissions`, native messaging, and simple `downloads` and `privacy`. To connect 1Password to
its desktop app on Mac, add Otter Mail in 1Password's Settings › Browser › Add Browser. It then
shares the desktop app's unlock, including Touch ID. Camera, microphone, location and
notifications are refused to pages.

## Translation

| Feature                                        | Mac                  | Web                               | iPhone               |
| ---------------------------------------------- | -------------------- | --------------------------------- | -------------------- |
| Translate a message; auto for unread languages | ✓ (Apple, on-device) | Chrome only (built-in Translator) | ✓ (Apple, on-device) |

## Mac-only

- Dock badge (off by default; Settings → General); launch at login; default mail app (mailto: links).
- Drag attachments out to Finder.
- Menus: Sync Now, Back / Forward (⌘[ ⌘]).
- Auto-update from GitHub Releases ("Restart to update"), or all at once from ⌘K ("Update Otter
  Mail": check, download, restart). The web app is always current; the
  iPhone app updates through TestFlight.

## Otter account & devices

| Feature                              | Mac      | Web      | iPhone                              |
| ------------------------------------ | -------- | -------- | ----------------------------------- |
| Otter account                        | optional | required | required (the first Google sign-in) |
| Sign out; devices, sign out a device | ✓        | ✓        | ✓                                   |
| Delete account                       | ✓        | ✓        | ✓                                   |

The Google-backed Otter identity also signs in to Otter Drive. Drive receives only identity
claims; Gmail authorization stays with Mail. Existing Mail accounts and sessions keep their IDs.
Sign-in and account management live at `accounts.otterware.app`, an independent service with
its own identity database. Mail's old endpoints remain compatible with installed clients.
The web apps automatically reuse an existing Accounts login in the same browser. **Sign out
of Otter** in either web app signs out of both Mail and Drive in that browser, including
older sessions. Other browsers, the Mac and iPhone apps, and CLI credentials stay signed in.
Accounts used by Drive are deleted through the central account page, which confirms
the effect on both apps and requires transferring or deleting owned shared drives first. Older Mail
clients receive a link to that page instead of deleting a shared identity without confirmation.

## Google OAuth scopes

What each scope in `GMAIL_SCOPES` (`packages/contracts/src/google.ts`) is for:

- `https://mail.google.com/`: every Gmail mail feature (reading, search, sending, drafts,
  labels, delete forever, push). The iPhone app asks for this one only (plus `openid email
profile`).
- `gmail.settings.basic`: saving signatures in Gmail (reading them needs only the mail scope).
- `calendar.events.owned`: answering invitations in Google Calendar, replacing the broader
  `calendar.events` the Mac and web apps ask for today. Without it, RSVPs go by email reply.
- `contacts.readonly` + `contacts.other.readonly`: contact photos for sender avatars.

## Gaps worth closing

- iPhone: calendar invitations (card and RSVP).
- iPhone: rich text in the composer.
- iPhone: forward with the original HTML.
- iPhone: synced draft autosave and undo send.
- iPhone: sender photos (contacts, Gravatar, logos) instead of initials only.
- iPhone: create, rename and delete labels; Empty Trash / Junk.
- iPhone: views.
- Mac and web: Mark all as read (iPhone has it).
- Web: translation outside Chrome.
- Web: offline bodies (the Mac downloads them).
- iPhone: snooze and send later.
- All: remote-image blocking, print, show original.
