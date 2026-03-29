/**
 * Key management: KEK derivation, key wrapping, RSA key pairs, hybrid encryption, PII
 */

import { ttlCache } from "#fp";
import { registerCache } from "#lib/cache-registry.ts";
import { getEnv } from "#lib/env.ts";
import { fromBase64 } from "./utils.ts";
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
    { name: "AES-GCM", length: 256 },
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
      name: "PBKDF2",
      salt,
      iterations: 1, // Fast - token is already high entropy
      hash: "SHA-256",
    },
    tokenKey,
    { name: "AES-GCM", length: 256 },
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
      modulusLength: getEnv("TEST_RSA_KEY_SIZE")
        ? Number(getEnv("TEST_RSA_KEY_SIZE"))
        : 2048,
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

/** Import an RSA-OAEP key from JWK string with the given usage */
const importRsaKey = (
  jwkString: string,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> => {
  const jwk = JSON.parse(jwkString) as JsonWebKey;
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
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
  name: "decrypt",
  entries: hybridDecryptCache.size(),
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
    { name: "AES-GCM", length: 256 },
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
 * Private key cache with TTL (10 seconds, matching session cache)
 * Avoids re-running the full unwrap chain (PBKDF2 + AES + RSA import) per request
 */
const privateKeyCache = ttlCache<string, CryptoKey>(10_000);

registerCache(() => ({ name: "privateKeys", entries: privateKeyCache.size() }));

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
 * Decrypt attendee PII using the private key
 * Used in admin views after obtaining private key from session
 */
export const decryptAttendeePII = (
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
