/**
 * Shared cryptographic utilities for payment webhook signature verification.
 * Used by both Stripe and Square webhook signature implementations.
 */

import { constantTimeCodesEqual } from "#crypto/utils.ts";
import { hmacDigest } from "#shared/sha256.ts";

/** Constant-time string comparison (over UTF-16 char codes) to prevent timing
 * attacks. Shares the one constant-time loop in `constantTimeCodesEqual`. */
export const secureCompare = (a: string, b: string): boolean =>
  constantTimeCodesEqual(
    a.length,
    b.length,
    (i) => a.charCodeAt(i) || 0,
    (i) => b.charCodeAt(i) || 0,
  );

/** Compute HMAC-SHA256 using Web Crypto API, returning raw ArrayBuffer. The
 * keyed digest lives in `#shared/sha256.ts`, the one HMAC both sides of a
 * digest comparison run. */
export const computeHmacSha256 = (
  data: Uint8Array,
  secret: string,
): Promise<ArrayBuffer> => hmacDigest(secret, new Uint8Array(data));

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
