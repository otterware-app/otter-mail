/** What both shells' Microsoft sign-ins (the platform's MicrosoftAuth) share. */

export const OUTLOOK_SIGNED_OUT_MESSAGE = "Signed out of Microsoft. Sign in to this mailbox again.";

/** Graph's /me, for who signed in: the mailbox's address (a personal account may lack `mail`). */
export const GRAPH_ME_URL =
  "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName";

/** Who `GRAPH_ME_URL` says signed in, address lowercased. */
export function signInFromMe(me: {
  mail?: string | null;
  userPrincipalName?: string | null;
  displayName?: string | null;
}): { email: string; name: string } {
  const email = (me.mail || me.userPrincipalName || "").trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Microsoft didn't say which mailbox signed in.");
  return { email, name: me.displayName?.trim() || email };
}
