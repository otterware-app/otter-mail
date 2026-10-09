# Outlook mailboxes

Outlook (Microsoft 365 work and school mailboxes, and personal outlook.com, hotmail.com and
live.com ones) is a provider of its own, through Microsoft Graph, next to Gmail's API and IMAP
(docs/imap.md has the layers). Everything above the provider sees mail as messages carrying
labels, so lists, the reader, search, undo, views and projects work as they do for Gmail.

```
MailProvider               packages/core/src/providers/provider.ts
  ├─ gmail/
  ├─ imap/
  └─ outlook/              Microsoft Graph: folders + categories as labels, delta sync,
                           Outlook's search and calendar, a Graph subscription → relay push
```

## Signing in

- Microsoft's OAuth (`login.microsoftonline.com/common`, any account type), scopes in
  `contracts/src/microsoft.ts`: Graph's `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`
  (categories), `Calendars.ReadWrite`, `User.Read`, and `offline_access` for a refresh token.
- It's the platform's `MicrosoftAuth` (core's platform.ts), like Google's `GoogleAuth`:
  - the desktop app signs in itself, installed-app flow with PKCE and a loopback redirect
    (`http://localhost:<port>`), as a public client (no secret); tokens sealed with safeStorage
    in `microsoft-tokens.json` (`apps/desktop/src/services/microsoft-oauth.ts`);
  - the web app signs in through the relay's popup (`/v1/outlook/authorize`), which exchanges the
    code with its confidential client and seals the refresh token for the Otter user; the browser
    keeps the sealed token and asks `/v1/outlook/token` for access tokens
    (`apps/web/src/web/microsoft.ts`, `infra/relay/src/outlook.ts`).
- Microsoft rotates refresh tokens: every refresh stores the new one (the relay answers a new
  sealed token).
- The mailbox's address is Graph's `/me` `mail` (else `userPrincipalName`), lowercased; it's the
  account's id.
- Linking it to the Otter account proves the sign-in with a Microsoft ID token
  (`PUT /v1/accounts/:email` with `provider: "outlook"`). Microsoft's `email` claim isn't verified
  for work accounts, so the relay takes the address from `preferred_username`, or from `email`
  only for personal accounts or with the `xms_edov` claim (`infra/relay/src/microsoft-jwt.ts`).
- Builds without a Microsoft client (`OTTER_MAIL_MICROSOFT_CLIENT_ID` on the desktop, the relay's
  `MICROSOFT_CLIENT_ID` and secret for the web app) don't offer Outlook (`gmail:mailProviders`).
  The Azure app registration is described in infra/relay/README.md.

## Outlook on the Gmail-shaped cache

- Ids are Graph's immutable ids (`Prefer: IdType="ImmutableId"` on every request), so a message
  keeps its id when it moves between folders, as a Gmail message does when its labels change.
  Threads are Graph's `conversationId`.
- Folders: Inbox → `INBOX`, Sent Items → `SENT`, Drafts → `DRAFT`, Deleted Items → `TRASH`,
  Junk Email → `SPAM` (folders inside the last two count as them), Archive → no label (archived
  mail lacks `INBOX`). Other folders are user labels `folder:<id>`, named by their path. Outbox,
  Conversation History, Sync Issues and Scheduled aren't synced.
- Categories are labels `category:<name>`: several per message, with Outlook's preset colors
  (picking a color in the app takes the nearest preset). New labels are categories. Outlook
  can't rename a category, so renaming makes a new one and moves it onto its messages.
- Flagged → `STARRED`, unread → `UNREAD`, high importance → `IMPORTANT`.
- Writes (`outlook/writes.ts`): those three are message properties, categories are set on the
  message; adding a folder label moves the message there; removing its folder's label moves it
  to Archive (out of Junk or Deleted Items: back to Inbox, or Sent Items for your own mail). On a
  thread, sent mail and drafts stay put unless the thread is trashed. Deleting a folder label
  deletes the folder (it goes to Deleted Items with its mail, as in Outlook); deleting a category
  takes it off every message.
- Graph allows 4 requests in flight per mailbox: requests take turns, the user's first, then
  sync, backfill and offline downloads (`outlook/graph.ts`). Reads of many messages go in
  `$batch`es of 20; a 429 makes background work stand down for Graph's Retry-After.

## Sync

- A delta query per folder (`outlook/sync.ts`). A folder's first delta lists everything in it,
  page by page, in the backfill lane, the inbox first; the next page's link is kept, so it
  resumes. Its last page gives a delta link, and every sync run then asks each listed folder
  what changed: new mail, read/flag/category changes, and messages that left it, which are
  looked up (immutable ids) to see where they went, or dropped when they're gone.
- A brand-new mailbox shows the newest 50 messages of its inbox right away; lists page past the
  cache from the server (`listIds`) until every folder is listed.
- The folder tree (names and Outlook's counts) and the categories are re-read when mail changed
  (at most every 30 seconds) and every 2 minutes. A folder deleted for good drops its cached mail;
  one whose label changed (moved into Deleted Items) is listed again.
- An expired delta (410) lists that folder again.

## Reading, sending, search

- Bodies, inline images, attachments and headers come from the message's MIME source
  (`/messages/{id}/$value`, parsed with postal-mime as IMAP's are). Attachment ids are indexes
  into that list.
- Sending: everything starts as a draft. A reply is made with `createReply` on the message it
  answers (its `In-Reply-To`, else the thread's latest), so Outlook keeps it in the
  conversation; then it gets the composer's recipients, subject and HTML body, its attachments
  (an upload session for those over 3 MB), and `/send`. Drafts are messages in Drafts updated
  in place, so a draft's id never changes. Ready-made MIME (unsubscribe mail, invitation replies)
  goes through `/sendMail` as MIME.
- Search is Outlook's (`$search`, KQL), with Gmail's common operators translated: `from:`, `to:`,
  `cc:`, `subject:`, `has:attachment`, `after:`/`before:`, `newer_than:`/`older_than:`, and `in:` a
  folder; `is:unread`, `is:starred`, `is:important` and categories are checked on each result.
- Signatures stay on the device and sync as a preference, as IMAP's do: Graph doesn't expose
  Outlook's.

## Live mail

A Graph subscription on the mailbox's messages (`outlook/watch.ts`) sends every change to the
relay: `POST /v1/outlook/watch` says where (`/push/outlook/:email`) and with what `clientState`
(an HMAC of the address, checked on every notification). The relay answers Graph's validation
handshake and publishes a `mail` event to every Otter user who linked the mailbox as Outlook;
devices sync on it as on a Gmail push. Each signed-in device keeps its own subscription,
renewed a day before it lapses (they last under three days); without one, the device polls.

## Calendar

The mailbox's default Outlook calendar (`outlook/calendar.ts`): invitations are answered in place
(`accept`/`decline`/`tentativelyAccept`, the organizer told), found by the invitation's UID
(`iCalUId`); the agents' calendar tools list, read, create, change and delete events. A video
call is a Teams meeting where the account can have one.

## The iPhone app

Its own Swift implementation of the same design (`apps/ios/OtterMail/Outlook/`, sign-in in
`Account/MicrosoftAuth.swift`), with the same label ids, so views, projects and preferences agree:

- Sign-in is the installed-app flow with PKCE in a browser sheet, as a public client, returning to
  `msauth.<bundle id>://auth` (an iOS redirect on the same app registration). Rotated refresh
  tokens stay in the iPhone's Keychain; the code exchange's ID token links the mailbox.
- Threads are conversations, read whole whenever one of their messages changes. The first sync
  shows the inbox's newest page, then follows the inbox, Sent and Drafts with deltas; other
  folders are followed once their list is opened. A delta follows a folder's mail from a month
  back (or its first page, if older); older pages are read once.
- Bodies, inline images, attachments and headers come from the MIME source when a message first
  syncs; one whose attachments pass 2 MB is read from Graph's properties, its files downloaded
  when opened.
- Each phone keeps its own Graph subscription (`/v1/outlook/watch`), so the relay's `mail` events
  sync it while the app is open; without one it polls every two minutes.
- It lacks: APNs notifications for Outlook (the relay registers phones for Gmail only; Outlook
  mail is announced by background refresh), Outlook's calendar (invitations), and making,
  renaming or deleting labels (the iPhone doesn't for any mailbox).

## Not yet

- Focused Inbox, Outlook's server signatures and rules, and sender photos.
