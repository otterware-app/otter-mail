/**
 * Agent tokens: how an agent Otter Mail doesn't run, on the Mac
 * (ConnectedAgent), reaches its tools over the Mac app's MCP server, with
 * `Authorization: Bearer <token>`: every tool, as much as its access allows.
 * A token is made in Settings and shown once; only its SHA-256 hash is kept.
 */

export interface AgentToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * What an agent on the Mac may do, chosen with its token (so nothing asks
 * again): only read; "safe", anything that can be undone (archive, label,
 * trash, drafts), never sending or deleting for good; or anything.
 */
export type AgentAccess = "read-only" | "safe" | "full-access";

/** An agent on the Mac (Claude Code, Cursor, …) given Otter Mail's tools. */
export interface ConnectedAgent extends AgentToken {
  access: AgentAccess;
}

/** A server's tokens, as Settings lists them: its address, and who may reach it. */
export interface AgentTokens<T extends AgentToken = AgentToken> {
  url: string;
  tokens: T[];
}

/** A new token (`prefix` and 32 random bytes) and the hash to keep of it. */
export async function newAgentToken(prefix: string): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = prefix + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return { token, hash: await agentTokenHash(token) };
}

export async function agentTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
