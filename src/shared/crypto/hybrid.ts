/**
 * RSA key pair generation and hybrid RSA+AES encryption.
 *
 * RSA-OAEP is used for asymmetric encryption of attendee PII.
 * Public key encrypts (always available), private key decrypts (protected).
 * Hybrid encryption: RSA encrypts a random AES key, AES encrypts the data.
 */

import { lazyRef, ttlCache } from "#fp";
import { registerCache } from "#shared/cache-registry.ts";
import {
  AES_KEY_BYTES,
  aesGcmDecryptBytes,
  aesGcmEncryptBytes,
} from "./aes-gcm.ts";
import {
  decryptWithKey,
  formatPrefixed,
  onEncryptionKeyChange,
} from "./encryption.ts";
import { unwrapKeyWithToken } from "./keys.ts";
import type { KeyEncrypted, OwnerKeyEncrypted, WrappedKey } from "./sealed.ts";
import { fromBase64, getRandomBytes } from "./utils.ts";

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

/** Prefix tagging a hybrid (RSA+AES) ciphertext: owner-key activity-log
 * messages and attendee PII. Distinguishes them from env-key {@link
 * ENCRYPTION_PREFIX} values so a decrypt path can route by format. */
export const HYBRID_PREFIX = "hyb:1:";

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
): Promise<OwnerKeyEncrypted> => {
  // The one-off AES key is used once and then wrapped by RSA, so it is made
  // and kept as raw bytes. RSA needs those bytes anyway. The small payloads
  // this handles encrypt faster from bytes than through a Web Crypto key
  // object.
  const aesKeyBytes = getRandomBytes(AES_KEY_BYTES);
  const { iv, ciphertext } = await aesGcmEncryptBytes(
    new TextEncoder().encode(plaintext),
    aesKeyBytes,
  );

  const wrappedKey = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "RSA-OAEP" },
      publicKey,
      aesKeyBytes as BufferSource,
    ),
  );

  return formatPrefixed(
    HYBRID_PREFIX,
    wrappedKey,
    iv,
    ciphertext,
  ) as OwnerKeyEncrypted;
};

/**
 * TTL cache for hybrid decrypt results (60-second expiry).
 * Ciphertext is unique per encryption (random AES key + IV), so it is a safe
 * cache key. The TTL keeps decrypted PII out of memory after a short
 * request window.
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
  encrypted: OwnerKeyEncrypted,
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

  // Unwrap the one-off AES key with RSA, then decrypt straight from its bytes
  const rawAesKey = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      fromBase64(encryptedKey) as BufferSource,
    ),
  );

  const plaintext = await aesGcmDecryptBytes(
    fromBase64(iv),
    fromBase64(ciphertext),
    rawAesKey,
  );

  const result = new TextDecoder().decode(plaintext);
  hybridDecryptCache.set(encrypted, result);
  return result;
};

/**
 * Encrypt a value with the site owner's public key (hybrid RSA+AES).
 * Only the owner's password-derived private key can decrypt it. Used for
 * attendee PII, email-preference blobs, and bulk-email drafts/templates.
 * Can be called without authentication, for example from public ticket forms.
 */
export const encryptWithOwnerKey = async (
  plaintext: string,
  publicKeyJwk: string,
): Promise<OwnerKeyEncrypted> => {
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
  wrappedDataKey: WrappedKey,
  wrappedPrivateKey: KeyEncrypted,
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
 * Decrypt a value encrypted with {@link encryptWithOwnerKey}. The owner's
 * private key comes from the session in admin views.
 */
export const decryptWithOwnerKey = (
  encrypted: OwnerKeyEncrypted,
  privateKey: CryptoKey,
): Promise<string> => hybridDecrypt(encrypted, privateKey);

/**
 * Invalidate keys caches when the encryption key changes.
 * Registered via onEncryptionKeyChange so setEncryptionKeyForTest automatically
 * clears all derived caches without a separate clearEncryptionKeyCache export.
 */
onEncryptionKeyChange(() => {
  privateKeyCache.clear();
  hybridDecryptCache.clear();
});
