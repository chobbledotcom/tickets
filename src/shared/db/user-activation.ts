/**
 * Password writes on the users table: the two invite activations, and the move
 * of a DATA_KEY wrap to the password-bound (v2) KEK.
 */

import { encrypt } from "#crypto/encryption.ts";
import { hashPassword } from "#crypto/hashing.ts";
import { unwrapKeyWithToken, wrapDataKeyForPassword } from "#crypto/keys.ts";
import type { PasswordHash, WrappedKey } from "#crypto/sealed.ts";
import { execute } from "#db/client.ts";
import { executeChangedRow } from "#db/guarded-writes.ts";
import {
  type Condition,
  equal,
  lessThan,
  notEqual,
} from "#db/select/expression.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type Changes, update } from "#db/write.ts";

/** Hash a new password, and give the columns that both activations write: the
 *  encrypted hash, the v2 KEK version, and the cleared invite fields. */
const activationOf = async (password: string) => {
  const passwordHash = await hashPassword(password);
  const [encryptedHash, encryptedEmpty] = await Promise.all([
    encrypt(passwordHash),
    encrypt(""),
  ]);
  return {
    columns: {
      invite_code_hash: encryptedEmpty,
      invite_expiry: encryptedEmpty,
      kek_version: 2,
      password_hash: encryptedHash,
    },
    passwordHash,
  };
};

/** The DATA_KEY of a user, and the password that its v2 KEK binds. */
type PasswordWrap = {
  dataKey: CryptoKey;
  password: string;
  passwordHash: PasswordHash;
};

/** The update that stores the DATA_KEY wrapped under the password-bound (v2)
 *  KEK, with `changes`, on the row of the user where `guard` holds. */
const passwordWrapUpdate = async (
  userId: number,
  wrap: PasswordWrap,
  guard: (user: Node<"users">) => Condition,
  changes: Changes<"users"> = {},
) =>
  update(tables.users, {
    ...changes,
    kek_version: 2,
    wrapped_data_key: await wrapDataKeyForPassword(
      wrap.dataKey,
      wrap.password,
      wrap.passwordHash,
    ),
  }).where((user) => [equal(user.id, userId), guard(user)]);

/**
 * Complete an invite. The single-use invite code unwraps the DATA_KEY handoff,
 * and the v2 KEK of the new password wraps it again. The update clears the
 * code, the expiry, and the handoff. The caller checked the invite and its
 * handoff first.
 *
 * The update changes the row only while the handoff is there. If two submits
 * race, or one is sent again, only the first changes a row. The others give
 * false and keep the password and the key that the first submit set.
 */
export const acceptInvite = async (
  userId: number,
  inviteWrappedDataKey: WrappedKey,
  inviteCode: string,
  password: string,
): Promise<boolean> => {
  const { columns, passwordHash } = await activationOf(password);
  const dataKey = await unwrapKeyWithToken(inviteWrappedDataKey, inviteCode);
  return executeChangedRow(
    await passwordWrapUpdate(
      userId,
      { dataKey, password, passwordHash },
      (user) => notEqual(user.invite_wrapped_data_key, null),
      { ...columns, invite_wrapped_data_key: null },
    ),
  );
};

/**
 * Complete a keyless invite. An editor holds no DATA_KEY, so there is no
 * handoff to unwrap. The password only authenticates.
 *
 * The update changes the row only while `password_hash` is empty, the mark of
 * an inactive user that pruning also reads. A second submit changes no row and
 * keeps the password that the first submit set.
 */
export const activateKeylessUser = async (
  userId: number,
  password: string,
): Promise<boolean> => {
  const { columns } = await activationOf(password);
  return executeChangedRow(
    update(tables.users, columns).where({ id: userId, password_hash: "" }),
  );
};

/**
 * Wrap the DATA_KEY of a v1 user under the password-bound (v2) KEK. The login
 * calls it, because only the login holds the password and the open DATA_KEY.
 * The encrypted data does not change.
 *
 * The update changes the row only while it is still v1. A login can read a
 * stale cached row after a password change in another isolate. That change
 * wrote a v2 wrap for the new password. A wrap from the old password then
 * locks the account out. When no row changes, the login still holds the
 * DATA_KEY for its own session.
 */
export const migrateUserToV2Kek = async (
  userId: number,
  dataKey: CryptoKey,
  password: string,
  passwordHash: PasswordHash,
): Promise<void> => {
  await execute(
    await passwordWrapUpdate(
      userId,
      { dataKey, password, passwordHash },
      (user) => lessThan(user.kek_version, 2),
    ),
  );
};
