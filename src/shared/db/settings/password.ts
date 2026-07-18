/**
 * Owner password change — unwrap the DATA_KEY with the account's current
 * scheme (v2 from raw password, v1 from its stored hash), then re-wrap under
 * the v2 password-bound KEK. Updates the user row, drops every existing
 * session (force re-login), and returns false when the unwrap fails (a wrong
 * current password).
 */

import { encrypt } from "#shared/crypto/encryption.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  unwrapKey,
  wrapDataKeyForPassword,
} from "#shared/crypto/keys.ts";
import type { PasswordHash, WrappedKey } from "#shared/crypto/sealed.ts";
import { execute } from "#shared/db/client.ts";
import { deleteAllSessions } from "#shared/db/sessions.ts";

export const updateUserPassword = async (
  userId: number,
  opts: {
    oldPassword: string;
    oldPasswordHash: PasswordHash;
    oldWrappedDataKey: WrappedKey;
    oldKekVersion: number;
    newPassword: string;
  },
): Promise<boolean> => {
  // Unwrap with the account's current scheme (v2 from the raw old password, v1
  // from its stored hash), then always re-wrap under the v2 password-bound KEK.
  const oldKek =
    opts.oldKekVersion >= 2
      ? await deriveKEKFromPassword(opts.oldPassword, opts.oldPasswordHash)
      : await deriveKEK(opts.oldPasswordHash);
  let dk: CryptoKey;
  try {
    dk = await unwrapKey(opts.oldWrappedDataKey, oldKek);
  } catch {
    return false;
  }
  const newHash = await hashPassword(opts.newPassword);
  const encryptedNewHash = await encrypt(newHash);
  const newWrappedDataKey = await wrapDataKeyForPassword(
    dk,
    opts.newPassword,
    newHash,
  );
  await execute(
    "UPDATE users SET password_hash = ?, wrapped_data_key = ?, kek_version = 2 WHERE id = ?",
    [encryptedNewHash, newWrappedDataKey, userId],
  );
  await deleteAllSessions();
  return true;
};
