/**
 * What Otter Mail asks Microsoft for when an Outlook mailbox signs in (the
 * desktop app, and the relay for the web app): Microsoft Graph, for mail,
 * the mailbox's categories and its calendar (docs/outlook.md).
 */
export const OUTLOOK_SCOPES = [
  "openid",
  "email",
  "profile",
  // A refresh token, so the mailbox stays signed in.
  "offline_access",
  // Who signed in (the mailbox's address) and their photo.
  "https://graph.microsoft.com/User.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  // The mailbox's categories (Outlook's colored labels) live in its settings.
  "https://graph.microsoft.com/MailboxSettings.ReadWrite",
  // Invitations answered in place, and the agents' calendar tools.
  "https://graph.microsoft.com/Calendars.ReadWrite",
];

/** Microsoft's sign-in for every kind of account: work, school and personal (outlook.com). */
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";

/** The tenant personal Microsoft accounts (outlook.com, hotmail.com) sign in through. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
