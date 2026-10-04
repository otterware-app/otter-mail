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
import type { ProjectStatus } from "@otter-mail/contracts/projects";

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

/** Projects (contracts' projects.ts): their own fields; threads and links are rows of their own. */
export const projects = sqliteTable(
  "projects",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    id: text().notNull(),
    name: text().notNull(),
    status: text().$type<ProjectStatus>().notNull(),
    notes: text().notNull().default(""),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    settledAt: integer({ mode: "timestamp_ms" }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

/** A conversation in a project: a mailbox's thread (never its subject: the relay doesn't see mail). */
export const projectThreads = sqliteTable(
  "project_threads",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text().notNull(),
    /** The mailbox, lowercased. */
    email: text().notNull(),
    threadId: text().notNull(),
    addedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId, t.email, t.threadId] })],
);

export const projectLinks = sqliteTable(
  "project_links",
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text().notNull(),
    id: text().notNull(),
    url: text().notNull(),
    title: text().notNull(),
    addedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.projectId, t.id] })],
);

/** Tokens agents reach the relay's MCP server with (contracts' relay.ts): only their hash. */
export const agentTokens = sqliteTable(
  "agent_tokens",
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** SHA-256 of the token, hex. */
    hash: text().notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: integer({ mode: "timestamp_ms" }),
  },
  (t) => [index("agent_tokens_user").on(t.userId)],
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
