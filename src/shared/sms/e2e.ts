/**
 * SMS Gate end-to-end encryption (client side).
 *
 * Reproduces the SMS Gateway for Android™ E2E scheme so message text and
 * recipient phone numbers can be encrypted *before* they are handed to the
 * third-party cloud relay (api.sms-gate.app). The relay — and Google FCM —
 * only ever see ciphertext; only the phone, which holds the shared passphrase,
 * can decrypt and send.
 *
 * Scheme (per https://docs.sms-gate.app/privacy/encryption/):
 *   - cipher: AES-256-CBC with PKCS#7 padding (applied by WebCrypto)
 *   - key:    PBKDF2-HMAC-SHA1, 256-bit, configurable iterations (default 75k)
 *   - salt:   16 random bytes per message, which ALSO serve as the AES-CBC IV
 *   - format: $aes-256-cbc/pbkdf2-sha1$i=<iterations>$<base64 salt>$<base64 ct>
 *
 * The encoded string embeds everything needed to decrypt except the passphrase,
 * so it is safe to persist (it is opaque without the passphrase).
 */

import { fromBase64, getRandomBytes, toBase64 } from "#shared/crypto/utils.ts";

/** Fixed prefix of the encoded ciphertext, up to and including `i=`. */
const ALGO_PREFIX = "$aes-256-cbc/pbkdf2-sha1$i=";

/** Salt length in bytes — also the AES-CBC IV length (one AES block). */
const SALT_BYTES = 16;

/** Default PBKDF2 iteration count used by SMS Gate. */
export const DEFAULT_PBKDF2_ITERATIONS = 75_000;

/**
 * Minimum length for the E2E passphrase. This passphrase is the *only* secret
 * protecting attendee phone numbers and message text once they reach the cloud
 * relay, so we require a reasonably long one rather than accepting whatever the
 * owner types.
 */
export const SMS_PASSPHRASE_MIN_LENGTH = 12;

/**
 * Derive the AES-256-CBC key from a passphrase + salt via PBKDF2-HMAC-SHA1.
 */
const deriveKey = async (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { hash: "SHA-1", iterations, name: "PBKDF2", salt: salt as BufferSource },
    keyMaterial,
    { length: 256, name: "AES-CBC" },
    false,
    ["encrypt", "decrypt"],
  );
};

/**
 * Encrypt a single field (e.g. message text or one phone number) for SMS Gate.
 * Each call uses a fresh random salt/IV, so encrypting the same value twice
 * yields different ciphertext.
 */
export const encryptField = async (
  plaintext: string,
  passphrase: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
): Promise<string> => {
  const salt = getRandomBytes(SALT_BYTES);
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { iv: salt as BufferSource, name: "AES-CBC" },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return `${ALGO_PREFIX}${iterations}$${toBase64(salt)}$${toBase64(ciphertext)}`;
};

/**
 * Decrypt a field encoded by {@link encryptField} (or by the SMS Gate app).
 * Throws on malformed input and on wrong-passphrase decryptions that WebCrypto
 * rejects for bad padding or that do not decode as valid UTF-8. AES-CBC is not
 * authenticated, so callers must not treat successful decryption as proof that
 * the passphrase was correct.
 */
export const decryptField = async (
  encoded: string,
  passphrase: string,
): Promise<string> => {
  if (!encoded.startsWith(ALGO_PREFIX)) {
    throw new Error("Invalid SMS E2E ciphertext: bad prefix");
  }
  const parts = encoded.slice(ALGO_PREFIX.length).split("$");
  if (parts.length !== 3) {
    throw new Error("Invalid SMS E2E ciphertext: expected 3 segments");
  }
  const [iterationsStr, saltB64, ciphertextB64] = parts;
  const iterations = Number(iterationsStr);
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error("Invalid SMS E2E ciphertext: bad iteration count");
  }
  const salt = fromBase64(saltB64!);
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = await crypto.subtle.decrypt(
    { iv: salt as BufferSource, name: "AES-CBC" },
    key,
    fromBase64(ciphertextB64!) as BufferSource,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
};
