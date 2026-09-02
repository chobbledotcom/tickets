/**
 * Shared crypto primitives: encoding, token generation, constant-time comparison
 */

import { replacing } from "#shared/replacements.ts";

/**
 * Constant-time string comparison to prevent timing attacks
 * Always iterates over the longer string and XORs the lengths
 * so that different-length inputs don't leak via an early return.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  return constantTimeCodesEqual(
    bufA.length,
    bufB.length,
    (i) => bufA[i] ?? 0,
    (i) => bufB[i] ?? 0,
  );
};

/**
 * Constant-time compare of two code sequences, given their lengths and a
 * per-index code reader for each. Walks the longer sequence and folds every
 * difference into one flag with XOR, so no early return leaks a length or the
 * position of the first mismatch. Callers supply the code source (UTF-8 bytes,
 * UTF-16 char codes, …), keeping this the single constant-time comparison loop.
 */
export const constantTimeCodesEqual = (
  lengthA: number,
  lengthB: number,
  codeA: (i: number) => number,
  codeB: (i: number) => number,
): boolean => {
  const len = Math.max(lengthA, lengthB);
  // Array.from visits every index whatever the codes hold, so timing never
  // leaks the position of the first mismatch.
  const mismatch = Array.from(
    { length: len },
    (_, i) => codeA(i) ^ codeB(i),
  ).reduce((flags, diff) => flags | diff, lengthA ^ lengthB);
  return mismatch === 0;
};

/**
 * Generate random bytes using Web Crypto API
 */
export const getRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/** Concatenate byte arrays into one array. */
export const concatBytes = (
  ...parts: Uint8Array[]
): Uint8Array<ArrayBuffer> => {
  let total = 0;
  for (const part of parts) total += part.length;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

/**
 * Convert Uint8Array to base64 string
 */
export const toBase64 = (bytes: Uint8Array): string => bytes.toBase64();

/**
 * Convert standard base64 to base64url (no padding).
 * Works on both strings and Uint8Array (bytes are first encoded to base64).
 */
export const base64ToBase64Url = replacing(
  [/\+/g, "-"],
  [/\//g, "_"],
  [/=/g, ""],
);

/**
 * Convert Uint8Array to base64url string (no padding)
 */
export const toBase64Url = (bytes: Uint8Array): string =>
  bytes.toBase64({ alphabet: "base64url", omitPadding: true });

/**
 * Convert base64 string to Uint8Array
 */
export const fromBase64 = (base64: string): Uint8Array =>
  Uint8Array.fromBase64(base64);

/**
 * Convert a base64url string (no padding) back to a Uint8Array — the inverse
 * of toBase64Url.
 */
export const fromBase64Url = (s: string): Uint8Array =>
  Uint8Array.fromBase64(s, { alphabet: "base64url" });

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
const toUpperHex = (bytes: Uint8Array): string => bytes.toHex().toUpperCase();

/**
 * Generate a 5-byte uppercase hex ticket token for public ticket URLs
 */
export const generateTicketToken = (): string => toUpperHex(getRandomBytes(5));
