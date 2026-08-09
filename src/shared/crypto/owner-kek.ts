/**
 * Owner-key derivation helpers for offline operator paths.
 *
 * `deriveOwnerKek` is the single v1/v2 KEK dispatch for an owner account; it is
 * the offline counterpart to the login flow's inline dispatch. The migration-
 * readiness verifier uses it to derive the site private key from an
 * owner-authenticated password, decrypting attendee PII and merge-reference
 * charges in-process.
 *
 * The login flow itself keeps its inline dispatch (it then wraps the DATA_KEY
 * under the session token); unifying it onto `deriveOwnerKek` would pull the
 * large `keys.ts` file's whole-file mutation surface into this focused slice,
 * so that consolidation is left as a follow-up.
 */

import { decryptWithKey } from "#shared/crypto/encryption.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  importPrivateKey,
} from "#shared/crypto/keys.ts";
import type { KeyEncrypted, PasswordHash } from "#shared/crypto/sealed.ts";

/** The KEK for an owner account: the password-bound v2 scheme when the account
 *  has migrated to it, otherwise the legacy v1 scheme keyed by the stored hash. */
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
