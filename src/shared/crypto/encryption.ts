/**
 * Symmetric AES-GCM encryption, key import, and binary encryption format
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { lazyRef } from "#fp";
import { getEnv } from "#shared/env.ts";
import { fromBase64, getRandomBytes, toBase64 } from "./utils.ts";

/**
 * Encryption format version prefix
 * Format: enc:1:$base64iv:$base64ciphertext
 *
 * Tags symmetric DB_ENCRYPTION_KEY ciphertext, distinguishing it from hybrid
 * owner-key values (see HYBRID_PREFIX in keys.ts) — the activity-log backfill
 * keys off this prefix to find legacy rows still to re-encrypt.
 */
export const ENCRYPTION_PREFIX = "enc:1:";

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
export function onEncryptionKeyChange(cb: () => void): void {
  keyChangeCallbacks.push(cb);
}

/**
 * Explicitly set or clear the encryption key for testing.
 * Bypasses Deno.env to avoid races between parallel test workers.
 * Automatically clears all crypto caches (encryption, HMAC, and any registered via onEncryptionKeyChange).
 */
export const setEncryptionKeyForTest = (key: string | null): void => {
  setEncryptionKeyOverride(key);
  setEncKeyResolved(null);
  setEncKeyBytesResolved(null);
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
 * Cached raw encryption-key bytes for the node:crypto fast paths.
 * node:crypto needs the raw 32-byte key (not a CryptoKey), so the decoded bytes
 * are cached separately from the Web Crypto CryptoKey used for large blobs.
 */
const [getEncKeyBytesResolved, setEncKeyBytesResolved] = lazyRef<
  Uint8Array | undefined
>(() => undefined);

/** Raw 256-bit encryption key bytes, decoded once from DB_ENCRYPTION_KEY */
export const getEncryptionKeyBytes = (): Uint8Array => {
  const resolved = getEncKeyBytesResolved();
  if (resolved) return resolved;
  const bytes = decodeKeyBytes(getEncryptionKeyString());
  setEncKeyBytesResolved(bytes);
  return bytes;
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
    { iv: iv as BufferSource, name: "AES-GCM" },
    key,
    data,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
};

/** AES-GCM decrypt raw data, returning the decrypted ArrayBuffer */
export const aesGcmDecryptRaw = (
  iv: Uint8Array,
  ciphertext: Uint8Array,
  key: CryptoKey,
): Promise<ArrayBuffer> =>
  crypto.subtle.decrypt(
    { iv: iv as BufferSource, name: "AES-GCM" },
    key,
    ciphertext as BufferSource,
  );

/** GCM auth-tag length appended to ciphertext (matches the Web Crypto layout) */
const GCM_TAG_BYTES = 16;

/**
 * Payload size at/below which node:crypto's synchronous AES-GCM beats Web Crypto
 * (whose fixed per-call overhead dominates small inputs) while its event-loop
 * blocking stays negligible. Larger blobs (files/backups) use Web Crypto, which
 * is faster above this size and offloads to a threadpool instead of blocking.
 */
const NODE_AES_MAX_BYTES = 64 * 1024;

/** Concatenate byte arrays into a single Uint8Array */
const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/**
 * AES-256-GCM encrypt via node:crypto (synchronous, raw key bytes).
 * Output matches the Web Crypto layout — ciphertext with the 16-byte auth tag
 * appended — so values stay interoperable with the Web Crypto paths.
 */
const nodeAesGcmEncrypt = (
  data: Uint8Array,
  keyBytes: Uint8Array,
): { ciphertext: Uint8Array; iv: Uint8Array } => {
  const iv = getRandomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, iv);
  const ciphertext = concatBytes(
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  );
  return { ciphertext, iv };
};

/** AES-256-GCM decrypt via node:crypto (synchronous, raw key bytes) */
const nodeAesGcmDecrypt = (
  iv: Uint8Array,
  ciphertext: Uint8Array,
  keyBytes: Uint8Array,
): Uint8Array => {
  const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES);
  const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  return concatBytes(decipher.update(body), decipher.final());
};

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
 * Encrypt a string value using AES-256-GCM via node:crypto (faster than Web
 * Crypto for the small payloads this handles; output stays interoperable).
 * Returns format: enc:1:$base64iv:$base64ciphertext
 * Note: ciphertext includes the GCM auth tag appended.
 */
export const encrypt = async (plaintext: string): Promise<string> => {
  const { ciphertext, iv } = nodeAesGcmEncrypt(
    new TextEncoder().encode(plaintext),
    getEncryptionKeyBytes(),
  );
  return formatPrefixed(ENCRYPTION_PREFIX, iv, ciphertext);
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
    ciphertext: fromBase64(withoutPrefix.slice(colonIndex + 1)),
    iv: fromBase64(withoutPrefix.slice(0, colonIndex)),
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
  const { ciphertext, iv } = parseEncryptedPayload(
    encrypted,
    ENCRYPTION_PREFIX,
    "encrypted data",
  );
  const plaintext = nodeAesGcmDecrypt(iv, ciphertext, getEncryptionKeyBytes());
  return new TextDecoder().decode(plaintext);
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
  const { ciphertext, iv } =
    data.length <= NODE_AES_MAX_BYTES
      ? nodeAesGcmEncrypt(data, getEncryptionKeyBytes())
      : await aesGcmEncryptRaw(
          data as BufferSource,
          await importEncryptionKey(),
        );
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
  if (ciphertext.length <= NODE_AES_MAX_BYTES) {
    return nodeAesGcmDecrypt(iv, ciphertext, getEncryptionKeyBytes());
  }
  const key = await importEncryptionKey();
  return new Uint8Array(await aesGcmDecryptRaw(iv, ciphertext, key));
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
