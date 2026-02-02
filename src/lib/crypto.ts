/**
 * Crypto utilities using Web Crypto API for edge compatibility
 * Works in both Deno and browser/edge environments
 */

import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";

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
 * Generate an 8-byte base64url ticket token for public ticket URLs
 */
export const generateTicketToken = (): string => toBase64Url(getRandomBytes(8));

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
  const keyString = getEnv("DB_ENCRYPTION_KEY");

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
  getEnv("TEST_PBKDF2_ITERATIONS")
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
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return toBase64(new Uint8Array(hashBuffer));
};

/**
 * HMAC-SHA256 hash using DB_ENCRYPTION_KEY
 * Used for blind indexes and hashing limited keyspace values
 * Returns deterministic output for same input (unlike encrypt)
 */
export const hmacHash = async (value: string): Promise<string> => {
  const keyString = getEncryptionKeyString();
  const keyBytes = decodeKeyBytes(keyString);

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(value),
  );

  return toBase64(new Uint8Array(signature));
};

/**
 * =============================================================================
 * Key Encryption Key (KEK) Derivation
 * =============================================================================
 * KEK is derived from password hash + DB_ENCRYPTION_KEY.
 * This ensures that both factors are needed to unwrap the DATA_KEY.
 */

/**
 * Derive a Key Encryption Key (KEK) from password hash and DB_ENCRYPTION_KEY
 * Uses PBKDF2 with the password hash as input and DB_ENCRYPTION_KEY as salt
 */
export const deriveKEK = async (passwordHash: string): Promise<CryptoKey> => {
  const dbKey = getEncryptionKeyString();
  const encoder = new TextEncoder();

  // Use DB_ENCRYPTION_KEY as salt - attacker needs both password hash AND env var
  const salt = encoder.encode(dbKey);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passwordHash),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: getPbkdf2Iterations(),
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
};

/**
 * =============================================================================
 * Symmetric Key Wrapping
 * =============================================================================
 * Used to wrap DATA_KEY with KEK, and to wrap DATA_KEY with session token.
 */

const WRAPPED_KEY_PREFIX = "wk:1:";

/**
 * Generate a random 256-bit symmetric key for data encryption
 */
export const generateDataKey = (): Promise<CryptoKey> => {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
};

/**
 * Wrap a symmetric key with another key using AES-GCM
 * Returns format: wk:1:$base64iv:$base64wrapped
 */
export const wrapKey = async (
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> => {
  const iv = getRandomBytes(12);

  // Export the key to raw bytes, then encrypt
  const rawKey = await crypto.subtle.exportKey("raw", keyToWrap);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    wrappingKey,
    rawKey,
  );

  return `${WRAPPED_KEY_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(wrapped))}`;
};

/**
 * Unwrap a symmetric key
 * Expects format: wk:1:$base64iv:$base64wrapped
 */
export const unwrapKey = async (
  wrapped: string,
  unwrappingKey: CryptoKey,
): Promise<CryptoKey> => {
  if (!wrapped.startsWith(WRAPPED_KEY_PREFIX)) {
    throw new Error("Invalid wrapped key format");
  }

  const withoutPrefix = wrapped.slice(WRAPPED_KEY_PREFIX.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid wrapped key format: missing IV separator");
  }

  const ivBase64 = withoutPrefix.slice(0, colonIndex);
  const wrappedBase64 = withoutPrefix.slice(colonIndex + 1);

  const iv = fromBase64(ivBase64);
  const wrappedBytes = fromBase64(wrappedBase64);

  // Decrypt to get raw key bytes
  const rawKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    unwrappingKey,
    wrappedBytes as BufferSource,
  );

  // Import as AES-GCM key
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
};

/**
 * Wrap a key using a session token (derives a wrapping key from the token)
 * Incorporates DB_ENCRYPTION_KEY in salt to ensure session tokens alone
 * cannot be used to unwrap keys without access to the encryption key.
 */
export const wrapKeyWithToken = async (
  keyToWrap: CryptoKey,
  sessionToken: string,
): Promise<string> => {
  const encoder = new TextEncoder();
  const tokenKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionToken),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  // Include DB_ENCRYPTION_KEY in salt to prevent session-only attacks
  const salt = encoder.encode(`session-key-wrap:${getEncryptionKeyString()}`);
  const wrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 1, // Fast - token is already high entropy
      hash: "SHA-256",
    },
    tokenKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  const iv = getRandomBytes(12);
  const rawKey = await crypto.subtle.exportKey("raw", keyToWrap);
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    wrappingKey,
    rawKey,
  );

  return `${WRAPPED_KEY_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(wrapped))}`;
};

/**
 * Unwrap a key using a session token
 * Incorporates DB_ENCRYPTION_KEY in salt to match wrapKeyWithToken.
 */
export const unwrapKeyWithToken = async (
  wrapped: string,
  sessionToken: string,
): Promise<CryptoKey> => {
  if (!wrapped.startsWith(WRAPPED_KEY_PREFIX)) {
    throw new Error("Invalid wrapped key format");
  }

  const encoder = new TextEncoder();
  const tokenKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionToken),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  // Include DB_ENCRYPTION_KEY in salt to match wrapKeyWithToken
  const salt = encoder.encode(`session-key-wrap:${getEncryptionKeyString()}`);
  const unwrappingKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 1,
      hash: "SHA-256",
    },
    tokenKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  const withoutPrefix = wrapped.slice(WRAPPED_KEY_PREFIX.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid wrapped key format: missing IV separator");
  }

  const ivBase64 = withoutPrefix.slice(0, colonIndex);
  const wrappedBase64 = withoutPrefix.slice(colonIndex + 1);

  const iv = fromBase64(ivBase64);
  const wrappedBytes = fromBase64(wrappedBase64);

  const rawKey = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    unwrappingKey,
    wrappedBytes as BufferSource,
  );

  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
};

/**
 * =============================================================================
 * RSA Key Pair Generation and Hybrid Encryption
 * =============================================================================
 * RSA-OAEP is used for asymmetric encryption of attendee PII.
 * Public key encrypts (always available), private key decrypts (protected).
 * Hybrid encryption: RSA encrypts a random AES key, AES encrypts the data.
 */

/**
 * Generate an RSA key pair for asymmetric encryption
 * Returns { publicKey, privateKey } as exportable JWK strings
 */
export const generateKeyPair = async (): Promise<{
  publicKey: string;
  privateKey: string;
}> => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: getEnv("TEST_RSA_KEY_SIZE") ? Number(getEnv("TEST_RSA_KEY_SIZE")) : 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );

  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );

  return {
    publicKey: JSON.stringify(publicKeyJwk),
    privateKey: JSON.stringify(privateKeyJwk),
  };
};

/**
 * Import a public key from JWK string
 */
export const importPublicKey = (jwkString: string): Promise<CryptoKey> => {
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
};

/**
 * Import a private key from JWK string
 */
export const importPrivateKey = (jwkString: string): Promise<CryptoKey> => {
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
};

const HYBRID_PREFIX = "hyb:1:";

/**
 * Encrypt data using hybrid encryption (RSA + AES)
 * - Generate random AES key
 * - Encrypt data with AES-GCM
 * - Encrypt AES key with RSA public key
 * Returns format: hyb:1:$base64WrappedKey:$base64iv:$base64ciphertext
 */
export const hybridEncrypt = async (
  plaintext: string,
  publicKey: CryptoKey,
): Promise<string> => {
  // Generate random AES key for this encryption
  const aesKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );

  // Encrypt the data with AES
  const iv = getRandomBytes(12);
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    encoder.encode(plaintext),
  );

  // Export and encrypt the AES key with RSA
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawAesKey,
  );

  return `${HYBRID_PREFIX}${toBase64(new Uint8Array(wrappedKey))}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
};

/**
 * Decrypt data using hybrid encryption
 * Expects format: hyb:1:$base64WrappedKey:$base64iv:$base64ciphertext
 */
export const hybridDecrypt = async (
  encrypted: string,
  privateKey: CryptoKey,
): Promise<string> => {
  if (!encrypted.startsWith(HYBRID_PREFIX)) {
    throw new Error("Invalid hybrid encrypted data format");
  }

  const withoutPrefix = encrypted.slice(HYBRID_PREFIX.length);
  const parts = withoutPrefix.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Invalid hybrid encrypted data format: wrong number of parts",
    );
  }

  const [wrappedKeyB64, ivB64, ciphertextB64] = parts as [
    string,
    string,
    string,
  ];

  // Decrypt the AES key with RSA
  const wrappedKey = fromBase64(wrappedKeyB64);
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    wrappedKey as BufferSource,
  );

  // Import the AES key
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // Decrypt the data with AES
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    ciphertext as BufferSource,
  );

  return new TextDecoder().decode(plaintext);
};

/**
 * Encrypt data with a symmetric key (for wrapping private key with DATA_KEY)
 * Similar to existing encrypt() but takes a key parameter
 */
export const encryptWithKey = async (
  plaintext: string,
  key: CryptoKey,
): Promise<string> => {
  const iv = getRandomBytes(12);
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(plaintext),
  );
  return `${ENCRYPTION_PREFIX}${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`;
};

/**
 * Decrypt data with a symmetric key
 */
export const decryptWithKey = async (
  encrypted: string,
  key: CryptoKey,
): Promise<string> => {
  if (!encrypted.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Invalid encrypted data format");
  }

  const withoutPrefix = encrypted.slice(ENCRYPTION_PREFIX.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error("Invalid encrypted data format: missing IV separator");
  }

  const ivB64 = withoutPrefix.slice(0, colonIndex);
  const ciphertextB64 = withoutPrefix.slice(colonIndex + 1);

  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );

  return new TextDecoder().decode(plaintext);
};

/**
 * Encrypt attendee PII using the public key from settings
 * This can be called without authentication (for public ticket forms)
 */
export const encryptAttendeePII = async (
  plaintext: string,
  publicKeyJwk: string,
): Promise<string> => {
  const publicKey = await importPublicKey(publicKeyJwk);
  return hybridEncrypt(plaintext, publicKey);
};

/**
 * Derive the private key from session credentials
 * Used to decrypt attendee PII in admin views
 */
export const getPrivateKeyFromSession = async (
  sessionToken: string,
  wrappedDataKey: string,
  wrappedPrivateKey: string,
): Promise<CryptoKey> => {
  // Unwrap DATA_KEY using session token
  const dataKey = await unwrapKeyWithToken(wrappedDataKey, sessionToken);

  // Decrypt private key using DATA_KEY
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);

  // Import and return the private key
  return importPrivateKey(privateKeyJwk);
};

/**
 * Decrypt attendee PII using the private key
 * Used in admin views after obtaining private key from session
 */
export const decryptAttendeePII = (
  encrypted: string,
  privateKey: CryptoKey,
): Promise<string> => {
  return hybridDecrypt(encrypted, privateKey);
};
