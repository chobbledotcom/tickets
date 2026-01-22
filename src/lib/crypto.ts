/**
 * Crypto utilities that work in browser/edge environments
 * Uses @noble/ciphers for encryption (audited, well-tested library)
 */

import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { scrypt } from "@noble/hashes/scrypt.js";

/**
 * Constant-time string comparison to prevent timing attacks
 * Compares all characters regardless of where first mismatch occurs
 *
 * Algorithm: XOR each char pair (equal=0, different=non-zero),
 * OR results together, check final result is 0.
 * Always iterates all characters - no early exit.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
};

/**
 * Generate a cryptographically secure random token
 * Uses Web Crypto API which is available in edge environments
 */
export const generateSecureToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  // Convert to base64url encoding
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
};

/**
 * Encryption format version prefix
 * Format: enc:1:$base64iv:$base64ciphertext
 */
const ENCRYPTION_PREFIX = "enc:1:";

/**
 * Cache for the decoded key bytes
 */
let cachedKeyBytes: Uint8Array | null = null;
let cachedKeySource: string | null = null;

/**
 * Get the encryption key bytes from environment variable
 * Expects DB_ENCRYPTION_KEY to be a base64-encoded 256-bit (32 byte) key
 */
const getEncryptionKeyBytes = (): Uint8Array => {
  const keyString = process.env.DB_ENCRYPTION_KEY;

  if (!keyString) {
    throw new Error(
      "DB_ENCRYPTION_KEY environment variable is required for database encryption",
    );
  }

  // Return cached key if source hasn't changed
  if (cachedKeyBytes && cachedKeySource === keyString) {
    return cachedKeyBytes;
  }

  // Decode base64 key
  const keyBytes = Uint8Array.from(atob(keyString), (c) => c.charCodeAt(0));

  if (keyBytes.length !== 32) {
    throw new Error(
      `DB_ENCRYPTION_KEY must be 32 bytes (256 bits), got ${keyBytes.length} bytes`,
    );
  }

  cachedKeyBytes = keyBytes;
  cachedKeySource = keyString;

  return keyBytes;
};

/**
 * Check if encryption key is configured
 */
export const isEncryptionConfigured = (): boolean => {
  return !!process.env.DB_ENCRYPTION_KEY;
};

/**
 * Validate encryption key is present and valid
 * Call this on startup to fail fast if key is missing
 */
export const validateEncryptionKey = (): void => {
  getEncryptionKeyBytes();
};

/**
 * Encrypt a string value using AES-256-GCM via @noble/ciphers
 * Returns format: enc:1:$base64iv:$base64ciphertext
 */
export const encrypt = async (plaintext: string): Promise<string> => {
  const key = getEncryptionKeyBytes();

  // Generate random 12-byte nonce (recommended for GCM)
  const nonce = randomBytes(12);

  // Encode plaintext to bytes
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Encrypt using @noble/ciphers AES-GCM
  const cipher = gcm(key, nonce);
  const ciphertextBytes = cipher.encrypt(plaintextBytes);

  // Encode nonce and ciphertext as base64
  const nonceBase64 = btoa(String.fromCharCode(...nonce));
  const ciphertextBase64 = btoa(String.fromCharCode(...ciphertextBytes));

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
  const nonce = Uint8Array.from(atob(nonceBase64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ciphertextBase64), (c) =>
    c.charCodeAt(0),
  );

  // Decrypt using @noble/ciphers AES-GCM
  const cipher = gcm(key, nonce);
  const plaintextBytes = cipher.decrypt(ciphertext);

  // Decode to string
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBytes);
};

/**
 * Check if a value is encrypted (has the encryption prefix)
 */
export const isEncrypted = (value: string): boolean => {
  return value.startsWith(ENCRYPTION_PREFIX);
};

/**
 * Clear the cached encryption key (useful for testing)
 */
export const clearEncryptionKeyCache = (): void => {
  cachedKeyBytes = null;
  cachedKeySource = null;
};

/**
 * Password hashing using scrypt (browser-compatible)
 * Format: scrypt:N:r:p:$base64salt:$base64hash
 */
const SCRYPT_N_DEFAULT = 2 ** 14; // CPU/memory cost parameter (production)
const SCRYPT_N_TEST = 2 ** 1; // Minimal cost for fast tests

// Use test cost when TEST_SCRYPT_N env var is set (much faster for tests)
const getScryptN = (): number =>
  process.env.TEST_SCRYPT_N ? SCRYPT_N_TEST : SCRYPT_N_DEFAULT;
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
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const N = getScryptN();

  const hash = scrypt(passwordBytes, salt, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    dkLen: SCRYPT_DKLEN,
  });

  const saltBase64 = btoa(String.fromCharCode(...salt));
  const hashBase64 = btoa(String.fromCharCode(...hash));

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

  const salt = Uint8Array.from(atob(parts[4]), (c) => c.charCodeAt(0));
  const expectedHash = Uint8Array.from(atob(parts[5]), (c) => c.charCodeAt(0));

  // Reject if stored hash has unexpected length
  if (expectedHash.length !== SCRYPT_DKLEN) {
    return false;
  }

  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  const computedHash = scrypt(passwordBytes, salt, {
    N,
    r,
    p,
    dkLen: SCRYPT_DKLEN,
  });

  // Constant-time comparison
  let result = 0;
  for (let i = 0; i < computedHash.length; i++) {
    result |= (computedHash[i] as number) ^ (expectedHash[i] as number);
  }

  return result === 0;
};
