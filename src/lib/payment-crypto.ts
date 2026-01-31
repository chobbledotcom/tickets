/**
 * Shared cryptographic utilities for payment webhook signature verification.
 * Used by both Stripe and Square webhook signature implementations.
 */

/** Constant-time string comparison to prevent timing attacks */
export const secureCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
