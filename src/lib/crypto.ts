/**
 * Crypto utilities using Web Crypto API for edge compatibility
 * Works in both Deno and browser/edge environments
 */

import { lazyRef } from "#fp";

/**
 * Constant-time string comparison to prevent timing attacks
 * Uses XOR-based comparison to avoid timing leaks
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }

  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= (bufA[i] as number) ^ (bufB[i] as number);
  }
  return result === 0;
};

/**
 * Generate random bytes using Web Crypto API
 */
const getRandomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/**
 * Convert Uint8Array to base64 string
 */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/**
 * Convert Uint8Array to base64url string (no padding)
 */
const toBase64Url = (bytes: Uint8Array): string => {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

/**
 * Convert base64 string to Uint8Array
 */
const fromBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
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
 * Encryption format version prefix
 * Format: enc:1:$base64iv:$base64ciphertext
 */
const ENCRYPTION_PREFIX = "enc:1:";

type KeyCache = { key: CryptoKey; source: string };

const decodeKeyBytes = (keyString: string): Uint8Array => {
  const keyBytes = fromBase64(keyString);

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
 * Get the encryption key bytes from environment variable (sync validation only)
 * Expects DB_ENCRYPTION_KEY to be a base64-encoded 256-bit (32 byte) key
 */
const getEncryptionKeyString = (): string => {
  const keyString = Deno.env.get("DB_ENCRYPTION_KEY");

  if (!keyString) {
    throw new Error(
      "DB_ENCRYPTION_KEY environment variable is required for database encryption",
    );
  }

  // Validate key length
  decodeKeyBytes(keyString);

  return keyString;
};

/**
 * Import encryption key for Web Crypto API
 */
const importEncryptionKey = async (): Promise<CryptoKey> => {
  const keyString = getEncryptionKeyString();

  // Return cached key if source hasn't changed
  try {
    const cached = getKeyCache();
    if (cached.source === keyString) {
      return cached.key;
    }
  } catch {
    // Cache not initialized yet
  }

  const keyBytes = decodeKeyBytes(keyString);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  setKeyCache({ key, source: keyString });
  return key;
};

/**
 * Validate encryption key is present and valid
 * Call this on startup to fail fast if key is missing
 */
export const validateEncryptionKey = (): void => {
  getEncryptionKeyString();
};

/**
 * Encrypt a string value using AES-256-GCM via Web Crypto API
 * Returns format: enc:1:$base64iv:$base64ciphertext
 * Note: ciphertext includes auth tag appended (Web Crypto API does this automatically)
 */
export const encrypt = async (plaintext: string): Promise<string> => {
  const key = await importEncryptionKey();

  // Generate random 12-byte nonce (recommended for GCM)
  const nonce = getRandomBytes(12);

  // Encrypt using AES-256-GCM
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    plaintextBytes,
  );

  // Encode nonce and ciphertext as base64
  const nonceBase64 = toBase64(nonce);
  const ciphertextBase64 = toBase64(new Uint8Array(ciphertext));

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

  const key = await importEncryptionKey();

  // Parse the encrypted format
  const withoutPrefix = encrypted.slice(ENCRYPTION_PREFIX.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid encrypted data format: missing IV separator");
  }

  const nonceBase64 = withoutPrefix.slice(0, colonIndex);
  const ciphertextBase64 = withoutPrefix.slice(colonIndex + 1);

  // Decode from base64
  const nonce = fromBase64(nonceBase64);
  const ciphertext = fromBase64(ciphertextBase64);

  // Decrypt using AES-256-GCM (Web Crypto handles auth tag internally)
  const plaintextBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    key,
    ciphertext as BufferSource,
  );

  const decoder = new TextDecoder();
  return decoder.decode(plaintextBytes);
};

/**
 * Clear the cached encryption key (useful for testing)
 */
export const clearEncryptionKeyCache = (): void => {
  setKeyCache(null);
};

/**
 * Password hashing using PBKDF2 via Web Crypto API
 * Format: pbkdf2:iterations:$base64salt:$base64hash
 */
const PBKDF2_ITERATIONS_DEFAULT = 600000; // OWASP recommended minimum for SHA-256
const PBKDF2_ITERATIONS_TEST = 1000; // Fast iterations for tests

// Use test iterations when TEST_PBKDF2_ITERATIONS env var is set
const getPbkdf2Iterations = (): number =>
  Deno.env.get("TEST_PBKDF2_ITERATIONS")
    ? PBKDF2_ITERATIONS_TEST
    : PBKDF2_ITERATIONS_DEFAULT;
const PBKDF2_HASH_LENGTH = 32; // Output key length in bytes
const PASSWORD_PREFIX = "pbkdf2";

/**
 * Constant-time comparison for Uint8Arrays of equal length
 * Caller must ensure arrays have the same length (validated by verifyPassword)
 */
const constantTimeEqualBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= (a[i] as number) ^ (b[i] as number);
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
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
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

  const parts = storedHash.split(":") as [string, string, string, string];
  if (parts.length !== 4) {
    return false;
  }

  const iterations = Number.parseInt(parts[1], 10);
  const salt = fromBase64(parts[2]);
  const expectedHash = fromBase64(parts[3]);

  if (expectedHash.length !== PBKDF2_HASH_LENGTH) {
    return false;
  }

  const computedHash = await derivePbkdf2Hash(password, salt, iterations);
  return constantTimeEqualBytes(computedHash, expectedHash);
};
