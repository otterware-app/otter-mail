// `pnpm dev:demo:desktop --login` (and `pnpm dev:demo --login`): signs the demo
// Gmail mailboxes in to Google, and the demo Outlook mailboxes in to
// Microsoft, once, as the app would, and saves each sign-in in .env.local's
// OTTER_MAIL_DEMO_MAILBOXES for the demo runs to use
// (packages/contracts/src/demo.ts). The browser half is the installed-app
// flow with PKCE and a loopback redirect, like apps/desktop/src/services/gmail-oauth.ts
// and microsoft-oauth.ts.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import {
  DEMO_MAILBOXES_ENV,
  type DemoGmailMailbox,
  type DemoMailbox,
} from "../packages/contracts/src/demo.ts";
import { GMAIL_SCOPES } from "../packages/contracts/src/google.ts";
import { MICROSOFT_AUTHORITY, OUTLOOK_SCOPES } from "../packages/contracts/src/microsoft.ts";
import { signInPage } from "../packages/shared/src/sign-in-page.ts";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * An OAuth client. A "Desktop app" one takes any loopback port; a "Web
 * application" one only its registered addresses: `redirectUri`, then.
 */
export type GoogleClient = { id: string; secret: string; redirectUri?: string };

/**
 * A Microsoft client: the Mac app's public one (no secret, any port on
 * http://localhost), or the relay's web one (a secret, its registered callback).
 */
export type MicrosoftClient = { id: string; secret?: string; redirectUri?: string };

/** Google in the browser for `email`; resolves with the refresh token it grants `client`. */
async function signIn(client: GoogleClient, email: string): Promise<string> {
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  const state = NodeCrypto.randomBytes(16).toString("base64url");
  const fixed = client.redirectUri ? new URL(client.redirectUri) : null;
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(new Error(`Couldn't listen for Google at ${client.redirectUri}: ${error.message}`)),
    );
    server.listen(fixed ? Number(fixed.port) : 0, fixed?.hostname ?? "127.0.0.1", resolve);
  });
  const redirectUri =
    client.redirectUri ?? `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = `${AUTHORIZE_URL}?${new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
    login_hint: email,
  })}`;

  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const params = new URL(request.url ?? "/", redirectUri).searchParams;
      if (params.get("state") !== state) {
        response.writeHead(404).end();
        return;
      }
      const error = params.get("error");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        signInPage(
          error
            ? { title: `Google said: ${error}`, detail: "Run --login again.", ok: false }
            : {
                title: `Signed in as ${email}`,
                detail: "You can close this tab and return to the terminal.",
                ok: true,
              },
        ),
      );
      if (error) reject(new Error(`Google said: ${error}`));
      else resolve(params.get("code") ?? "");
    });
  });
  console.log(`[login] Sign in to Google as ${email} (its password is in .env.local):\n${url}`);
  // In a terminal, open the browser; an agent opens the link in its own.
  if (process.stdout.isTTY) NodeChildProcess.spawn("open", [url], { stdio: "ignore" });
  try {
    const tokens = await tokenRequest(client, {
      grant_type: "authorization_code",
      code: await code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    // Who signed in: the ID token's claims (from Google itself, over TLS).
    const claims = JSON.parse(
      Buffer.from(tokens.id_token?.split(".")[1] ?? "", "base64url").toString() || "{}",
    ) as { email?: string };
    if (claims.email?.toLowerCase() !== email.toLowerCase()) {
      throw new Error(`That was ${claims.email ?? "an account without an address"}, not ${email}.`);
    }
    if (!tokens.refresh_token) throw new Error("Google didn't return a refresh token.");
    return tokens.refresh_token;
  } finally {
    server.close();
  }
}

async function tokenRequest(
  client: GoogleClient,
  params: Record<string, string>,
): Promise<{ id_token?: string; refresh_token?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...params }),
  });
  const json = (await response.json()) as {
    id_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok) {
    throw new Error(`Google token request failed: ${json.error_description ?? json.error}`);
  }
  return json;
}

/** Microsoft in the browser for `email`; resolves with the refresh token it grants `client`. */
async function signInMicrosoft(client: MicrosoftClient, email: string): Promise<string> {
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  const state = NodeCrypto.randomBytes(16).toString("base64url");
  const fixed = client.redirectUri ? new URL(client.redirectUri) : null;
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) =>
      reject(new Error(`Couldn't listen for Microsoft at ${client.redirectUri}: ${error.message}`)),
    );
    server.listen(fixed ? Number(fixed.port) : 0, "127.0.0.1", resolve);
  });
  // Microsoft takes any port on http://localhost (not 127.0.0.1) for public clients.
  const redirectUri =
    client.redirectUri ?? `http://localhost:${(server.address() as { port: number }).port}`;
  const url = `${MICROSOFT_AUTHORITY}/authorize?${new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: OUTLOOK_SCOPES.join(" "),
    code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
    login_hint: email,
  })}`;

  const code = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const params = new URL(request.url ?? "/", redirectUri).searchParams;
      if (params.get("state") !== state) {
        response.writeHead(404).end();
        return;
      }
      const error = params.get("error_description") ?? params.get("error");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        signInPage(
          error
            ? { title: `Microsoft said: ${error}`, detail: "Run --login again.", ok: false }
            : {
                title: `Signed in as ${email}`,
                detail: "You can close this tab and return to the terminal.",
                ok: true,
              },
        ),
      );
      if (error) reject(new Error(`Microsoft said: ${error}`));
      else resolve(params.get("code") ?? "");
    });
  });
  console.log(`[login] Sign in to Microsoft as ${email} (its password is in .env.local):\n${url}`);
  if (process.stdout.isTTY) NodeChildProcess.spawn("open", [url], { stdio: "ignore" });
  try {
    const response = await fetch(`${MICROSOFT_AUTHORITY}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.id,
        ...(client.secret ? { client_secret: client.secret } : {}),
        grant_type: "authorization_code",
        code: await code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        scope: OUTLOOK_SCOPES.join(" "),
      }),
    });
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !tokens.access_token) {
      throw new Error(
        `Microsoft token request failed: ${tokens.error_description ?? tokens.error}`,
      );
    }
    // Who signed in: Graph's /me, as the app asks.
    const me = (await (
      await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json()) as { mail?: string | null; userPrincipalName?: string | null };
    const signedIn = (me.mail || me.userPrincipalName || "").toLowerCase();
    if (signedIn !== email.toLowerCase()) {
      throw new Error(`That was ${signedIn || "an account without an address"}, not ${email}.`);
    }
    if (!tokens.refresh_token) throw new Error("Microsoft didn't return a refresh token.");
    return tokens.refresh_token;
  } finally {
    server.close();
  }
}

/** Writes the list back to `file` (.env.local), on one line, the rest of the file as it was. */
function save(file: string, mailboxes: DemoMailbox[]): void {
  const json = JSON.stringify(mailboxes);
  const quote = json.includes("'") ? "`" : "'";
  const line = `${DEMO_MAILBOXES_ENV}=${quote}${json}${quote}`;
  const text = NodeFS.readFileSync(file, "utf8");
  const existing = new RegExp(`^${DEMO_MAILBOXES_ENV}=.*$`, "m");
  // Written in place: in a worktree, .env.local links to the main checkout's.
  NodeFS.writeFileSync(
    file,
    existing.test(text) ? text.replace(existing, line) : `${text.replace(/\n?$/, "\n")}${line}\n`,
  );
}

/**
 * Signs in the Gmail and Outlook mailboxes with the app's client (the Mac
 * app's or the web app's), saving the sign-ins to `file`; returns the list
 * with them. The clients are asked for only when there's a mailbox for them.
 */
export async function login(
  file: string,
  mailboxes: DemoMailbox[],
  kind: keyof DemoGmailMailbox["refreshTokens"],
  clients: { google: () => GoogleClient; microsoft: () => MicrosoftClient },
): Promise<DemoMailbox[]> {
  const signedIn = mailboxes.filter(
    (mailbox) => mailbox.provider === "gmail" || mailbox.provider === "outlook",
  );
  if (signedIn.length === 0) {
    throw new Error(`${DEMO_MAILBOXES_ENV} has no Gmail or Outlook mailbox.`);
  }
  // The ones without this app's sign-in yet; when none lacks one, all of them again (renewing).
  const missing = signedIn.filter((mailbox) => !mailbox.refreshTokens[kind]);
  for (const mailbox of missing.length > 0 ? missing : signedIn) {
    const refreshToken =
      mailbox.provider === "gmail"
        ? await signIn(clients.google(), mailbox.email)
        : await signInMicrosoft(clients.microsoft(), mailbox.email);
    mailbox.refreshTokens = { ...mailbox.refreshTokens, [kind]: refreshToken };
    save(file, mailboxes);
    console.log(`[login] Saved ${mailbox.email}'s sign-in in ${file}`);
  }
  return mailboxes;
}
