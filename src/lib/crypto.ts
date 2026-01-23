/**
 * Crypto utilities using node:crypto (supported by Bunny Edge)
 * Uses native Node.js crypto module for better performance and smaller bundle
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { lazyRef } from "#fp";

/**
 * Constant-time string comparison to prevent timing attacks
 * Uses node:crypto timingSafeEqual for buffers, with length check
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
};

/**
 * Generate a cryptographically secure random token
 * Uses node:crypto randomBytes
 */
export const generateSecureToken = (): string => {
  const bytes = randomBytes(32);
  // Convert to base64url encoding
  return bytes.toString("base64url");
};

/**
 * Encryption format version prefix
 * Format: enc:1:$base64iv:$base64ciphertext
 */
const ENCRYPTION_PREFIX = "enc:1:";

type KeyCache = { bytes: Buffer; source: string };

const decodeKeyBytes = (keyString: string): Buffer => {
  const keyBytes = Buffer.from(keyString, "base64");

  if (keyBytes.length !== 32) {
    throw new Error(
      `DB_ENCRYPTION_KEY must be 32 bytes (256 bits), got ${keyBytes.length} bytes`,
    );
  }

  return keyBytes;
};

const [getKeyCache, setKeyCache] = lazyRef<KeyCache>(() => {
  throw new Error("Key cache not initialized");
});

/**
 * Get the encryption key bytes from environment variable
 * Expects DB_ENCRYPTION_KEY to be a base64-encoded 256-bit (32 byte) key
 */
const getEncryptionKeyBytes = (): Buffer => {
  const keyString = Deno.env.get("DB_ENCRYPTION_KEY");

  if (!keyString) {
    throw new Error(
      "DB_ENCRYPTION_KEY environment variable is required for database encryption",
    );
  }

  // Return cached key if source hasn't changed
  try {
    const cached = getKeyCache();
    if (cached.source === keyString) {
      return cached.bytes;
    }
  } catch {
    // Cache not initialized yet
  }

  const bytes = decodeKeyBytes(keyString);
  setKeyCache({ bytes, source: keyString });
  return bytes;
};

/**
 * Validate encryption key is present and valid
 * Call this on startup to fail fast if key is missing
 */
export const validateEncryptionKey = (): void => {
  getEncryptionKeyBytes();
};

/**
 * Encrypt a string value using AES-256-GCM via node:crypto
 * Returns format: enc:1:$base64iv:$base64ciphertext
 * Note: ciphertext includes auth tag appended (for compatibility with previous format)
 */
export const encrypt = async (plaintext: string): Promise<string> => {
  const key = getEncryptionKeyBytes();

  // Generate random 12-byte nonce (recommended for GCM)
  const nonce = randomBytes(12);

  // Encrypt using AES-256-GCM
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Combine ciphertext + authTag (same format as @noble/ciphers)
  const combined = Buffer.concat([ciphertext, authTag]);

  // Encode nonce and combined ciphertext as base64
  const nonceBase64 = nonce.toString("base64");
  const ciphertextBase64 = combined.toString("base64");

  return `${ENCRYPTION_PREFIX}${nonceBase64}:${ciphertextBase64}`;
};

/**
 * Decrypt a string value encrypted with encrypt()
 * Expects format: enc:1:$base64iv:$base64ciphertext
 */
export const decrypt = async (encrypted: string): Promise<string> => {
  if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Invalid encrypted data format");
  }

  const key = getEncryptionKeyBytes();

  // Parse the encrypted format
  const withoutPrefix = encrypted.slice(ENCRYPTION_PREFIX.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid encrypted data format: missing IV separator");
  }

  const nonceBase64 = withoutPrefix.slice(0, colonIndex);
  const ciphertextBase64 = withoutPrefix.slice(colonIndex + 1);

  // Decode from base64
  const nonce = Buffer.from(nonceBase64, "base64");
  const combined = Buffer.from(ciphertextBase64, "base64");

  // Split ciphertext and authTag (last 16 bytes is auth tag)
  const authTagLength = 16;
  const ciphertext = combined.subarray(0, combined.length - authTagLength);
  const authTag = combined.subarray(combined.length - authTagLength);

  // Decrypt using AES-256-GCM
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
};

/**
 * Clear the cached encryption key (useful for testing)
 */
export const clearEncryptionKeyCache = (): void => {
  setKeyCache(null);
};

/**
 * Password hashing using scrypt via node:crypto
 * Format: scrypt:N:r:p:$base64salt:$base64hash
 */
const SCRYPT_N_DEFAULT = 2 ** 14; // CPU/memory cost parameter (production)
const SCRYPT_N_TEST = 2 ** 1; // Minimal cost for fast tests

// Use test cost when TEST_SCRYPT_N env var is set (much faster for tests)
const getScryptN = (): number =>
  Deno.env.get("TEST_SCRYPT_N") ? SCRYPT_N_TEST : SCRYPT_N_DEFAULT;
const SCRYPT_R = 8; // Block size
const SCRYPT_P = 1; // Parallelization
const SCRYPT_DKLEN = 32; // Output key length
const PASSWORD_PREFIX = "scrypt";

/**
 * Hash a password using scrypt
 * Returns format: scrypt:N:r:p:$base64salt:$base64hash
 */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const N = getScryptN();

  const hash = scryptSync(password, salt, SCRYPT_DKLEN, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  const saltBase64 = salt.toString("base64");
  const hashBase64 = hash.toString("base64");

  return `${PASSWORD_PREFIX}:${N}:${SCRYPT_R}:${SCRYPT_P}:${saltBase64}:${hashBase64}`;
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

  const parts = storedHash.split(":") as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (parts.length !== 6) {
    return false;
  }

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);

  const salt = Buffer.from(parts[4], "base64");
  const expectedHash = Buffer.from(parts[5], "base64");

  // Reject if stored hash has unexpected length
  if (expectedHash.length !== SCRYPT_DKLEN) {
    return false;
  }

  const computedHash = scryptSync(password, salt, SCRYPT_DKLEN, { N, r, p });

  // Constant-time comparison using node:crypto
  return timingSafeEqual(computedHash, expectedHash);
};
