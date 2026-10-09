# IMAP mailboxes

Otter Mail reads Gmail through the Gmail API, and every other mailbox through IMAP (sending over
SMTP). The Otter account itself stays a Google sign-in (better-auth). This is how the
providers sit side by side; Outlook, the third, is in [outlook.md](outlook.md).

## Layers

```
renderer (apps/web)         labels, threads, capabilities — never the provider itself
  │ gmail:* channels (names unchanged)
core handlers               providerFor(account).…
  │
MailProvider                packages/core/src/providers/provider.ts
  ├─ gmail/                 Gmail API, quota, history sync, users.watch → relay push
  └─ imap/                  folders ↔ labels, flags, UID/modseq sync, IDLE
        │
      protocols             packages/core/src/protocols/{imap,smtp}: plain TypeScript clients
        │                   over a ByteStream (no Node APIs: they run in the browser too)
      platform.connect()    desktop: node:tls sockets
                            web: WebSocket to the relay's /v1/tunnel, TLS done in the worker
```

- `contracts/src/mail.ts` has the shared model: `MailProviderKind`, `ImapSettings`,
  `MailCapabilities` (and each provider's). The UI gates on capabilities, the way it gates
  Mac-only UI on `features`.
- An account is `GmailAccount` with `provider` (absent = Gmail) and `imap` settings. Its id is
  its address for both providers.
- The IMAP password lives in `platform.secrets` under `imap-password:<accountId>`
  (`services/imap-passwords.ts`); it is never synced. A mailbox linked on another device arrives
  with its settings and shows as signed out until the password is entered (`gmail:signInImap`).
  A password the server refuses is set aside (signed out, no retries) until it's entered again;
  so is one whose mailbox the relay lists with other hosts (the device keeps its own settings).
- Adding one (`handlers/imap-accounts.ts`): `gmail:discoverImap` finds the servers (known
  providers, Mozilla's ISPDB, the domain's autoconfig file on the Mac only, as its host rarely
  allows CORS, then the MX records over DNS-over-HTTPS); `gmail:addImapAccount` logs in to both
  servers before saving anything.

## Live mail

- Gmail, unchanged: `users.watch` → Pub/Sub → relay `/push/gmail` → the user's Durable Object →
  `/v1/events` WebSocket → `syncAccount(…, { trigger: "push" })`.
- IMAP: each device keeps one IDLE connection per mailbox (on INBOX) and calls the same
  `syncAccount(…, { trigger: "push" })` when the server reports EXISTS/EXPUNGE/FETCH. Re-IDLE
  every 25 minutes; reconnect with backoff; `onResume` restarts it. Servers without IDLE fall
  back to the sync timer.
- Both are `provider.watch(account, onChange)`; the sync engine doesn't know which fired.

## IMAP on the Gmail-shaped cache

- Folders are labels. Special-use folders map to system label ids: INBOX → `INBOX`, `\Sent` →
  `SENT`, `\Drafts` → `DRAFT`, `\Trash` → `TRASH`, `\Junk` → `SPAM`, `\Archive` / `\All` → none
  (archived mail simply lacks `INBOX`, as in Gmail). Other folders are user labels whose id is
  the folder path and whose name uses `/` as the separator.
- Flags: no `\Seen` → `UNREAD`, `\Flagged` → `STARRED`.
- A message sits in one folder (`capabilities.multipleLabels = false`): applying a label moves
  it (UID MOVE, or COPY + `\Deleted` + UID EXPUNGE), archive moves to the Archive folder, trash
  moves to Trash.
- Message ids: `<uidvalidity>:<uid>:<folder path>`, re-keyed in the cache when the message
  moves (COPYUID tells the new uid, else the next sync finds it by Message-ID).
- Threads: the root Message-ID of `References` (else `In-Reply-To`, else its own Message-ID),
  and the subject without Re:/Fwd: (References is the sender's to write), so a reply in Sent
  and its original in INBOX share a thread. Junk / Not junk on a thread moves only what's in
  the folder it was reported from.
- Sync, per folder: `UIDVALIDITY` change → refetch the folder; otherwise new UIDs since the
  stored `UIDNEXT`, and flag changes since the stored `HIGHESTMODSEQ` (CONDSTORE/QRESYNC),
  or a full UID + FLAGS listing on servers without it (which also finds expunged mail).
  Summaries come from ENVELOPE, FLAGS, BODYSTRUCTURE and the reply headers; bodies are
  fetched on open (`BODY.PEEK[]`, parsed with postal-mime).
- Sending: SMTP, then APPEND to Sent unless the server files sent mail itself. Drafts: APPEND
  to Drafts, deleting the previous version.
- Search runs on the local cache (FTS); signatures are stored on the device (synced as a
  preference); invitations are answered by email reply.

## The web app's tunnel

The browser can't open TCP connections, so the relay forwards bytes: `GET /v1/tunnel?host=…&port=…`
upgrades to a WebSocket (Otter session required), the relay opens the TCP connection with
`cloudflare:sockets` (TLS off) and pipes binary frames both ways; either side closing closes
both. The worker negotiates TLS inside the tunnel itself, so the relay carries only ciphertext
(for STARTTLS, just the plaintext greeting before the upgrade). Only mail ports (143, 993,
465, 587) are allowed. Nothing is logged but host, port and byte counts. The servers of the
account's linked IMAP mailboxes get full tunnels; any other host (checking a password before
the mailbox is linked) gets 6 a minute of 1 MB each, so a mailbox must be linked before it
syncs. The limits are in infra/relay/README.md.

## The iPhone app

Its own Swift implementation of the same design: a `MailProvider` protocol with the existing
Gmail client and an IMAP one (Network.framework, TLS by the system), IDLE while the app is in
the foreground, and the same folder ↔ label mapping, so its lists and drawer work unchanged.

## Outlook

A Microsoft Graph provider next to `gmail/` and `imap/`, with Microsoft's OAuth sign-in: see
[outlook.md](outlook.md).
