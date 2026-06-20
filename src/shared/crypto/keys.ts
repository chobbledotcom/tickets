/**
 * Key management: KEK derivation, key wrapping, RSA key pairs, hybrid encryption, PII
 */

import { lazyRef, ttlCache } from "#fp";
import { registerCache } from "#shared/cache-registry.ts";
import {
  aesGcmDecryptRaw,
  aesGcmEncryptRaw,
  decryptWithKey,
  formatPrefixed,
  getEncryptionKeyString,
  onEncryptionKeyChange,
  parseEncryptedPayload,
} from "./encryption.ts";
import { getPbkdf2Iterations } from "./hashing.ts";
import { fromBase64 } from "./utils.ts";

/**
 * =============================================================================
 * Key Encryption Key (KEK) Derivation
 * =============================================================================
 * The KEK wraps the DATA_KEY in users.wrapped_data_key. Two schemes coexist:
 *
 * - v1 ({@link deriveKEK}) derives the KEK from the *stored password hash*. The
 *   hash is itself only encrypted with DB_ENCRYPTION_KEY, so a DB dump plus that
 *   key can re-derive the KEK and unwrap the DATA_KEY — i.e. PII at rest is
 *   protected by the env key alone.
 * - v2 ({@link deriveKEKFromPassword}) derives the KEK from the *raw password*,
 *   which is never stored, so a DB dump plus the env key can no longer unwrap
 *   the DATA_KEY. This is the scheme all new wraps use.
 *
 * Both keep DB_ENCRYPTION_KEY in the salt, so a KEK always needs the env key in
 * addition to its secret.
 */

/**
 * Shared PBKDF2 → AES-GCM KEK derivation. `secret` is the wrap secret (a stored
 * password hash for v1, the raw password for v2); `saltPrefix` domain-separates
 * the two schemes so they can never yield the same KEK from one DB key.
 */
const deriveKek = async (
  secret: string,
  saltPrefix: string,
): Promise<CryptoKey> => {
  const dbKey = getEncryptionKeyString();
  const encoder = new TextEncoder();
  const salt = encoder.encode(`${saltPrefix}${dbKey}`);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations: getPbkdf2Iterations(),
      name: "PBKDF2",
      salt: salt as BufferSource,
    },
    keyMaterial,
    { length: 256, name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
};

/**
 * Legacy (v1) KEK derived from the stored password hash. Retained only to
 * unwrap and migrate existing wrapped_data_keys — new wraps use
 * {@link deriveKEKFromPassword}. Salt prefix is empty so this stays
 * byte-compatible with keys wrapped before the v2 split.
 */
export const deriveKEK = (passwordHash: string): Promise<CryptoKey> =>
  deriveKek(passwordHash, "");

/**
 * Password-bound (v2) KEK derived from the raw password. Because the password is
 * never stored, a database dump plus DB_ENCRYPTION_KEY cannot unwrap the
 * DATA_KEY — this is what binds attendee PII at rest to the account password.
 */
export const deriveKEKFromPassword = (password: string): Promise<CryptoKey> =>
  deriveKek(password, "kek-v2:");

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
  return crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
};

/**
 * Export a CryptoKey and encrypt it with a wrapping key using AES-GCM.
 * Returns format: wk:1:$base64iv:$base64wrapped
 */
const exportAndWrapKey = async (
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> => {
  const rawKey = await crypto.subtle.exportKey("raw", keyToWrap);
  const { iv, ciphertext } = await aesGcmEncryptRaw(rawKey, wrappingKey);
  return formatPrefixed(WRAPPED_KEY_PREFIX, iv, ciphertext);
};

/**
 * Decrypt a wrapped key payload and reimport it as an AES-GCM CryptoKey.
 */
const unwrapAndImportKey = async (
  wrapped: string,
  unwrappingKey: CryptoKey,
): Promise<CryptoKey> => {
  const { iv, ciphertext } = parseEncryptedPayload(
    wrapped,
    WRAPPED_KEY_PREFIX,
    "wrapped key",
  );
  const rawKey = await aesGcmDecryptRaw(iv, ciphertext, unwrappingKey);
  return crypto.subtle.importKey(
    "raw",
    rawKey,
    { length: 256, name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"],
  );
};

/**
 * Wrap a symmetric key with another key using AES-GCM
 * Returns format: wk:1:$base64iv:$base64wrapped
 */
export const wrapKey = (
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<string> => exportAndWrapKey(keyToWrap, wrappingKey);

/**
 * Wrap a DATA_KEY under the password-bound (v2) KEK in one step. The single
 * place new wrapped_data_keys are produced — setup, login migration, invite
 * acceptance, password change, and superuser creation all go through here, so
 * the derive-then-wrap pair lives in exactly one spot.
 */
export const wrapDataKeyForPassword = async (
  dataKey: CryptoKey,
  password: string,
): Promise<string> => wrapKey(dataKey, await deriveKEKFromPassword(password));

/**
 * Unwrap a symmetric key
 * Expects format: wk:1:$base64iv:$base64wrapped
 */
export const unwrapKey = (
  wrapped: string,
  unwrappingKey: CryptoKey,
): Promise<CryptoKey> => unwrapAndImportKey(wrapped, unwrappingKey);

/**
 * Derive a wrapping/unwrapping key from a session token using PBKDF2.
 * Incorporates DB_ENCRYPTION_KEY in salt to ensure session tokens alone
 * cannot be used to wrap/unwrap keys without access to the encryption key.
 */
const deriveTokenKey = async (
  sessionToken: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> => {
  const encoder = new TextEncoder();
  const tokenKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionToken),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  const salt = encoder.encode(`session-key-wrap:${getEncryptionKeyString()}`);
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations: 1, // Fast - token is already high entropy
      name: "PBKDF2",
      salt,
    },
    tokenKey,
    { length: 256, name: "AES-GCM" },
    false,
    [usage],
  );
};

/**
 * Wrap a key using a session token (derives a wrapping key from the token)
 */
export const wrapKeyWithToken = async (
  keyToWrap: CryptoKey,
  sessionToken: string,
): Promise<string> => {
  const wrappingKey = await deriveTokenKey(sessionToken, "encrypt");
  return exportAndWrapKey(keyToWrap, wrappingKey);
};

/**
 * Unwrap a key using a session token
 */
export const unwrapKeyWithToken = async (
  wrapped: string,
  sessionToken: string,
): Promise<CryptoKey> => {
  const unwrappingKey = await deriveTokenKey(sessionToken, "decrypt");
  return unwrapAndImportKey(wrapped, unwrappingKey);
};

/**
 * =============================================================================
 * RSA Key Pair Generation and Hybrid Encryption
 * =============================================================================
 * RSA-OAEP is used for asymmetric encryption of attendee PII.
 * Public key encrypts (always available), private key decrypts (protected).
 * Hybrid encryption: RSA encrypts a random AES key, AES encrypts the data.
 */

/** Module-level override avoids env race in parallel tests */
const [getRsaKeySize, setRsaKeySize] = lazyRef<number | null>(() => null);

/** Explicitly set RSA key size for testing without env var races */
export const setRsaKeySizeForTest = (size: number | null): void =>
  setRsaKeySize(size);

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
      hash: "SHA-256",
      modulusLength: getRsaKeySize() ?? 2048,
      name: "RSA-OAEP",
      publicExponent: new Uint8Array([1, 0, 1]),
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
    privateKey: JSON.stringify(privateKeyJwk),
    publicKey: JSON.stringify(publicKeyJwk),
  };
};

/** Import an RSA-OAEP key from JWK string with the given usage */
const importRsaKey = (
  jwkString: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> => {
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { hash: "SHA-256", name: "RSA-OAEP" },
    false,
    [usage],
  );
};

/**
 * Import a public key from JWK string
 */
export const importPublicKey = (jwkString: string): Promise<CryptoKey> =>
  importRsaKey(jwkString, "encrypt");

/**
 * Import a private key from JWK string
 */
export const importPrivateKey = (jwkString: string): Promise<CryptoKey> =>
  importRsaKey(jwkString, "decrypt");

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
  // Generate random AES key and encrypt the data
  const aesKey = await generateDataKey();
  const { iv, ciphertext } = await aesGcmEncryptRaw(
    new TextEncoder().encode(plaintext),
    aesKey,
  );

  // Export and encrypt the AES key with RSA
  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawAesKey),
  );

  return formatPrefixed(HYBRID_PREFIX, wrappedKey, iv, ciphertext);
};

/**
 * TTL cache for hybrid decrypt results (60-second expiry).
 * Ciphertext is unique per encryption (random AES key + IV), making it a safe cache key.
 * TTL ensures decrypted PII doesn't linger in memory beyond a short request window.
 */
const HYBRID_DECRYPT_TTL_MS = 60_000;
const hybridDecryptCache = ttlCache<string, string>(HYBRID_DECRYPT_TTL_MS);

registerCache(() => ({
  entries: hybridDecryptCache.size(),
  name: "decrypt",
}));

/**
 * Decrypt data using hybrid encryption
 * Expects format: hyb:1:$base64WrappedKey:$base64iv:$base64ciphertext
 * Results are cached in a bounded LRU (ciphertext -> plaintext)
 */
export const hybridDecrypt = async (
  encrypted: string,
  privateKey: CryptoKey,
): Promise<string> => {
  const cached = hybridDecryptCache.get(encrypted);
  if (cached !== undefined) return cached;

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

  const [encryptedKey, iv, ciphertext] = parts as [string, string, string];

  // Decrypt the AES key with RSA
  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    fromBase64(encryptedKey) as BufferSource,
  );

  // Import the AES key and decrypt the data
  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    { length: 256, name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await aesGcmDecryptRaw(
    fromBase64(iv),
    fromBase64(ciphertext),
    aesKey,
  );

  const result = new TextDecoder().decode(plaintext);
  hybridDecryptCache.set(encrypted, result);
  return result;
};

/**
 * Encrypt a value with the site owner's public key (hybrid RSA+AES).
 * Only the owner's password-derived private key can decrypt it. Used for
 * attendee PII, email-preference blobs, and bulk-email drafts/templates.
 * Can be called without authentication (e.g. from public ticket forms).
 */
export const encryptWithOwnerKey = async (
  plaintext: string,
  publicKeyJwk: string,
): Promise<string> => {
  const publicKey = await importPublicKey(publicKeyJwk);
  return hybridEncrypt(plaintext, publicKey);
};

/**
 * Private key cache with TTL (10 seconds, matching session cache)
 * Avoids re-running the full unwrap chain (PBKDF2 + AES + RSA import) per request
 */
const privateKeyCache = ttlCache<string, CryptoKey>(10_000);

registerCache(() => ({ entries: privateKeyCache.size(), name: "privateKeys" }));

/**
 * Derive the private key from session credentials
 * Used to decrypt attendee PII in admin views
 * Results are cached per session token for 10 seconds
 */
export const getPrivateKeyFromSession = async (
  sessionToken: string,
  wrappedDataKey: string,
  wrappedPrivateKey: string,
): Promise<CryptoKey> => {
  const cached = privateKeyCache.get(sessionToken);
  if (cached) return cached;

  // Unwrap DATA_KEY using session token
  const dataKey = await unwrapKeyWithToken(wrappedDataKey, sessionToken);

  // Decrypt private key using DATA_KEY
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);

  // Import and return the private key
  const key = await importPrivateKey(privateKeyJwk);

  privateKeyCache.set(sessionToken, key);
  return key;
};

/**
 * Decrypt a value encrypted with {@link encryptWithOwnerKey}, using the
 * owner's private key (obtained from the session in admin views).
 */
export const decryptWithOwnerKey = (
  encrypted: string,
  privateKey: CryptoKey,
): Promise<string> => {
  return hybridDecrypt(encrypted, privateKey);
};

/**
 * Invalidate keys caches when the encryption key changes.
 * Registered via onEncryptionKeyChange so setEncryptionKeyForTest automatically
 * clears all derived caches without a separate clearEncryptionKeyCache export.
 */
onEncryptionKeyChange(() => {
  privateKeyCache.clear();
  hybridDecryptCache.clear();
});
