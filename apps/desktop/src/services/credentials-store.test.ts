import { afterEach, expect, it, vi } from "vite-plus/test";
import { getCredentials } from "./credentials-store.js";

afterEach(() => vi.unstubAllEnvs());

it("uses the client from the environment", async () => {
  vi.stubEnv("OTTER_MAIL_GOOGLE_CLIENT_ID", "current-client");
  vi.stubEnv("OTTER_MAIL_GOOGLE_CLIENT_SECRET", "current-secret");
  expect(await getCredentials()).toEqual({
    clientId: "current-client",
    clientSecret: "current-secret",
  });
});
