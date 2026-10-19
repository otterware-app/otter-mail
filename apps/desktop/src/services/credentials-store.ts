/**
 * credentials-store.ts
 *
 * The Google OAuth client (a "Desktop app" client in the otterware Google
 * Cloud project), shared by every install so users don't need their own
 * project. Sign-in uses PKCE and a loopback redirect (see gmail-oauth.ts).
 *
 * Per RFC 8252 a distributed desktop app's client secret can't be kept
 * confidential; PKCE plus the user's own Google sign-in is the real security
 * boundary. It still stays out of the repository: builds bake it in from
 * OTTER_MAIL_GOOGLE_CLIENT_ID / OTTER_MAIL_GOOGLE_CLIENT_SECRET (the
 * environment, or a gitignored .env.local; see apps/desktop/vite.config.ts),
 * and the same variables override it at runtime.
 */

declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_CLIENT_SECRET__: string;

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

export async function getCredentials(): Promise<GoogleCredentials> {
  const clientId = process.env.OTTER_MAIL_GOOGLE_CLIENT_ID?.trim() || __GOOGLE_CLIENT_ID__;
  const clientSecret =
    process.env.OTTER_MAIL_GOOGLE_CLIENT_SECRET?.trim() || __GOOGLE_CLIENT_SECRET__;
  if (!clientId || !clientSecret) {
    throw new Error(
      "This build has no Google OAuth client. Set OTTER_MAIL_GOOGLE_CLIENT_ID and OTTER_MAIL_GOOGLE_CLIENT_SECRET (see .env.example).",
    );
  }
  return { clientId, clientSecret };
}
