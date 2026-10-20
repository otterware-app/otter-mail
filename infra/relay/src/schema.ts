/**
 * The relay's D1 schema. `pnpm db:generate` turns changes here into a SQL
 * migration in migrations/; deploying applies it.
 *
 * `user`, `session`, `account` and `verification` are better-auth's tables
 * (its core schema, https://www.better-auth.com/docs/concepts/database);
 * the others are the relay's own.
 */

import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { ImapSettings, MailProviderKind } from "@otter-mail/contracts/mail";
import type { Chat, ChatProvider, ChatTab } from "@otter-mail/contracts/chats";

const createdAt = () =>
  integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
const updatedAt = () =>
  integer({ mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/** Otter accounts. */
export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: "boolean" }).notNull().default(false),
  image: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Prevents an in-flight request from restoring a deleted Accounts profile. */
export const deletedIdentity = sqliteTable("deleted_identity", {
  userId: text().primaryKey(),
});

/** One per signed-in device. */
export const session = sqliteTable(
  "session",
  {
    id: text().primaryKey(),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user").on(t.userId)],
);

/** The Google identity an Otter account signs in with. */
export const account = sqliteTable(
  "account",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: integer({ mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer({ mode: "timestamp_ms" }),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user").on(t.userId)],
);

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Mailboxes (Gmail, IMAP) linked to an Otter account, with the profile the app shows. */
export const linkedAccounts = sqliteTable(
  "linked_accounts",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Lowercased. */
    email: text().notNull(),
    provider: text().$type<MailProviderKind>().notNull().default("gmail"),
    /** JSON, for IMAP mailboxes: where the mailbox lives (never its password). */
    imap: text({ mode: "json" }).$type<ImapSettings>(),
    name: text(),
    picture: text(),
    displayName: text(),
    color: text(),
    linkedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.email] }),
    // Gmail push notifications look accounts up by address.
    index("linked_accounts_email").on(t.email),
  ],
);

/** APNs routing only. Session IDs also come from Accounts, whose lifecycle RPC removes these rows. */
export const pushDevices = sqliteTable(
  "push_devices",
  {
    sessionId: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text().notNull(),
    topic: text().notNull(),
    environment: text().$type<"sandbox" | "production">().notNull(),
    mode: text().$type<"off" | "inbox" | "all">().notNull(),
    expiresAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex("push_device_token").on(t.token, t.topic, t.environment),
    index("push_device_user").on(t.userId),
  ],
);

export const pushMailboxes = sqliteTable(
  "push_mailboxes",
  {
    sessionId: text()
      .notNull()
      .references(() => pushDevices.sessionId, { onDelete: "cascade" }),
    userId: text().notNull(),
    email: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.email] }),
    foreignKey({
      columns: [t.userId, t.email],
      foreignColumns: [linkedAccounts.userId, linkedAccounts.email],
    }).onDelete("cascade"),
  ],
);

/** Stops registration requests already in flight when a session is revoked. Empty session = all older sessions. */
export const pushRevocations = sqliteTable(
  "push_revocations",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text().notNull(),
    revokedAt: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);

/** Provider credentials encrypted for this user/mailbox. No mail content is stored. */
export const notificationConnections = sqliteTable(
  "notification_connections",
  {
    userId: text().notNull(),
    email: text().notNull(),
    provider: text().$type<MailProviderKind>().notNull(),
    generation: text().notNull(),
    credential: text().notNull(),
    status: text().notNull().default("connecting"),
    updatedAt: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.email] }),
    foreignKey({
      columns: [t.userId, t.email],
      foreignColumns: [linkedAccounts.userId, linkedAccounts.email],
    }).onDelete("cascade"),
  ],
);

/** Single-use, short-lived OAuth requests, bound to the original Otter session. */
export const notificationAuthorizations = sqliteTable("notification_authorizations", {
  id: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  email: text().notNull(),
  provider: text().notNull(),
  sessionId: text().notNull(),
  sessionCreatedAt: integer().notNull(),
  verifier: text().notNull(),
  returnTo: text().notNull(),
  expiresAt: integer().notNull(),
});

/** Each Otter account's preferences (contracts' `Preferences`), synced to its devices. */
export const preferences = sqliteTable("preferences", {
  userId: text()
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** JSON: section name → value. */
  data: text().notNull(),
  /** The Hermes API key, encrypted (only the relay can open it). */
  hermesKey: text(),
  updatedAt: updatedAt(),
});

/**
 * Agent chats (contracts' chats.ts), one row each, written whole: `updatedAt`
 * is the writing device's, so a stale write loses. A deleted chat keeps its
 * row (`deletedAt`, no transcript) for devices that haven't heard yet.
 */
export const chats = sqliteTable(
  "chats",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    id: text().notNull(),
    title: text().notNull(),
    provider: text().$type<ChatProvider>().notNull(),
    sessionId: text(),
    sessionOwned: integer({ mode: "boolean" }).notNull().default(false),
    lastResponseId: text(),
    device: text({ mode: "json" }).$type<Chat["device"]>(),
    tabs: text({ mode: "json" }).$type<ChatTab[]>().notNull(),
    /** JSON: the transcript (`ChatTurn[]`), read only a chat at a time. */
    turns: text().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
    deletedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/** Shared Otter sign-in: Better Auth OAuth provider and signing keys. */
export const jwks = sqliteTable("jwks", {
  id: text().primaryKey(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: integer({ mode: "timestamp_ms" }).notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }),
  alg: text(),
  crv: text(),
});

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text().primaryKey(),
    clientId: text().notNull().unique(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: integer({ mode: "boolean" }).default(false),
    skipConsent: integer({ mode: "boolean" }),
    enableEndSession: integer({ mode: "boolean" }),
    subjectType: text(),
    scopes: text({ mode: "json" }).$type<string[]>(),
    clientCredentialsScopes: text({ mode: "json" }).$type<string[]>().default([]),
    userId: text().references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer({ mode: "timestamp_ms" }),
    updatedAt: integer({ mode: "timestamp_ms" }),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text({ mode: "json" }).$type<string[]>(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: text({ mode: "json" }).$type<string[]>().notNull(),
    postLogoutRedirectUris: text({ mode: "json" }).$type<string[]>(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: integer({ mode: "boolean" }),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: text({ mode: "json" }).$type<string[]>(),
    responseTypes: text({ mode: "json" }).$type<string[]>(),
    requirePKCE: integer({ mode: "boolean" }),
    dpopBoundAccessTokens: integer({ mode: "boolean" }).default(false),
    referenceId: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [index("oauth_client_user_id").on(t.userId)],
);

export const oauthResource = sqliteTable("oauth_resource", {
  id: text().primaryKey(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer(),
  refreshTokenTtl: integer(),
  signingAlgorithm: text(),
  signingKeyId: text(),
  allowedScopes: text({ mode: "json" }).$type<string[]>(),
  customClaims: text({ mode: "json" }).$type<Record<string, unknown>>(),
  dpopBoundAccessTokensRequired: integer({ mode: "boolean" }).default(false),
  disabled: integer({ mode: "boolean" }).default(false),
  createdAt: integer({ mode: "timestamp_ms" }),
  updatedAt: integer({ mode: "timestamp_ms" }),
  policyVersion: integer().default(1),
  metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
});

export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text()
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [
    index("oauth_client_resource_client_id").on(t.clientId),
    index("oauth_client_resource_resource_id").on(t.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => session.id, { onDelete: "set null" }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text({ mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text({ mode: "json" }).$type<string[]>(),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    revoked: integer({ mode: "timestamp_ms" }),
    rotatedAt: integer({ mode: "timestamp_ms" }),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: integer({ mode: "timestamp_ms" }),
    authTime: integer({ mode: "timestamp_ms" }),
    confirmation: text({ mode: "json" }).$type<Record<string, unknown>>(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id").on(t.clientId),
    index("oauth_refresh_token_session_id").on(t.sessionId),
    index("oauth_refresh_token_user_id").on(t.userId),
    index("oauth_refresh_token_authorization_code_id").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text().primaryKey(),
    token: text().notNull().unique(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text().references(() => session.id, { onDelete: "set null" }),
    userId: text().references(() => user.id, { onDelete: "cascade" }),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: text({ mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text({ mode: "json" }).$type<string[]>(),
    refreshId: text().references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    revoked: integer({ mode: "timestamp_ms" }),
    confirmation: text({ mode: "json" }).$type<Record<string, unknown>>(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id").on(t.clientId),
    index("oauth_access_token_session_id").on(t.sessionId),
    index("oauth_access_token_user_id").on(t.userId),
    index("oauth_access_token_authorization_code_id").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_id").on(t.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text().primaryKey(),
    clientId: text()
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text().references(() => user.id, { onDelete: "cascade" }),
    referenceId: text(),
    resources: text({ mode: "json" }).$type<string[]>(),
    requestedUserInfoClaims: text({ mode: "json" }).$type<string[]>(),
    scopes: text({ mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("oauth_consent_client_id").on(t.clientId),
    index("oauth_consent_user_id").on(t.userId),
  ],
);

export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text().primaryKey(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
});

/** Remembers app membership even after OAuth tokens expire or a device signs out. */
export const identityApps = sqliteTable(
  "identity_apps",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    appId: text().notNull(),
    linkedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.appId] })],
);
