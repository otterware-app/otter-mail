# Google OAuth verification

Otter applications use the `otterware` Google Cloud project (number `997327858649`,
owned by chris.kafrouni@gmail.com). Laurin has Editor access. The consent screen is
published for external users; Google's branding and data-access verification are separate
from deployment. Until data access is verified, Gmail/Calendar sign-in shows the unverified
app warning and has Google's 100-user cap. The new [Mail Web demo](https://youtu.be/SLIFzRJg594)
shows the Otterware Web client, expanded consent permissions, both Contacts sources, Gmail
signature and deletion, invitation RSVP, and supervised OpenRouter calendar tools. Its link
and scope explanations are saved in the project's Data access form. Google's form requires
footage for every assigned OAuth client: native Mail consent flows and the actual Calendar
application's additional scopes/client still need demonstrations before submitting.
Google's 30 September reply requested clearer Calendar/Contacts demonstrations and exact scope
matching. Private reviewer credentials and login instructions are supplied separately, never
committed to the repository or included in the public video.
Branding ownership is verified via the project owner's Search Console properties.

## Submitting

Google Auth Platform → Data access (https://console.cloud.google.com/auth/scopes?project=otterware).
The form only saves once every field is filled, including the video link.

The app asks for five scopes (`GMAIL_SCOPES` in `packages/contracts/src/google.ts`), plus
`openid email profile`: `https://mail.google.com/`, `gmail.settings.basic`,
`calendar.events.owned`, `contacts.readonly`, `contacts.other.readonly`. Each is the narrowest that
does the job; justifications below.

### Sensitive scopes (calendar.events.owned, contacts.readonly, contacts.other.readonly)

> Otter Mail is an email client for macOS and the web (https://otterware.app/mail/).
> calendar.events.owned: when a user receives a calendar invitation by email, Otter Mail shows the
> event and lets the user Accept, Decline or reply Maybe from the message; the reply is written to
> that event on the user's own primary calendar (events.list by the invitation's iCalUID, then
> events.patch of the user's attendee response). Read-only calendar scopes cannot record an RSVP;
> the optional agent also lists, reads, creates, updates and deletes primary-calendar events
> when the user asks it to. Write tools request approval in the default supervised mode.
> All Mail calendar calls target the user's own primary calendar; read-only scopes cannot
> support event changes. contacts.readonly and contacts.other.readonly: Otter Mail shows the
> names and profile photos of the people the user corresponds with next to their messages, and
> suggests recipients while the user types an address. Both are read-only; we never modify
> contacts. Calendar/Contacts are fetched directly by the device. When the user invokes an agent,
> relevant tool results are sent to their configured provider. With OpenRouter, our Cloudflare
> server processes and stores chat history/tool results and sends the conversation to OpenRouter
> and the selected model provider. History remains until the chat or Otter account is deleted.
> We do not sell Google data, use it for advertising or train AI models on it.

### Restricted scope (gmail.settings.basic)

> Otter Mail lets the user edit the email signature of each Gmail account in its settings. The
> signature is saved in Gmail itself (users.settings.sendAs.patch on the account's own address),
> so it is the same in Gmail on the web and in Otter Mail on every device, and Otter Mail adds it
> to messages the user writes. Reading it only needs the Gmail scope; saving it needs
> gmail.settings.basic. We change nothing else in the user's Gmail settings.

### Restricted scope (https://mail.google.com/)

Features: **Email client**.

> Otter Mail is a full Gmail client for macOS (https://otterware.app/mail/) that users sign in to
> in place of the Gmail website. With this scope the user reads and searches their mail, sends,
> replies and forwards, saves drafts, applies and removes labels, archives, marks read/unread,
> moves mail to Trash or Spam, and permanently deletes messages when they empty Trash or Spam or
> choose Delete Forever. Narrower scopes are not sufficient: gmail.modify cannot permanently
> delete messages (users.messages.delete / batchDelete require https://mail.google.com/), and
> gmail.readonly/send/compose each cover only part of what an email client does. Mail is fetched
> directly from the Gmail API to the user's own Mac and cached locally for speed and offline reading.
> In the web app (https://mail.otterware.app), mail is likewise
> fetched by the user's browser directly from the Gmail API and cached in the browser; because a
> browser can't hold a lasting Google sign-in, our relay performs the OAuth code exchange and
> token refreshes for the web client: tokens pass through it but are not stored (the refresh token
> is encrypted by the relay and kept only in the user's browser). If the user signs in to an
> Otter account (optional in the Mac app, required for the web app), Gmail push
> notifications (users.watch, delivered through Google Cloud Pub/Sub) reach our relay: they carry
> only the mailbox address and a history id, which the relay forwards to the user's devices so
> they sync at once. Separately, users can invoke optional agents to work with mail and calendar
> through tools. For OpenRouter, our Cloudflare server receives prompts and relevant tool results,
> including mail content/attachments, stores chat history until the chat or Otter account is deleted,
> and sends the conversation to OpenRouter and the selected model provider. Google tokens are not
> sent to the agent server. Local agents use the user's configured provider directly. Write tools
> request approval in the default supervised mode. We do not sell data, use it for ads, or train AI
> models on it. Our use and transfer of Google data follows the Google API Services User Data Policy,
> including the Limited Use requirements.

### Demo video (unlisted YouTube, English, 2–4 minutes)

Record the installed app, signed in with a test account, narrating or captioning each step:

1. Otter Mail's home page, then open the app and click **Add Gmail account**.
2. The browser's Google consent screen, with the address bar expanded so the `client_id`
   (`997327858649-n30jr99d21200libki4bgeojpr1kfq59…`) is readable. Show the unverified-app
   screen (Advanced → Go to Otter Mail) and the scope list, then Continue.
3. Gmail: the inbox loads; open and read a message; search; reply and send; add a label; archive;
   move a message to Trash, then empty Trash (permanent delete).
4. Calendar: open an invitation email and click Accept; show the event updated in Google Calendar.
5. Contacts: a sender's photo next to their message, and recipient suggestions while composing.
6. Settings: change the demo mailbox's signature and show the same signature in Gmail.
7. Agent: show the data-sharing notice and supervised approvals, ask the OpenRouter agent to
   summarize a demo message and create/update/delete a primary-calendar event, and verify the
   changes in Google Calendar. Use only synthetic reviewer-account content.

For a web recording, show its actual Web client ID instead of the Mac ID. Include a separate
Calendar recording of its actual consent, calendar selection and event editing once that app's
integration is ready. Do not present Mail's calendar tools as a demonstration of the Calendar app.

### After submitting

Google reviews the submission (usually a few weeks, by email to chris.kafrouni@gmail.com). For
the restricted Gmail scope it then requires a CASA security assessment from an authorised lab,
renewed yearly; follow the instructions in that email.

## Clients

Configured OAuth clients in `otterware` (Google Auth Platform → Clients). All request identity
scopes as well. Secrets live in Cloudflare or GitHub settings, never this repository.

| Client                          | Client ID                                                                  | Used by                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Otterware - Web                 | `997327858649-hvcu3vfk5m83q9jid8g17pv6etmc491v.apps.googleusercontent.com` | Accounts (`GOOGLE_AUTH_CLIENT_ID`) and Mail Gmail (`GOOGLE_GMAIL_CLIENT_ID`)                 |
| Otter Mail - Mac                | `997327858649-n30jr99d21200libki4bgeojpr1kfq59.apps.googleusercontent.com` | Mac release credentials                                                                      |
| Otter Mail - iPhone Development | `997327858649-0dfa4knnv1ur7021dn1ojuovoj1i3ed8.apps.googleusercontent.com` | `dev.otterware.mail.dev`                                                                     |
| Otter Mail - iPhone App Store   | `997327858649-vcvktkdnrs6p8c31ucsp1oeia7l8taho.apps.googleusercontent.com` | `dev.otterware.mail`                                                                         |
| Otter Calendar - Desktop        | `997327858649-lp9asje3r9shdf2iia4ce0vgbm0613n5.apps.googleusercontent.com` | Calendar repository variable `T3CODE_GOOGLE_CLIENT_ID`, secret `T3CODE_GOOGLE_CLIENT_SECRET` |

Mail Mac/Web request the five Mail scopes above. iPhone requests full mail and
`gmail.settings.basic`. Calendar requests `calendar.events` and
`calendar.calendarlist.readonly` (read/write events, read calendar list), matching its existing
Google implementation; Accounts itself requests identity only. Include Calendar's event
editing and calendar selection in the verification justification/video. Calendar release
workflows must consume the repository's credentials when Laurin integrates shared auth.

Sign-ins from before a scope was added keep working without it: calendar.events (asked for before
calendar.events.owned) covers the same calls; without calendar, RSVP is emailed; without
contacts, avatars fall back to Gravatar; without gmail.settings.basic, a signature is kept in
Otter Mail until the account is signed in again (the iPhone asks to sign in again).

## The web app

The web app uses the "Web application" client (used by the relay for Otter sign-in and Gmail
sign-in). Because its Gmail tokens pass through the relay, Google
treats the restricted Gmail scope as accessed through a server: expect the CASA security
assessment to be required, whatever the Mac app alone would need.
