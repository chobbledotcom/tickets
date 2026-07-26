/**
 * AES-256-GCM over raw key bytes.
 *
 * Two implementations do the same job, and each is faster at a different size:
 * node:crypto is synchronous, so it wins on the small values that dominate
 * (a name, a log line, a wrapped key), while Web Crypto wins on large blobs and
 * hands them to a threadpool instead of blocking the event loop. Callers do not
 * choose — {@link aesGcmEncryptBytes} and {@link aesGcmDecryptBytes} pick by
 * payload size, and both write the same bytes, so a value encrypted by one is
 * always readable by the other.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { concatBytes, getRandomBytes } from "./utils.ts";

/** Key length AES-256 takes, in bytes. */
export const AES_KEY_BYTES = 32;

/** Length of the authentication tag appended to every ciphertext, in bytes. */
const GCM_TAG_BYTES = 16;

/** Length of the initialisation vector, in bytes. */
const IV_BYTES = 12;

/**
 * Payload size at/below which node:crypto's synchronous AES-GCM beats Web Crypto
 * (whose fixed per-call overhead dominates small inputs) while its event-loop
 * blocking stays negligible. Larger blobs (files/backups) use Web Crypto, which
 * is faster above this size and offloads to a threadpool instead of blocking.
 */
const NODE_AES_MAX_BYTES = 64 * 1024;

/** The IV and ciphertext bytes one AES-GCM encryption produces. */
export type AesGcmEncrypted = { iv: Uint8Array; ciphertext: Uint8Array };

/** Hands back the Web Crypto key the large-payload path needs. Nothing imports
 * a key until a payload is actually big enough to want one. */
export type WebKeySource = () => Promise<CryptoKey>;

/**
 * AES-256-GCM encrypt via node:crypto (synchronous, raw key bytes).
 * Output matches the Web Crypto layout — ciphertext with the tag appended —
 * so values stay interoperable with the Web Crypto paths.
 */
const nodeAesGcmEncrypt = (
  data: Uint8Array,
  keyBytes: Uint8Array,
): AesGcmEncrypted => {
  const iv = getRandomBytes(IV_BYTES);
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

/** AES-GCM encrypt raw data with an imported key, returning IV and ciphertext */
export const aesGcmEncryptRaw = async (
  data: BufferSource,
  key: CryptoKey,
): Promise<AesGcmEncrypted> => {
  const iv = getRandomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { iv: iv as BufferSource, name: "AES-GCM" },
    key,
    data,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
};

/** AES-GCM encrypt a text string with an imported key */
export const aesGcmEncryptText = (
  plaintext: string,
  key: CryptoKey,
): Promise<AesGcmEncrypted> =>
  aesGcmEncryptRaw(new TextEncoder().encode(plaintext), key);

/** AES-GCM decrypt raw data with an imported key */
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

/** Curried by usage, then by key bytes, so each entry point below already has
 * the key source it would otherwise have to spell out. */
const importsAesKey =
  (usage: "encrypt" | "decrypt") =>
  (keyBytes: Uint8Array): WebKeySource =>
  () =>
    crypto.subtle.importKey(
      "raw",
      keyBytes as BufferSource,
      { name: "AES-GCM" },
      false,
      [usage],
    );

const importsEncryptKey = importsAesKey("encrypt");
const importsDecryptKey = importsAesKey("decrypt");

/**
 * AES-GCM encrypt with raw key bytes, using whichever implementation is faster
 * for this payload.
 *
 * `webKey` lets a caller that already holds (or caches) the matching Web Crypto
 * key hand it over instead of importing a fresh one; it is only called when the
 * payload is large enough to take the Web Crypto path.
 */
export const aesGcmEncryptBytes = async (
  data: Uint8Array,
  keyBytes: Uint8Array,
  webKey: WebKeySource = importsEncryptKey(keyBytes),
): Promise<AesGcmEncrypted> =>
  data.length <= NODE_AES_MAX_BYTES
    ? nodeAesGcmEncrypt(data, keyBytes)
    : await aesGcmEncryptRaw(data as BufferSource, await webKey());

/**
 * AES-GCM decrypt with raw key bytes. The mirror of {@link aesGcmEncryptBytes};
 * note it measures the ciphertext, which carries the tag the plaintext does not.
 *
 * Anything too short to hold a tag never came from this format, so it is
 * rejected by name rather than left to fail as a bad tag — reading a tag out of
 * it would take bytes from the wrong end of the value.
 */
export const aesGcmDecryptBytes = async (
  iv: Uint8Array,
  ciphertext: Uint8Array,
  keyBytes: Uint8Array,
  webKey: WebKeySource = importsDecryptKey(keyBytes),
): Promise<Uint8Array> => {
  if (ciphertext.length < GCM_TAG_BYTES) {
    throw new Error(
      `Encrypted value is too short: ${ciphertext.length} bytes cannot hold a ${GCM_TAG_BYTES}-byte authentication tag`,
    );
  }
  return ciphertext.length <= NODE_AES_MAX_BYTES
    ? nodeAesGcmDecrypt(iv, ciphertext, keyBytes)
    : new Uint8Array(await aesGcmDecryptRaw(iv, ciphertext, await webKey()));
};
