/** What both shells' Google sign-ins (the platform's GoogleAuth) share. */

export const SIGNED_OUT_MESSAGE = "Signed out of Google. Sign in to this account again.";

/** The user gave up on a sign-in (or started another one). */
export class SignInCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.");
  }
}
