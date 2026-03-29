/**
 * Symmetric AES-GCM encryption, key import, and binary encryption format
 */

import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";
import { fromBase64, getRandomBytes, toBase64 } from "./utils.ts";

/**
 * Encryption format version prefix
 * Format: enc:1:$base64iv:$base64ciphertext
 */
const ENCRYPTION_PREFIX = "enc:1:";

export const decodeKeyBytes = (keyString: string): Uint8Array => {
  const keyBytes = fromBase64(keyString);

  if (keyBytes.length !== 32) {
    throw new Error(
      `DB_ENCRYPTION_KEY must be 32 bytes (256 bits), got ${keyBytes.length} bytes`,
    );
  }

  return keyBytes;
};

/**
 * Module-level override for the encryption key string.
 * Bypasses Deno.env to avoid races between parallel test workers.
 * When set to a string, that value is used instead of reading Deno.env.
 * Setting to null reverts to reading from the environment.
 */
const [getEncryptionKeyOverride, setEncryptionKeyOverride] = lazyRef<
  string | null
>(() => null);

/**
 * Callbacks invoked when the encryption key changes (test key override or rotation).
 * Used by sibling modules (e.g. keys.ts) to invalidate derived caches.
 */
const keyChangeCallbacks: (() => void)[] = [];
export const onEncryptionKeyChange = (cb: () => void): void => {
  keyChangeCallbacks.push(cb);
};

/**
 * Explicitly set or clear the encryption key for testing.
 * Bypasses Deno.env to avoid races between parallel test workers.
 * Automatically clears all crypto caches (encryption, HMAC, and any registered via onEncryptionKeyChange).
 */
export const setEncryptionKeyForTest = (key: string | null): void => {
  setEncryptionKeyOverride(key);
  setEncKeyResolved(null);
  setHmacKeyResolved(null);
  for (const cb of keyChangeCallbacks) cb();
};

/**
 * Get the encryption key bytes from environment variable (sync validation only)
 * Expects DB_ENCRYPTION_KEY to be a base64-encoded 256-bit (32 byte) key
 */
export const getEncryptionKeyString = (): string => {
  const keyString = getEncryptionKeyOverride() ?? getEnv("DB_ENCRYPTION_KEY");

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
 * Import a CryptoKey from DB_ENCRYPTION_KEY.
 */
export const importKey = async (
  algorithm: Parameters<SubtleCrypto["importKey"]>[2],
  usages: KeyUsage[],
): Promise<CryptoKey> => {
  const keyBytes = decodeKeyBytes(getEncryptionKeyString());
  return await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    algorithm,
    false,
    usages,
  );
};

/**
 * Cached encryption key — avoids repeated async key imports and
 * env reads when multiple columns are decrypted in parallel.
 */
const [getEncKeyResolved, setEncKeyResolved] = lazyRef<CryptoKey | undefined>(
  () => undefined,
);

const importEncryptionKey = async (): Promise<CryptoKey> => {
  const resolved = getEncKeyResolved();
  if (resolved) return resolved;
  const key = await importKey({ name: "AES-GCM" }, ["encrypt", "decrypt"]);
  setEncKeyResolved(key);
  return key;
};

/**
 * Validate encryption key is present and valid
 * Call this on startup to fail fast if key is missing
 */
export const validateEncryptionKey = (): void => {
  getEncryptionKeyString();
};

/** AES-GCM encrypt raw data, returning IV and ciphertext bytes */
export const aesGcmEncryptRaw = async (
  data: BufferSource,
  key: CryptoKey,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> => {
  const iv = getRandomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    data,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
};

/** AES-GCM decrypt raw data, returning the decrypted ArrayBuffer */
export const aesGcmDecryptRaw = (
  iv: Uint8Array,
  ciphertext: Uint8Array,
  key: CryptoKey,
): Promise<ArrayBuffer> =>
  crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );

/** Format IV + ciphertext as a prefixed base64 string */
export const formatPrefixed = (
  prefix: string,
  ...parts: Uint8Array[]
): string => `${prefix}${parts.map(toBase64).join(":")}`;

/**
 * Encrypt plaintext with an AES-GCM key, returning prefixed format: enc:1:$base64iv:$base64ciphertext
 */
export const symmetricEncrypt = async (
  plaintext: string,
  key: CryptoKey,
): Promise<string> => {
  const { iv, ciphertext } = await aesGcmEncryptRaw(
    new TextEncoder().encode(plaintext),
    key,
  );
  return formatPrefixed(ENCRYPTION_PREFIX, iv, ciphertext);
};

/**
 * Encrypt a string value using AES-256-GCM via Web Crypto API
 * Returns format: enc:1:$base64iv:$base64ciphertext
 * Note: ciphertext includes auth tag appended (Web Crypto API does this automatically)
 */
export const encrypt = async (plaintext: string): Promise<string> => {
  const key = await importEncryptionKey();
  return symmetricEncrypt(plaintext, key);
};

/**
 * Parse a prefixed encrypted payload into IV and ciphertext bytes.
 * Validates the prefix and separator; throws on invalid format.
 */
export const parseEncryptedPayload = (
  encrypted: string,
  prefix: string,
  label: string,
): { iv: Uint8Array; ciphertext: Uint8Array } => {
  if (!encrypted.startsWith(prefix)) {
    throw new Error(`Invalid ${label} format`);
  }
  const withoutPrefix = encrypted.slice(prefix.length);
  const colonIndex = withoutPrefix.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid ${label} format: missing IV separator`);
  }
  return {
    iv: fromBase64(withoutPrefix.slice(0, colonIndex)),
    ciphertext: fromBase64(withoutPrefix.slice(colonIndex + 1)),
  };
};

/**
 * Decrypt a prefixed AES-GCM payload with the given key.
 */
export const symmetricDecrypt = async (
  encrypted: string,
  key: CryptoKey,
): Promise<string> => {
  const { iv, ciphertext } = parseEncryptedPayload(
    encrypted,
    ENCRYPTION_PREFIX,
    "encrypted data",
  );
  const plaintext = await aesGcmDecryptRaw(iv, ciphertext, key);
  return new TextDecoder().decode(plaintext);
};

/**
 * Decrypt a string value encrypted with encrypt()
 * Expects format: enc:1:$base64iv:$base64ciphertext
 */
export const decrypt = async (encrypted: string): Promise<string> => {
  const key = await importEncryptionKey();
  return symmetricDecrypt(encrypted, key);
};

/**
 * Binary encryption format for files (no base64 overhead).
 * Layout: ENCB (4 bytes) + version (1 byte) + IV (12 bytes) + ciphertext
 * This replaces the legacy text-based format which double-base64-encoded
 * data, inflating a 25MB file to ~44MB on disk and ~100MB peak in memory.
 */
const BINARY_MAGIC = new Uint8Array([0x45, 0x4e, 0x43, 0x42]); // "ENCB"
const BINARY_VERSION = 0x01;
const BINARY_HEADER_SIZE = BINARY_MAGIC.length + 1 + 12; // magic + version + IV

/**
 * Encrypt binary data with AES-256-GCM using compact binary format.
 * Output: ENCB + version byte + 12-byte IV + ciphertext (with GCM auth tag).
 * Overhead is only 33 bytes (vs ~76% bloat in the legacy text format).
 */
export const encryptBytes = async (data: Uint8Array): Promise<Uint8Array> => {
  const key = await importEncryptionKey();
  const { iv, ciphertext } = await aesGcmEncryptRaw(data as BufferSource, key);
  const result = new Uint8Array(BINARY_HEADER_SIZE + ciphertext.length);
  result.set(BINARY_MAGIC, 0);
  result[BINARY_MAGIC.length] = BINARY_VERSION;
  result.set(iv, BINARY_MAGIC.length + 1);
  result.set(ciphertext, BINARY_HEADER_SIZE);
  return result;
};

/** Check if encrypted bytes use the binary ENCB format */
const isBinaryFormat = (data: Uint8Array): boolean =>
  data.length >= BINARY_HEADER_SIZE &&
  data[0] === BINARY_MAGIC[0] &&
  data[1] === BINARY_MAGIC[1] &&
  data[2] === BINARY_MAGIC[2] &&
  data[3] === BINARY_MAGIC[3];

/**
 * Decrypt binary data encrypted with encryptBytes().
 * Expects ENCB binary format: magic + version + IV + ciphertext.
 */
export const decryptBytes = async (
  encrypted: Uint8Array,
): Promise<Uint8Array> => {
  if (!isBinaryFormat(encrypted)) {
    throw new Error("Invalid binary encryption format");
  }
  const version = encrypted[BINARY_MAGIC.length];
  if (version !== BINARY_VERSION) {
    throw new Error(`Unsupported binary encryption version: ${version}`);
  }
  const iv = encrypted.slice(BINARY_MAGIC.length + 1, BINARY_HEADER_SIZE);
  const ciphertext = encrypted.slice(BINARY_HEADER_SIZE);
  const key = await importEncryptionKey();
  const plaintext = await aesGcmDecryptRaw(iv, ciphertext, key);
  return new Uint8Array(plaintext);
};

/**
 * Encrypt data with a symmetric key (for wrapping private key with DATA_KEY)
 */
export const encryptWithKey = (
  plaintext: string,
  key: CryptoKey,
): Promise<string> => symmetricEncrypt(plaintext, key);

/**
 * Decrypt data with a symmetric key
 */
export const decryptWithKey = (
  encrypted: string,
  key: CryptoKey,
): Promise<string> => symmetricDecrypt(encrypted, key);

/**
 * Cached HMAC key — avoids repeated async key imports
 */
const [getHmacKeyResolved, setHmacKeyResolved] = lazyRef<CryptoKey | undefined>(
  () => undefined,
);

export const importHmacKey = async (): Promise<CryptoKey> => {
  const resolved = getHmacKeyResolved();
  if (resolved) return resolved;
  const key = await importKey({ name: "HMAC", hash: "SHA-256" }, ["sign"]);
  setHmacKeyResolved(key);
  return key;
};

