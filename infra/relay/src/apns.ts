import { importPKCS8, SignJWT } from "jose";
import type { MailPushMetadata, NewMailPushMetadata } from "@otter-mail/contracts/relay";
import type { Env } from "./worker.ts";
import type { PushDevice } from "./push.ts";

let cached: { key: string; token: Promise<string>; issuedAt: number } | undefined;

/** Cached for 50 minutes: APNs rejects overly frequent provider-token rotation. */
async function authorization(env: Env): Promise<string> {
  const key = `${env.APNS_KEY_ID}:${env.APNS_TEAM_ID}:${env.APNS_PRIVATE_KEY}`;
  const now = Math.floor(Date.now() / 1000);
  if (!cached || cached.key !== key || now - cached.issuedAt >= 3000) {
    const token = importPKCS8(env.APNS_PRIVATE_KEY!, "ES256").then((privateKey) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID! })
        .setIssuer(env.APNS_TEAM_ID!)
        .setIssuedAt(now)
        .sign(privateKey),
    );
    cached = { key, token, issuedAt: now };
    token.catch(() => {
      if (cached?.token === token) cached = undefined;
    });
  }
  return cached.token;
}

export function configured(env: Env): boolean {
  return Boolean(env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY);
}

/** Explicit allowlist: never spread a Pub/Sub event or registration into the APNs body. */
export function payload(metadata: MailPushMetadata | NewMailPushMetadata) {
  return {
    aps: {
      alert: {
        title: "Otter Mail",
        body:
          metadata.version === 2
            ? "New mail. Open Otter Mail to read it."
            : "Mailbox updated. Open Otter Mail to check your mail.",
      },
      "mutable-content": 1,
      ...(metadata.version === 2 ? { sound: "default" } : {}),
    },
    otter: {
      version: metadata.version,
      userId: metadata.userId,
      email: metadata.email,
      historyId: metadata.historyId,
      mode: metadata.mode,
      ...(metadata.version === 2
        ? {
            provider: metadata.provider,
            messageId: metadata.messageId,
            ...(metadata.folder ? { folder: metadata.folder } : {}),
            ...(metadata.uidValidity ? { uidValidity: metadata.uidValidity } : {}),
          }
        : {}),
    },
  };
}

export type Result = "sent" | "invalid" | "retry" | "rejected" | { retryAfterMs: number };

/** Fetch uses the Workers outbound HTTPS transport; live APNs HTTP/2 delivery must be verified when configuring keys. */
export async function send(
  env: Env,
  device: PushDevice,
  metadata: MailPushMetadata | NewMailPushMetadata,
  transport: typeof fetch = fetch,
): Promise<Result> {
  const host =
    device.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const origin = env.APNS_TEST_ORIGIN ?? `https://${host}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${metadata.userId}:${metadata.email}`),
  );
  const collapse = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  // Errors and retries are handled by the durable alarm, never logged with tokens/payloads.
  try {
    const response = await transport(`${origin}/3/device/${device.token}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `bearer ${await authorization(env)}`,
        "apns-topic": device.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": "0", // Don't queue stale alerts across sign-out/offline periods.
        "apns-collapse-id": collapse,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload(metadata)),
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 200) return "sent";
    const error = (await response.json().catch(() => null)) as {
      reason?: string;
      timestamp?: number;
    } | null;
    if (response.status === 410) {
      // Apple's invalidation can predate a new registration of this same token.
      return error?.timestamp && error.timestamp < device.updated_at ? "rejected" : "invalid";
    }
    if (error?.reason === "BadDeviceToken" || error?.reason === "DeviceTokenNotForTopic")
      return "invalid";
    if (error?.reason === "ExpiredProviderToken") {
      cached = undefined;
      return "retry";
    }
    if (response.status >= 500) return { retryAfterMs: 15 * 60_000 };
    if (error?.reason === "TooManyProviderTokenUpdates") return { retryAfterMs: 20 * 60_000 };
    if (response.status === 429) return "retry";
    console.warn("APNs rejected a notification", response.status); // No server response text or routing data.
    return "rejected";
  } catch {
    return "retry";
  }
}

/** Gmail IDs are decimal 64-bit markers, not JS numbers. Also drops older, reordered deliveries. */
export function newer(historyId: string, previous?: string): boolean {
  return /^\d{1,20}$/.test(historyId) && (!previous || BigInt(historyId) > BigInt(previous));
}
