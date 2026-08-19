/**
 * Shared cryptographic utilities for payment webhook signature verification.
 * Used by both Stripe and Square webhook signature implementations.
 */

import { constantTimeCodesEqual } from "#crypto/utils.ts";

/** Constant-time string comparison (over UTF-16 char codes) to prevent timing
 * attacks. Shares the one constant-time loop in `constantTimeCodesEqual`. */
export const secureCompare = (a: string, b: string): boolean =>
  constantTimeCodesEqual(
    a.length,
    b.length,
    (i) => a.charCodeAt(i) || 0,
    (i) => b.charCodeAt(i) || 0,
  );

/** Compute HMAC-SHA256 using Web Crypto API, returning raw ArrayBuffer */
export const computeHmacSha256 = async (
  data: Uint8Array,
  secret: string,
): Promise<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, new Uint8Array(data));
};

/** Convert ArrayBuffer to hex string */
export const hmacToHex = (buf: ArrayBuffer): string =>
  new Uint8Array(buf).toHex();

/** Hex-encoded HMAC-SHA256 of a UTF-8 message under the given secret. */
export const hmacSha256Hex = async (
  message: string,
  secret: string,
): Promise<string> =>
  hmacToHex(await computeHmacSha256(new TextEncoder().encode(message), secret));

/** Convert ArrayBuffer to base64 string */
export const hmacToBase64 = (buf: ArrayBuffer): string =>
  new Uint8Array(buf).toBase64();
