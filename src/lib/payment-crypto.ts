/**
 * Shared cryptographic utilities for payment webhook signature verification.
 * Used by both Stripe and Square webhook signature implementations.
 */

/** Constant-time string comparison to prevent timing attacks */
export const secureCompare = (a: string, b: string): boolean => {
  const lenA = a.length;
  const lenB = b.length;
  // Always compare against the longer string to avoid length-based timing leaks.
  // If lengths differ the mismatch flag ensures we return false.
  const len = Math.max(lenA, lenB);
  let result = lenA ^ lenB;
  for (let i = 0; i < len; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
};

/** Compute HMAC-SHA256 using Web Crypto API, returning raw ArrayBuffer */
export const computeHmacSha256 = async (
  data: string,
  secret: string,
): Promise<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(data));
};

/** Convert ArrayBuffer to hex string */
export const hmacToHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Convert ArrayBuffer to base64 string */
export const hmacToBase64 = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));
