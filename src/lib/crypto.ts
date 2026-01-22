/**
 * Crypto utilities that work in browser/edge environments
 * Uses @noble/ciphers for encryption (audited, well-tested library)
 */

import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes } from "@noble/ciphers/utils.js";

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
