/**
 * Owner-key derivation helpers for offline operator paths.
 *
 * `deriveOwnerKek` is the v1/v2 KEK dispatch for an owner account. The login
 * flow runs the same dispatch inline in `auth.ts`.
 *
 * The migration-readiness verifier derives the site private key with these
 * helpers from an owner password. It then decrypts attendee PII and
 * merge-reference charges in-process.
 */

import { decryptWithKey } from "#crypto/encryption.ts";
import { importPrivateKey } from "#crypto/hybrid.ts";
import { deriveKEK, deriveKEKFromPassword } from "#crypto/keys.ts";
import type { KeyEncrypted, PasswordHash } from "#crypto/sealed.ts";

/** The KEK for an owner account: the password-bound v2 scheme for an account
 *  on v2, otherwise the legacy v1 scheme keyed by the stored hash. */
export const deriveOwnerKek = (
  password: string,
  passwordHash: PasswordHash,
  kekVersion: number,
): Promise<CryptoKey> =>
  kekVersion >= 2
    ? deriveKEKFromPassword(password, passwordHash)
    : deriveKEK(passwordHash);

/** Decrypt the owner's wrapped private key (the RSA key that protects attendee
 *  PII) with a DATA_KEY. The verifier unwraps the DATA_KEY from the owner
 *  password first, then calls this. */
export const privateKeyFromDataKey = async (
  dataKey: CryptoKey,
  wrappedPrivateKey: KeyEncrypted,
): Promise<CryptoKey> => {
  const privateKeyJwk = await decryptWithKey(wrappedPrivateKey, dataKey);
  return importPrivateKey(privateKeyJwk);
};
