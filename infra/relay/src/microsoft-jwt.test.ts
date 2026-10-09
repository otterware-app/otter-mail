import { MICROSOFT_CONSUMER_TENANT } from "@otter-mail/contracts";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { InvalidTokenError } from "./google-jwt.ts";
import { provesMailbox, verifyMicrosoftJwt } from "./microsoft-jwt.ts";

const AUDIENCE = "11111111-2222-3333-4444-555555555555";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let microsoft: CryptoKey;
let forger: CryptoKey;
let keys: JWTVerifyGetKey;

const claims = {
  iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  aud: AUDIENCE,
  tid: TENANT,
  sub: "abcd",
  preferred_username: "Someone@Contoso.com",
};

function sign(payload: Record<string, unknown>, key = microsoft, expiresIn = "1h") {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  microsoft = pair.privateKey;
  forger = (await generateKeyPair("RS256")).privateKey;
  keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1" }] });
});

describe("verifyMicrosoftJwt", () => {
  it("accepts a token Microsoft signed for this audience, issued by the token's own tenant", async () => {
    const verified = await verifyMicrosoftJwt(await sign(claims), [AUDIENCE, "other"], keys);
    expect(verified.tid).toBe(TENANT);
  });

  it.each([
    ["another audience", { ...claims, aud: "someone-else" }],
    ["another tenant's issuer", { ...claims, iss: `https://login.microsoftonline.com/x/v2.0` }],
    ["the common issuer", { ...claims, iss: "https://login.microsoftonline.com/common/v2.0" }],
    ["another issuer", { ...claims, iss: "https://evil.example" }],
    ["no tenant", { ...claims, tid: undefined }],
  ])("rejects %s", async (_label, payload) => {
    await expect(verifyMicrosoftJwt(await sign(payload), AUDIENCE, keys)).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it("rejects an expired token", async () => {
    const token = await sign(claims, microsoft, "-5m");
    await expect(verifyMicrosoftJwt(token, AUDIENCE, keys)).rejects.toThrow("ERR_JWT_EXPIRED");
  });

  it("rejects a signature from another key", async () => {
    const token = await sign(claims, forger);
    await expect(verifyMicrosoftJwt(token, AUDIENCE, keys)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyMicrosoftJwt("a.b.c", AUDIENCE, keys)).rejects.toThrow(InvalidTokenError);
  });
});

describe("provesMailbox", () => {
  const work = { ...claims, email: "alias@contoso.com" };

  it("trusts the sign-in name, in any case", () => {
    expect(provesMailbox(work, "someone@contoso.com")).toBe(true);
    expect(provesMailbox(work, "SOMEONE@contoso.com")).toBe(true);
    expect(provesMailbox(work, "other@contoso.com")).toBe(false);
  });

  it("trusts a work account's email only when the tenant verified its domain", () => {
    expect(provesMailbox(work, "alias@contoso.com")).toBe(false);
    expect(provesMailbox({ ...work, xms_edov: true }, "alias@contoso.com")).toBe(true);
  });

  it("trusts a personal account's email", () => {
    const personal = {
      ...claims,
      tid: MICROSOFT_CONSUMER_TENANT,
      preferred_username: "+15555550100",
      email: "Me@Outlook.com",
    };
    expect(provesMailbox(personal, "me@outlook.com")).toBe(true);
  });
});
