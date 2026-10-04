import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { newer, payload, send } from "./apns.ts";
import type { Env } from "./worker.ts";
import type { PushDevice } from "./push.ts";

let env: Env;
let publicKey: CryptoKey;
const metadata = {
  version: 1 as const,
  userId: "user",
  email: "mail@example.com",
  historyId: "9007199254740993",
  mode: "inbox" as const,
};
const device = {
  token: "a".repeat(64),
  topic: "dev.otterware.mail",
  environment: "production",
  session_id: "session",
  user_id: "user",
  updated_at: 1000,
} as PushDevice;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  publicKey = pair.publicKey;
  env = {
    APNS_KEY_ID: "KEY",
    APNS_TEAM_ID: "TEAM",
    APNS_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
  } as Env;
});

describe("private APNs payloads", () => {
  it("allows only routing markers, generic text, and no badge", () => {
    const data = payload({
      ...metadata,
      subject: "secret",
      credentials: "secret",
      attachments: ["secret"],
    } as typeof metadata);
    expect(data).toEqual({
      aps: {
        alert: {
          title: "Otter Mail",
          body: "Mailbox updated. Open Otter Mail to check your mail.",
        },
        "mutable-content": 1,
      },
      otter: metadata,
    });
    expect(JSON.stringify(data)).not.toContain("secret");
  });

  it("signs ES256 and separates production and sandbox topics/hosts", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    expect(await send(env, device, metadata, transport)).toBe("sent");
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe(`https://api.push.apple.com/3/device/${device.token}`);
    const headers = new Headers(options!.headers);
    const signed = headers.get("authorization")!.slice(7);
    const verified = await jwtVerify(signed, publicKey, { issuer: "TEAM" });
    expect(verified.protectedHeader).toEqual({ alg: "ES256", kid: "KEY" });
    expect(headers.get("apns-push-type")).toBe("alert");
    expect(headers.get("apns-expiration")).toBe("0");
    expect(headers.get("apns-collapse-id")).toHaveLength(64);
    expect(JSON.parse(options!.body as string)).toEqual(payload(metadata));
    await send(
      env,
      { ...device, environment: "sandbox", topic: "dev.otterware.mail.dev" },
      metadata,
      transport,
    );
    expect(String(transport.mock.calls[1]![0])).toContain("api.sandbox.push.apple.com");
    expect(new Headers(transport.mock.calls[1]![1]!.headers).get("apns-topic")).toBe(
      "dev.otterware.mail.dev",
    );
  });

  it.each([
    [410, "Unregistered", "invalid"],
    [400, "BadDeviceToken", "invalid"],
    [400, "DeviceTokenNotForTopic", "invalid"],
    [429, "TooManyRequests", "retry"],
    [503, "Shutdown", { retryAfterMs: 900_000 }],
    [429, "TooManyProviderTokenUpdates", { retryAfterMs: 1_200_000 }],
    [403, "InvalidProviderToken", "rejected"],
    [403, "ExpiredProviderToken", "retry"],
    [413, "PayloadTooLarge", "rejected"],
  ] as const)("classifies %s %s", async (status, reason, result) => {
    expect(
      await send(
        env,
        device,
        metadata,
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ reason }, { status })),
      ),
    ).toEqual(result);
  });

  it("preserves a token re-registered after Apple's invalidation timestamp", async () => {
    expect(
      await send(
        env,
        device,
        metadata,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ reason: "Unregistered", timestamp: 999 }, { status: 410 }),
          ),
      ),
    ).toBe("rejected");
  });

  it("retries a network timeout without exposing routing data in errors", async () => {
    expect(
      await send(
        env,
        device,
        metadata,
        vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout")),
      ),
    ).toBe("retry");
  });

  it("deduplicates repeated/reordered decimal markers beyond JS safe integers", () => {
    expect(newer("9007199254740993", "9007199254740992")).toBe(true);
    expect(newer("9007199254740993", "9007199254740993")).toBe(false);
    expect(newer("90", "100")).toBe(false);
    expect(newer("invalid", "1")).toBe(false);
  });
});
