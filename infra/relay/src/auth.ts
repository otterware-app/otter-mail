/**
 * Otter account sign-in, with better-auth (served under /v1/auth).
 *
 * The desktop and iPhone apps sign in to Google themselves and hand the relay the ID token
 * (`POST /v1/auth/sign-in/social`, `{ provider: "google", idToken }`); the
 * bearer plugin answers with a session token the app keeps. One session per
 * device, so Settings can list and sign out devices.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer, jwt } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { GOOGLE_JWKS_URL, remoteKeys, verifyGoogleJwt } from "./google-jwt.ts";
import * as schema from "./schema.ts";
import type { Db } from "./store.ts";
import type { Env } from "./worker.ts";
import * as push from "./push.ts";

const DAY_S = 24 * 60 * 60;

export const googleKeys = (env: Env) => remoteKeys(env.GOOGLE_JWKS_URL || GOOGLE_JWKS_URL);

/** The audiences of ID tokens from Otter Mail's own Google sign-ins (desktop, web and iPhone). */
export const googleClientIds = (env: Env) =>
  [
    env.GOOGLE_WEB_CLIENT_ID,
    env.GOOGLE_CLIENT_ID,
    ...(env.GOOGLE_IOS_CLIENT_ID ?? "").split(","),
  ].filter((id): id is string => Boolean(id));

const hub = (env: Env, userId: string) => env.USER_HUB.get(env.USER_HUB.idFromName(userId));

export function createAuth(env: Env, db: Db) {
  return betterAuth({
    appName: "Otter",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/v1/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    // The web app signs in with Google by redirect, and comes back to its origin.
    trustedOrigins: [env.APP_ORIGIN],
    socialProviders: {
      google: {
        // The web client does the redirect sign-in; ID tokens may come from either app.
        clientId: googleClientIds(env),
        clientSecret: env.GOOGLE_WEB_CLIENT_SECRET ?? "",
        verifyIdToken: async (token) => {
          try {
            await verifyGoogleJwt(token, googleClientIds(env), googleKeys(env));
            return true;
          } catch {
            return false;
          }
        },
      },
    },
    session: {
      // A desktop app stays signed in: sessions last 90 days and renew with use.
      expiresIn: 90 * DAY_S,
      updateAge: DAY_S,
      // Deleting the account needs no recent sign-in; the app asks for confirmation.
      freshAge: 0,
    },
    // Old Mail clients only confirm deleting Mail data. Shared accounts must
    // confirm the wider effect on the account page before this endpoint runs.
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const linked = await db.query.identityApps.findFirst({
            where: eq(schema.identityApps.userId, user.id),
          });
          if (linked)
            throw new APIError("FORBIDDEN", {
              message: `This account also signs in to Otter Drive. Manage deletion at ${env.BETTER_AUTH_URL}/otter/account.`,
            });
        },
      },
    },
    disabledPaths: ["/token"],
    plugins: [
      bearer(),
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } }, disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: `${env.BETTER_AUTH_URL}/otter/sign-in`,
        consentPage: `${env.BETTER_AUTH_URL}/otter/consent`,
        scopes: ["openid", "profile", "email"],
        grantTypes: ["authorization_code"],
        allowDynamicClientRegistration: false,
        clientPrivileges: () => false,
        customIdTokenClaims: async ({ user, metadata, scopes }) => {
          if (metadata?.app === "otter-drive") {
            await db
              .insert(schema.identityApps)
              .values({ userId: user.id, appId: "otter-drive" })
              .onConflictDoNothing();
          }
          return {
            ...(scopes.includes("email")
              ? { email: user.email, email_verified: user.emailVerified }
              : {}),
            ...(scopes.includes("profile") ? { name: user.name, picture: user.image } : {}),
          };
        },
      }),
    ],
    databaseHooks: {
      session: {
        delete: {
          // Signed out or revoked: close that device's event stream.
          after: async (session) => {
            await push.remove(env, session.userId, session.id, true);
            await hub(env, session.userId).disconnect(session.id);
          },
        },
      },
      user: {
        delete: {
          after: async (user) => {
            await hub(env, user.id).disconnect();
          },
        },
      },
    },
    advanced: env.COOKIE_DOMAIN
      ? // The web app at mail.otterware.app sees the session cookie (and knows you're signed in).
        { crossSubDomainCookies: { enabled: true, domain: env.COOKIE_DOMAIN } }
      : {},
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
