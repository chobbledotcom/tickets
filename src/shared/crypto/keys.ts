/**
 * Key management: KEK derivation and key wrapping
 */

import { aesGcmDecryptRaw, aesGcmEncryptRaw } from "./aes-gcm.ts";
import {
  formatPrefixed,
  getEncryptionKeyString,
  parseEncryptedPayload,
} from "./encryption.ts";
import { getPbkdf2Iterations } from "./hashing.ts";
import type { PasswordHash, WrappedKey } from "./sealed.ts";

/**
 * The KEK wraps the DATA_KEY in users.wrapped_data_key. Two schemes coexist,
 * and they differ in what a database dump is worth:
 *
 * - v1 derives from the STORED password hash, itself only encrypted with
 *   DB_ENCRYPTION_KEY, so a dump plus that key unwraps the DATA_KEY.
 * - v2 derives from the RAW password, which is never stored, so a dump plus the
 *   env key is not enough. All new wraps use v2.
 *
 * Both keep DB_ENCRYPTION_KEY in the salt, so a KEK always needs the env key.
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
export const deriveKEK = (passwordHash: PasswordHash): Promise<CryptoKey> =>
  deriveKek(passwordHash, "");

/**
 * Password-bound (v2) KEK derived from the raw password. Because the password is
 * never stored, a database dump plus DB_ENCRYPTION_KEY cannot unwrap the
 * DATA_KEY — this is what binds attendee PII at rest to the account password.
 *
 * Salted *per user* with the account's stored password hash (which embeds a
 * random per-user salt) in addition to DB_ENCRYPTION_KEY, so an offline guess
 * must run PBKDF2 once per account rather than once for everyone — one weak
 * password can't be used to unwrap every user's DATA_KEY from a dump. The hash
 * is rewritten together with wrapped_data_key on every password change, so the
 * two never drift.
 */
export const deriveKEKFromPassword = (
  password: string,
  passwordHash: PasswordHash,
): Promise<CryptoKey> => deriveKek(password, `kek-v2:${passwordHash}:`);

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
export const generateDataKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ length: 256, name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);

/**
 * Export a CryptoKey and encrypt it with a wrapping key using AES-GCM.
 * Returns format: wk:1:$base64iv:$base64wrapped
 */
const exportAndWrapKey = async (
  keyToWrap: CryptoKey,
  wrappingKey: CryptoKey,
): Promise<WrappedKey> => {
  const rawKey = await crypto.subtle.exportKey("raw", keyToWrap);
  const { iv, ciphertext } = await aesGcmEncryptRaw(rawKey, wrappingKey);
  return formatPrefixed(WRAPPED_KEY_PREFIX, iv, ciphertext) as WrappedKey;
};

/**
 * Decrypt a wrapped key payload and reimport it as an AES-GCM CryptoKey.
 */
const unwrapAndImportKey = async (
  wrapped: WrappedKey,
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
): Promise<WrappedKey> => exportAndWrapKey(keyToWrap, wrappingKey);

/**
 * Wrap a DATA_KEY under the password-bound (v2) KEK in one step. The single
 * place new wrapped_data_keys are produced — setup, login migration, invite
 * acceptance, password change, and superuser creation all go through here, so
 * the derive-then-wrap pair lives in exactly one spot.
 */
export const wrapDataKeyForPassword = async (
  dataKey: CryptoKey,
  password: string,
  passwordHash: PasswordHash,
): Promise<WrappedKey> =>
  wrapKey(dataKey, await deriveKEKFromPassword(password, passwordHash));

/**
 * Unwrap a symmetric key
 * Expects format: wk:1:$base64iv:$base64wrapped
 */
export const unwrapKey = (
  wrapped: WrappedKey,
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
 * Locks or unlocks a key with a key derived from a session token. Which way it
 * goes decides both the derived key's use and the step that runs.
 */
const withTokenKey =
  <TIn, TOut>(
    use: "decrypt" | "encrypt",
    step: (subject: TIn, tokenKey: CryptoKey) => Promise<TOut>,
  ): ((subject: TIn, sessionToken: string) => Promise<TOut>) =>
  async (subject, sessionToken) =>
    step(subject, await deriveTokenKey(sessionToken, use));

/**
 * Wrap a key using a session token (derives a wrapping key from the token)
 */
export const wrapKeyWithToken = withTokenKey<CryptoKey, WrappedKey>(
  "encrypt",
  exportAndWrapKey,
);

/**
 * Unwrap a key using a session token
 */
export const unwrapKeyWithToken = withTokenKey<WrappedKey, CryptoKey>(
  "decrypt",
  unwrapAndImportKey,
);

/**
 * Unwrap a session's DATA_KEY from its token. An authenticated session that
 * reaches a data-key operation always carries a wrapped data key, so a missing
 * one is a broken invariant — throw rather than invent a key.
 */
export const unwrapSessionDataKey = (session: {
  token: string;
  wrappedDataKey: WrappedKey | null;
}): Promise<CryptoKey> => {
  if (!session.wrappedDataKey) throw new Error("Session key unavailable");
  return unwrapKeyWithToken(session.wrappedDataKey, session.token);
};
