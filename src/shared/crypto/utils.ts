/**
 * Shared crypto primitives: encoding, token generation, constant-time comparison
 */

/**
 * Constant-time string comparison to prevent timing attacks
 * Always iterates over the longer string and XORs the lengths
 * so that different-length inputs don't leak via an early return.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  const len = Math.max(bufA.length, bufB.length);
  let result = bufA.length ^ bufB.length;
  for (let i = 0; i < len; i++) {
    result |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return result === 0;
};

/**
 * Generate random bytes using Web Crypto API
 */
export const getRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/**
 * Convert Uint8Array to base64 string
 */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/**
 * Convert standard base64 to base64url (no padding).
 * Works on both strings and Uint8Array (bytes are first encoded to base64).
 */
export const base64ToBase64Url = (b64: string): string =>
  b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/**
 * Convert Uint8Array to base64url string (no padding)
 */
export const toBase64Url = (bytes: Uint8Array): string =>
  base64ToBase64Url(toBase64(bytes));

/**
 * Convert base64 string to Uint8Array
 */
export const fromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Convert a base64url string (no padding) back to a Uint8Array — the inverse
 * of toBase64Url. Re-pads and restores the standard base64 alphabet first.
 */
export const fromBase64Url = (s: string): Uint8Array => {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  return fromBase64(b64);
};

/**
 * Generate a cryptographically secure random token
 * Uses Web Crypto API getRandomValues
 */
export const generateSecureToken = (): string => {
  const bytes = getRandomBytes(32);
  // Convert to base64url encoding
  return toBase64Url(bytes);
};

/**
 * Convert bytes to uppercase hex string
 */
const toUpperHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex.toUpperCase();
};

/**
 * Generate a 5-byte uppercase hex ticket token for public ticket URLs
 */
export const generateTicketToken = (): string => toUpperHex(getRandomBytes(5));
