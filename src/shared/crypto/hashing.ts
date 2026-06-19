/**
 * Password hashing (PBKDF2), session token hashing, HMAC, and ticket token indexing
 */

import { createHash, createHmac } from "node:crypto";
import { lazyRef } from "#fp";
import { getEncryptionKeyBytes } from "./encryption.ts";
import { fromBase64, getRandomBytes, toBase64 } from "./utils.ts";

/**
 * Password hashing using PBKDF2 via Web Crypto API
 * Format: pbkdf2:iterations:$base64salt:$base64hash
 */
const PBKDF2_ITERATIONS_DEFAULT = 600000; // OWASP recommended minimum for SHA-256
const PBKDF2_ITERATIONS_TEST = 1000; // Fast iterations for tests

/** Module-level override avoids env race in parallel tests */
const [getFastPbkdf2, setFastPbkdf2] = lazyRef<boolean | null>(() => null);

/** Explicitly enable/disable fast PBKDF2 for testing without env var races */
export const setFastPbkdf2ForTest = (fast: boolean | null): void =>
  setFastPbkdf2(fast);

export const getPbkdf2Iterations = (): number =>
  getFastPbkdf2() ? PBKDF2_ITERATIONS_TEST : PBKDF2_ITERATIONS_DEFAULT;
const PBKDF2_HASH_LENGTH = 32; // Output key length in bytes
const PASSWORD_PREFIX = "pbkdf2";

/**
 * Constant-time comparison for Uint8Arrays of equal length
 * Caller must ensure arrays have the same length (validated by verifyPassword)
 */
const constantTimeEqualBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i]! ^ b[i]!;
  }
  return result === 0;
};

/**
 * Derive PBKDF2 hash from password and salt
 */
const derivePbkdf2Hash = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { hash: "SHA-256", iterations, name: "PBKDF2", salt: salt as BufferSource },
    passwordKey,
    PBKDF2_HASH_LENGTH * 8,
  );
  return new Uint8Array(hashBuffer);
};

/**
 * Hash a password using PBKDF2
 * Returns format: pbkdf2:iterations:$base64salt:$base64hash
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = getRandomBytes(16);
  const iterations = getPbkdf2Iterations();
  const hash = await derivePbkdf2Hash(password, salt, iterations);
  return `${PASSWORD_PREFIX}:${iterations}:${toBase64(salt)}:${toBase64(hash)}`;
};

/**
 * Verify a password against a hash
 * Uses constant-time comparison to prevent timing attacks
 */
export const verifyPassword = async (
  password: string,
  storedHash: string,
): Promise<boolean> => {
  if (!storedHash.startsWith(`${PASSWORD_PREFIX}:`)) {
    return false;
  }

  const parts = storedHash.split(":");
  if (parts.length !== 4) {
    return false;
  }

  const iterStr = parts[1];
  const saltStr = parts[2];
  const hashStr = parts[3];
  if (!iterStr || !saltStr || !hashStr) return false;

  const iterations = Number.parseInt(iterStr, 10);
  const salt = fromBase64(saltStr);
  const expectedHash = fromBase64(hashStr);

  if (expectedHash.length !== PBKDF2_HASH_LENGTH) {
    return false;
  }

  const computedHash = await derivePbkdf2Hash(password, salt, iterations);
  return constantTimeEqualBytes(computedHash, expectedHash);
};

/**
 * =============================================================================
 * Session Token Hashing
 * =============================================================================
 * Session tokens are hashed before storage to prevent DB-access attacks.
 * The actual token (in the cookie) is needed to decrypt session data.
 */

/**
 * Hash a session token using SHA-256
 * Used to store session lookups without exposing the actual token
 */
export const hashSessionToken = async (token: string): Promise<string> => {
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode(token));
  return toBase64(new Uint8Array(hash.digest()));
};

/**
 * HMAC-SHA256 hash using DB_ENCRYPTION_KEY
 * Used for blind indexes and hashing limited keyspace values
 * Returns deterministic output for same input (unlike encrypt)
 */
export const hmacHashSync = (value: string): string => {
  const mac = createHmac("sha256", getEncryptionKeyBytes());
  mac.update(new TextEncoder().encode(value));
  return toBase64(new Uint8Array(mac.digest()));
};

export const hmacHash = async (value: string): Promise<string> =>
  hmacHashSync(value);

/**
 * Compute ticket token index using HMAC for blind lookups
 * Similar to slug_index for listings - allows lookup without decrypting
 */
export const computeTicketTokenIndex = (token: string): Promise<string> =>
  hmacHash(token);
