/**
 * Shared primitives for the app's signed, HMAC-protected tokens (QR booking
 * links, balance-payment links).
 *
 * Every token is `${prefix}${payloadB64url}.${hmacB64url}` where the HMAC
 * covers a domain-separated message derived from the payload, so a signature
 * can never collide across token types. Payloads are base64url-encoded JSON.
 */

import { hmacHash } from "#shared/crypto/hashing.ts";
import {
  base64ToBase64Url,
  constantTimeEqual,
  fromBase64Url,
  toBase64Url,
} from "#shared/crypto/utils.ts";
import { nowMs } from "#shared/now.ts";

/** Encode a JSON-serializable payload as a base64url string. */
export const encodeTokenPayload = (payload: unknown): string =>
  toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));

/** Type guard: a decoded token payload is a non-null object. */
export const isTokenObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

/** Decode a base64url payload back to a value, or null on any failure. */
export const decodeTokenPayload = (encoded: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded)));
  } catch {
    return null;
  }
};

/**
 * Returns true when a token's expiry is valid: not yet expired and not
 * further in the future than maxAgeS + 60 seconds (clock-skew tolerance).
 * Pass the current unix seconds as nowS.
 */
export const isTokenExpired = (
  expiryUnixS: number,
  maxAgeS: number,
  nowS: number,
): boolean => expiryUnixS < nowS || expiryUnixS - nowS > maxAgeS + 60;

/** Returns true when a token is expired as of right now, using the current
 * clock to compute nowS. Convenience wrapper over isTokenExpired. */
export const isExpiredNow = (expiryUnixS: number, maxAgeS: number): boolean =>
  isTokenExpired(expiryUnixS, maxAgeS, Math.floor(nowMs() / 1000));

/** Build a signed token from an encoded payload and its HMAC message. */
export const buildSignedToken = async (
  prefix: string,
  encoded: string,
  message: string,
): Promise<string> => {
  const hmac = base64ToBase64Url(await hmacHash(message));
  return `${prefix}${encoded}.${hmac}`;
};

/**
 * Verify a token's prefix and HMAC signature. Returns the encoded payload
 * string when valid (for the caller to decode and range-check), or null. The
 * `message` callback derives the HMAC input from the encoded payload (typically
 * a domain prefix plus the payload).
 */
export const verifySignedToken = async (
  prefix: string,
  token: string,
  message: (encoded: string) => string,
): Promise<string | null> => {
  if (!token.startsWith(prefix)) return null;
  const rest = token.slice(prefix.length);
  const dotIndex = rest.indexOf(".");
  if (dotIndex <= 0 || dotIndex === rest.length - 1) return null;
  const encoded = rest.slice(0, dotIndex);
  const providedHmac = rest.slice(dotIndex + 1);
  const expected = base64ToBase64Url(await hmacHash(message(encoded)));
  return constantTimeEqual(expected, providedHmac) ? encoded : null;
};
