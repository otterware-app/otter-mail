/**
 * Verifies Microsoft ID tokens (Outlook sign-in, work, school and personal
 * accounts), and whether one proves a mailbox's address.
 */

import { MICROSOFT_CONSUMER_TENANT } from "@otter-mail/contracts";
import { errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

import { InvalidTokenError } from "./google-jwt.ts";

export interface MicrosoftClaims extends JWTPayload {
  /** The directory (tenant) the account belongs to. */
  tid: string;
  preferred_username?: string;
  email?: string;
  /** The tenant verified the domain of `email` (an optional claim, set up on the app registration). */
  xms_edov?: boolean;
  name?: string;
}

export const MICROSOFT_JWKS_URL = "https://login.microsoftonline.com/common/discovery/v2.0/keys";

/**
 * Checks the signature, audience and lifetime, and that the issuer is
 * Microsoft's for the token's own tenant (`common` signs in every tenant, so
 * there is no single issuer to expect).
 */
export async function verifyMicrosoftJwt(
  token: string,
  audience: string | string[],
  keys: JWTVerifyGetKey,
): Promise<MicrosoftClaims> {
  let claims: MicrosoftClaims;
  try {
    ({ payload: claims } = await jwtVerify<MicrosoftClaims>(token, keys, {
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "tid", "exp"],
      clockTolerance: 60,
    }));
  } catch (err) {
    if (err instanceof errors.JOSEError) throw new InvalidTokenError(err.code);
    throw err;
  }
  if (claims.iss !== `https://login.microsoftonline.com/${claims.tid}/v2.0`) {
    throw new InvalidTokenError("ERR_JWT_CLAIM_VALIDATION_FAILED");
  }
  return claims;
}

/**
 * Whether the verified token proves its holder signed in to `email`. Its
 * `preferred_username` (the sign-in name: a work account's UPN, which must
 * be on a domain its tenant verified) does. Its `email` is the account's
 * mail attribute, which a tenant's admin can set to any address, so it only
 * counts for personal accounts (Microsoft checked it) or when `xms_edov`
 * says the tenant owns the address's domain.
 */
export function provesMailbox(claims: MicrosoftClaims, email: string): boolean {
  const address = email.toLowerCase();
  if (claims.preferred_username?.toLowerCase() === address) return true;
  const trusted = claims.tid === MICROSOFT_CONSUMER_TENANT || claims.xms_edov === true;
  return trusted && claims.email?.toLowerCase() === address;
}
