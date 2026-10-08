import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { setPlatform, type Platform } from "../../platform.js";
import { clearOtterSession, getOtterUser, signInWithSession } from "../otter-account.js";

const saved = new Map<string, string>();
const user = {
  id: "canonical-otter-id",
  email: "account@example.com",
  name: "Otter User",
  picture: null,
};
beforeEach(async () => {
  saved.clear();
  setPlatform({
    relayUrl: "https://relay.mail.test",
    relaySession: "bearer",
    secrets: {
      get: async (name: string) => saved.get(name) ?? null,
      set: async (name: string, value: string) => {
        saved.set(name, value);
      },
      delete: async (name: string) => {
        saved.delete(name);
      },
    },
  } as Platform);
  await clearOtterSession();
});
afterEach(() => vi.unstubAllGlobals());

it("validates and stores a shared account credential before publishing its identity", async () => {
  const fetcher = vi.fn(async () => Response.json({ user }));
  vi.stubGlobal("fetch", fetcher);
  expect(await signInWithSession("native-suite-token")).toEqual(user);
  expect(fetcher).toHaveBeenCalledWith(
    "https://relay.mail.test/v1/me",
    expect.objectContaining({ headers: { Authorization: "Bearer native-suite-token" } }),
  );
  expect(getOtterUser()?.id).toBe(user.id);
  expect(JSON.parse(saved.get("otter-session")!)).toEqual({ token: "native-suite-token", user });
  await clearOtterSession();
  expect(getOtterUser()).toBeNull();
  expect(saved.has("otter-session")).toBe(false);
});

it("does not adopt a credential refused by the relay", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Unauthenticated" }, { status: 401 })),
  );
  await expect(signInWithSession("invalid-token")).rejects.toMatchObject({ status: 401 });
  expect(getOtterUser()).toBeNull();
  expect(saved.size).toBe(0);
});
