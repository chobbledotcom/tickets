import { decryptWithKey, encrypt, encryptWithKey } from "#crypto/encryption.ts";
import { hashPassword, hmacHash } from "#crypto/hashing.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  unwrapKey,
  wrapKey,
} from "#crypto/keys.ts";
import { getDb } from "#db/client.ts";
import { tables } from "#db/select/tables.ts";
import {
  getUserByUsername,
  invalidateUsersCache,
  verifyUserPassword,
} from "#db/users.ts";
import { insertInto } from "#db/write.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import type { User } from "#types";

/** Unwrap a v2 user's DATA_KEY with the per-user-salted password KEK. The salt
 * folds in the account's stored hash, so we re-derive it from the password. */
export const unwrapUserKey = async (
  user: User,
  password: string,
): Promise<CryptoKey> => {
  const hash = (await verifyUserPassword(user, password))!;
  return unwrapKey(
    user.wrapped_data_key!,
    await deriveKEKFromPassword(password, hash),
  );
};

/** Unwrap the shared owner DATA_KEY (created at v2 by setup). */
export const ownerDataKey = async (): Promise<CryptoKey> => {
  const owner = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
  return unwrapUserKey(owner, TEST_ADMIN_PASSWORD);
};

/** Seed a legacy (v1) manager that shares the owner DATA_KEY, wrapped with the
 * hash-derived KEK and kek_version left at 1 — the shape login must migrate. */
export const seedV1User = async (
  username: string,
  password: string,
): Promise<User> => {
  const dataKey = await ownerDataKey();
  const passwordHash = await hashPassword(password);
  const wrapped = await wrapKey(dataKey, await deriveKEK(passwordHash));
  await getDb().execute(
    insertInto(tables.users, {
      adminLevel: await encrypt("manager"),
      kekVersion: 1,
      passwordHash: await encrypt(passwordHash),
      usernameHash: await encrypt(username),
      usernameIndex: await hmacHash(username),
      wrappedDataKey: wrapped,
    }),
  );
  invalidateUsersCache();
  return (await getUserByUsername(username))!;
};

/** Whether the owner DATA_KEY and the given user's data key are the same key. */
export const sharesOwnerDataKey = async (
  userDataKey: CryptoKey,
): Promise<boolean> => {
  const sealed = await encryptWithKey("shared-secret", await ownerDataKey());
  return (await decryptWithKey(sealed, userDataKey)) === "shared-secret";
};
