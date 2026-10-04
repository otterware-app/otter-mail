/** The account's server agent, API key, and shared chat history. */
import { DurableObject } from "cloudflare:workers";
import { EncryptJWT, jwtDecrypt } from "jose";
import { OpenRouterAgentServer, type AgentStorage } from "@otter-mail/core/agent-server";
import { derivedKey } from "./keys.ts";
import { SESSION_HEADER } from "./user-hub.ts";
import type { Env } from "./worker.ts";

export class AgentHub extends DurableObject<Env> {
  private readonly agent: OpenRouterAgentServer;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const key = () => derivedKey(env.BETTER_AUTH_SECRET, "otter-mail openrouter key");
    // Chunk histories because Durable Object values are limited to 128 KB.
    const files: AgentStorage = {
      read: async (name) => {
        const count = await ctx.storage.get<number>(`file:${name}`);
        if (count === undefined) return null;
        const chunks = await Promise.all(
          Array.from({ length: count }, (_, i) => ctx.storage.get<string>(`part:${name}:${i}`)),
        );
        const text = chunks.join("");
        if (name !== "api-key") return text;
        const { payload } = await jwtDecrypt<{ key: string }>(text, await key());
        return payload.key;
      },
      write: async (name, value) => {
        const text =
          name === "api-key"
            ? await new EncryptJWT({ key: value })
                .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
                .encrypt(await key())
            : value;
        await ctx.storage.transaction(async (storage) => {
          const previous = (await storage.get<number>(`file:${name}`)) ?? 0;
          const count = Math.max(1, Math.ceil(text.length / 16_000));
          for (let i = 0; i < count; i++)
            await storage.put(`part:${name}:${i}`, text.slice(i * 16_000, (i + 1) * 16_000));
          for (let i = count; i < previous; i++) await storage.delete(`part:${name}:${i}`);
          await storage.put(`file:${name}`, count);
        });
      },
      remove: async (name) => {
        await ctx.storage.transaction(async (storage) => {
          const count = (await storage.get<number>(`file:${name}`)) ?? 0;
          for (let i = 0; i < count; i++) await storage.delete(`part:${name}:${i}`);
          await storage.delete(`file:${name}`);
        });
      },
      list: async (prefix) =>
        [...(await ctx.storage.list({ prefix: `file:${prefix}` })).keys()].map((name) =>
          name.slice(5),
        ),
    };
    this.agent = new OpenRouterAgentServer(files);
  }

  override fetch(request: Request): Promise<Response> {
    const owner = request.headers.get(SESSION_HEADER);
    if (!owner) return Promise.resolve(new Response("Missing session", { status: 400 }));
    return this.agent.fetch(request, owner);
  }

  disconnect(sessionId?: string): void {
    this.agent.disconnectRuns(sessionId);
  }

  async deleteUser(): Promise<void> {
    this.agent.disconnectRuns();
    await this.ctx.storage.deleteAll();
  }
}
