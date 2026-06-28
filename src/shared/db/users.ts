/**
 * Users table operations
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  hashPassword,
  hashSessionToken,
  hmacHash,
  verifyPassword,
} from "#shared/crypto/hashing.ts";
import {
  unwrapKeyWithToken,
  wrapDataKeyForPassword,
} from "#shared/crypto/keys.ts";
import {
  deleteByFieldBatch,
  execute,
  insert,
  queryAll,
} from "#shared/db/client.ts";
import {
  createKeyedCache,
  registerCache,
  registerTableInvalidation,
} from "#shared/db/common-schema.ts";
import { now } from "#shared/now.ts";
import { type AdminLevel, isAdminLevel, type User } from "#shared/types.ts";

const USER_COLUMNS =
  "id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, kek_version, invite_wrapped_data_key";

const USER_SELECT = `SELECT ${USER_COLUMNS} FROM users ORDER BY id ASC`;

/** Fetch only the users matching the given blind-index keys, in one query, so a
 * by-username read never loads the whole table. Powers the cache's targeted
 * `getByKey`/`getByKeys` path. */
const fetchUsersByIndex = (keys: string[]): Promise<User[]> =>
  queryAll<User>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username_index IN (${keys
      .map(() => "?")
      .join(", ")})`,
    keys,
  );

export type UserDisplayFields = Pick<
  User,
  "admin_level" | "id" | "username_hash"
>;

const USER_DISPLAY_SELECT =
  "SELECT id, username_hash, admin_level FROM users ORDER BY id ASC";

const USER_ID_SELECT = "SELECT id FROM users ORDER BY id ASC";

const USER_AUTH_SELECT =
  "SELECT id, admin_level FROM users WHERE id = ? LIMIT 1";

export type UserAuthFields = Pick<User, "admin_level" | "id">;

/**
 * Users change rarely and there are few of them, so the cache loads the whole
 * set and answers by-id / by-username reads from it. The TTL is shorter than
 * the listings/groups cache (admin changes should propagate quickly across
 * isolates), but staleness is never authoritative: every user write invalidates
 * immediately, role is fixed at creation, and auth gates on the session (which
 * deleteUser also clears), not on this cache.
 */
const USERS_CACHE_TTL_MS = 15_000;
const usersCache = createKeyedCache<User>({
  fetchAll: () => queryAll<User>(USER_SELECT),
  fetchByKeys: fetchUsersByIndex,
  idOf: (u) => u.id,
  keyOf: (u) => u.username_index,
  ttlMs: USERS_CACHE_TTL_MS,
});

/**
 * Callbacks fired on every users-cache invalidation, so derived caches (e.g.
 * the superuser account-state cache) can clear in lockstep with user writes.
 * Registered once per module at load time, mirroring the cache-stats registry.
 */
const usersInvalidationListeners: Array<() => void> = [];

/** Register a callback to run whenever the users cache is invalidated. */
export const onUsersInvalidated = (listener: () => void): void => {
  usersInvalidationListeners.push(listener);
};

const loadAllUsers = (): Promise<User[]> => usersCache.getAll();

registerCache(() => ({ entries: usersCache.size(), name: "users" }));

/** Invalidate the users cache (for testing or after writes). */
export const invalidateUsersCache = (): void => {
  usersCache.invalidate();
  for (const listener of usersInvalidationListeners) listener();
};

// Any write to the users table clears the cache automatically (db-client layer).
// Must call invalidateUsersCache() (not just usersCache.invalidate()) so that
// onUsersInvalidated listeners such as the superuser account-state cache also fire.
registerTableInvalidation(["users"], invalidateUsersCache);

/** Fields needed to build a users row. */
type InsertUserOpts = {
  username: string;
  adminLevel: AdminLevel;
  passwordHash: string;
  wrappedDataKey: string | null;
  inviteCodeHash: string | null;
  inviteExpiry: string | null;
  kekVersion: number;
  inviteWrappedDataKey: string | null;
};

/**
 * Encrypt a user's fields and build the users INSERT without running it,
 * returning the statement alongside the row values so a caller that executes it
 * can reconstruct the {@link User}.
 */
const buildUserInsert = async (
  opts: InsertUserOpts,
): Promise<{
  statement: ReturnType<typeof insert>;
  values: Omit<User, "id">;
}> => {
  const usernameIndex = await hmacHash(opts.username.toLowerCase());
  const encryptedUsername = await encrypt(opts.username.toLowerCase());
  const encryptedAdminLevel = await encrypt(opts.adminLevel);
  const encryptedPasswordHash = opts.passwordHash
    ? await encrypt(opts.passwordHash)
    : "";
  const encryptedInviteCode = opts.inviteCodeHash
    ? await encrypt(opts.inviteCodeHash)
    : null;
  const encryptedInviteExpiry = opts.inviteExpiry
    ? await encrypt(opts.inviteExpiry)
    : null;

  const values = {
    admin_level: encryptedAdminLevel,
    invite_code_hash: encryptedInviteCode,
    invite_expiry: encryptedInviteExpiry,
    invite_wrapped_data_key: opts.inviteWrappedDataKey,
    kek_version: opts.kekVersion,
    password_hash: encryptedPasswordHash,
    username_hash: encryptedUsername,
    username_index: usernameIndex,
    wrapped_data_key: opts.wrappedDataKey,
  };
  return { statement: insert("users", values), values };
};

/** A user INSERT statement plus the row values needed to rebuild the User. */
type BuiltUserInsert = Awaited<ReturnType<typeof buildUserInsert>>;

/** Execute a built users INSERT and reconstruct the full {@link User}. */
const runUserInsert = async ({
  statement,
  values,
}: BuiltUserInsert): Promise<User> => {
  const result = await execute(statement.sql, statement.args);
  return { id: Number(result.lastInsertRowid), ...values };
};

/** Shared user creation logic */
const insertUser = async (opts: InsertUserOpts): Promise<User> =>
  runUserInsert(await buildUserInsert(opts));

/** Build the opts for an already-activated user (no invite, password-bound). */
const activatedUserOpts = (
  username: string,
  passwordHash: string,
  wrappedDataKey: string | null,
  adminLevel: AdminLevel,
  kekVersion: number,
): InsertUserOpts => ({
  adminLevel,
  inviteCodeHash: null,
  inviteExpiry: null,
  inviteWrappedDataKey: null,
  kekVersion,
  passwordHash,
  username,
  wrappedDataKey,
});

/**
 * Build an activated user's INSERT, then hand the result to `consume`. Lets the
 * "create now" and "give me the statement for a batch" entry points share one
 * parameter list instead of repeating the forwarding.
 */
const consumeActivatedUserInsert =
  <T>(consume: (built: BuiltUserInsert) => T | Promise<T>) =>
  async (
    username: string,
    passwordHash: string,
    wrappedDataKey: string | null,
    adminLevel: AdminLevel,
    kekVersion = 2,
  ): Promise<T> =>
    consume(
      await buildUserInsert(
        activatedUserOpts(
          username,
          passwordHash,
          wrappedDataKey,
          adminLevel,
          kekVersion,
        ),
      ),
    );

/**
 * Create a new (already-activated) user with encrypted fields. Activated users
 * are created at the password-bound KEK scheme (v2); the caller computes the
 * matching wrapped_data_key via wrapDataKeyForPassword.
 */
export const createUser = consumeActivatedUserInsert(runUserInsert);

/**
 * Build the INSERT that {@link createUser} would run, without executing it, so a
 * caller can include the user creation in a batch/transaction with other writes
 * (e.g. initial setup creates the owner atomically alongside its config keys).
 */
export const buildCreateUserStatement = consumeActivatedUserInsert(
  ({ statement }) => statement,
);

/**
 * Create an invited user (no password yet, has invite code). When the inviter
 * passes a wrapped DATA_KEY handoff, the invitee self-activates at /join under
 * the v2 scheme; otherwise an admin activates them later (legacy v1 path).
 * kek_version is a placeholder here — there is no wrapped_data_key until
 * activation, which sets the real version.
 */
export const createInvitedUser = (
  username: string,
  adminLevel: AdminLevel,
  inviteCodeHash: string,
  inviteExpiry: string,
  inviteWrappedDataKey: string | null = null,
): Promise<User> =>
  insertUser({
    adminLevel,
    inviteCodeHash,
    inviteExpiry,
    inviteWrappedDataKey,
    kekVersion: 1,
    passwordHash: "",
    username,
    wrappedDataKey: null,
  });

/**
 * Look up a user by username (using blind index, from cache)
 */
export const getUserByUsername = async (
  username: string,
): Promise<User | null> =>
  usersCache.getByKey(await hmacHash(username.toLowerCase()));

/**
 * Get a user by ID (from cache)
 */
export const getUserById = (id: number): Promise<User | null> =>
  usersCache.getById(id);

/** Get the minimal encrypted user fields needed to authenticate a session. */
export const getUserAuthFieldsById = async (
  id: number,
): Promise<UserAuthFields | null> =>
  (await queryAll<UserAuthFields>(USER_AUTH_SELECT, [id]))[0] ?? null;

/**
 * Check if a username is already taken
 */
export const isUsernameTaken = async (username: string): Promise<boolean> => {
  const user = await getUserByUsername(username);
  return user !== null;
};

/**
 * Get all users (for admin user management page, from cache)
 */
export const getAllUsers = (): Promise<User[]> => loadAllUsers();

/** Get the minimal encrypted user fields needed to show assignable users. */
export const getUserDisplayFields = (): Promise<UserDisplayFields[]> =>
  queryAll<UserDisplayFields>(USER_DISPLAY_SELECT);

/** Get all user ids, ordered by id, for validating submitted user links. */
export const getAllUserIds = async (): Promise<number[]> =>
  (await queryAll<{ id: number }>(USER_ID_SELECT)).map((row) => row.id);

/**
 * Verify a user's password (decrypt stored hash, then verify)
 * Returns the decrypted password hash if valid (needed for KEK derivation)
 */
export const verifyUserPassword = async (
  user: User,
  password: string,
): Promise<string | null> => {
  if (!user.password_hash) return null;
  const decryptedHash = await decrypt(user.password_hash);
  const isValid = await verifyPassword(password, decryptedHash);
  return isValid ? decryptedHash : null;
};

/**
 * Decrypt a user's admin level
 */
export const decryptAdminLevel = async (
  user: Pick<User, "admin_level">,
): Promise<AdminLevel> => {
  const level = await decrypt(user.admin_level);
  if (!isAdminLevel(level)) {
    throw new Error(`Invalid admin level: ${level}`);
  }
  return level;
};

/**
 * Decrypt a user's username
 */
export const decryptUsername = (
  user: Pick<User, "username_hash">,
): Promise<string> => decrypt(user.username_hash);

/**
 * Complete an invite by self-activating the user: unwrap the DATA_KEY handoff
 * with the single-use invite code, re-wrap it under the new password's v2 KEK,
 * and clear the invite (code, expiry, and the handoff blob). The caller has
 * already verified the invite is valid and carries a handoff, so every current
 * invite reaches here — there is no separate admin activation step.
 *
 * Single-use: the UPDATE is guarded on `invite_wrapped_data_key IS NOT NULL`, so
 * if two submissions for the same code race (or one is replayed), only the first
 * affects a row — the rest no-op and return false rather than overwriting the
 * password/key that the first accept already set.
 */
/** Hash a new password and pre-encrypt the values both activation paths write:
 * the encrypted hash and an encrypted empty string (used to clear invite
 * fields). Shared by {@link acceptInvite} and {@link activateKeylessUser}. */
const buildActivationSecrets = async (
  password: string,
): Promise<{
  passwordHash: string;
  encryptedHash: string;
  encryptedEmpty: string;
}> => {
  const passwordHash = await hashPassword(password);
  const [encryptedHash, encryptedEmpty] = await Promise.all([
    encrypt(passwordHash),
    encrypt(""),
  ]);
  return { encryptedEmpty, encryptedHash, passwordHash };
};

export const acceptInvite = async (
  userId: number,
  inviteWrappedDataKey: string,
  inviteCode: string,
  password: string,
): Promise<boolean> => {
  const { passwordHash, encryptedHash, encryptedEmpty } =
    await buildActivationSecrets(password);
  const dataKey = await unwrapKeyWithToken(inviteWrappedDataKey, inviteCode);
  const wrappedDataKey = await wrapDataKeyForPassword(
    dataKey,
    password,
    passwordHash,
  );
  const result = await execute(
    "UPDATE users SET password_hash = ?, wrapped_data_key = ?, kek_version = 2, invite_wrapped_data_key = NULL, invite_code_hash = ?, invite_expiry = ? WHERE id = ? AND invite_wrapped_data_key IS NOT NULL",
    [encryptedHash, wrappedDataKey, encryptedEmpty, encryptedEmpty, userId],
  );
  return result.rowsAffected > 0;
};

/**
 * Complete a **keyless** invite (the editor role): set the password and clear
 * the invite, leaving `wrapped_data_key` NULL. An editor holds no DATA_KEY, so
 * unlike {@link acceptInvite} there is no handoff to unwrap or re-wrap — the
 * password only authenticates; it protects no key. The user's role is fixed at
 * invite time and is not changed here.
 *
 * Single-use: the UPDATE is guarded on `password_hash = ''` (the unactivated
 * marker — buildUserInsert stores a literal empty string until a password is
 * set, and pruneExpiredInvites uses the same marker). So a replay or a race only
 * affects the row on the first submit; later submits no-op and return false
 * rather than overwriting the password the first submit set.
 */
export const activateKeylessUser = async (
  userId: number,
  password: string,
): Promise<boolean> => {
  const { encryptedHash, encryptedEmpty } =
    await buildActivationSecrets(password);
  const result = await execute(
    "UPDATE users SET password_hash = ?, kek_version = 2, invite_code_hash = ?, invite_expiry = ? WHERE id = ? AND password_hash = ''",
    [encryptedHash, encryptedEmpty, encryptedEmpty, userId],
  );
  return result.rowsAffected > 0;
};

/**
 * Re-wrap a user's DATA_KEY under the password-bound (v2) KEK. Called at login —
 * the one place both the raw password and the freshly-unwrapped DATA_KEY are in
 * hand — for users still on the legacy v1 wrap, replacing the DB-recoverable
 * wrap in place without touching any encrypted data.
 */
export const migrateUserToV2Kek = async (
  userId: number,
  dataKey: CryptoKey,
  password: string,
  passwordHash: string,
): Promise<void> => {
  const wrappedDataKey = await wrapDataKeyForPassword(
    dataKey,
    password,
    passwordHash,
  );
  // Guard on the row still being v1. A login can reach here off a stale cached
  // user row whose password was changed in another isolate — that change already
  // wrote a v2 wrap bound to the *new* password. Overwriting it with a wrap
  // derived from this (old) password would leave password_hash and
  // wrapped_data_key bound to different passwords and lock the account out. A
  // no-op is safe: the login already holds the DATA_KEY for its own session.
  await execute(
    "UPDATE users SET wrapped_data_key = ?, kek_version = 2 WHERE id = ? AND kek_version < 2",
    [wrappedDataKey, userId],
  );
};

/**
 * Delete a user and all their sessions and API keys
 */
export const deleteUser = async (userId: number): Promise<void> => {
  await deleteByFieldBatch([
    { field: "user_id", table: "api_keys", value: userId },
    { field: "user_id", table: "sessions", value: userId },
    { field: "user_id", table: "user_logistics_agents", value: userId },
    { field: "id", table: "users", value: userId },
  ]);
};

/**
 * Find a user by invite code hash
 * Scans all users, decrypts invite_code_hash, and compares
 */
export const getUserByInviteCode = async (
  inviteCode: string,
): Promise<User | null> => {
  const codeHash = await hashInviteCode(inviteCode);
  const users = await getAllUsers();

  for (const user of users) {
    if (!user.invite_code_hash) continue;
    const decryptedHash = await decrypt(user.invite_code_hash);
    if (decryptedHash === codeHash) return user;
  }

  return null;
};

/**
 * Hash an invite code using SHA-256
 */
export const hashInviteCode = (code: string): Promise<string> =>
  hashSessionToken(code);

/**
 * Check if a user's invite is still valid (not expired, has invite code)
 */
export const isInviteValid = async (user: User): Promise<boolean> => {
  if (!user.invite_code_hash) return false;

  const decryptedHash = await decrypt(user.invite_code_hash);
  if (!decryptedHash) return false;

  if (!user.invite_expiry) return false;

  const decryptedExpiry = await decrypt(user.invite_expiry);
  if (!decryptedExpiry) return false;
  return new Date(decryptedExpiry) > now();
};

/**
 * Check if a user's invite has expired.
 * Callers should skip this for users who have already set a password.
 */
export const isInviteExpired = async (user: User): Promise<boolean> =>
  user.invite_code_hash !== null && !(await isInviteValid(user));

/**
 * Delete invited users whose invite has expired and who never activated. This
 * removes the invite_wrapped_data_key handoff — a copy of the DATA_KEY wrapped
 * under the invite code — so an intercepted invite link can no longer be used to
 * unwrap it from a database dump once the invite has expired.
 *
 * Only un-activated invites are ever eligible: a row must have no DATA_KEY wrap
 * AND no password set. acceptInvite writes both in one atomic UPDATE, so an
 * activated user (or anyone who has set a password) can never match — the prune
 * cannot delete an active account. invite_expiry is encrypted per row, but only
 * a handful of invites are ever outstanding, so decrypting each is cheap.
 */
export const pruneExpiredInvites = async (): Promise<number> => {
  const rows = await queryAll<Pick<User, "id" | "invite_expiry">>(
    "SELECT id, invite_expiry FROM users WHERE wrapped_data_key IS NULL AND password_hash = '' AND invite_expiry IS NOT NULL",
  );
  const cutoff = now().getTime();
  let pruned = 0;
  for (const row of rows) {
    // An unparseable expiry yields NaN, which compares false — such a row is
    // left alone rather than deleted on a bad value.
    const expiryMs = new Date(await decrypt(row.invite_expiry!)).getTime();
    if (expiryMs < cutoff) {
      await deleteUser(row.id);
      pruned += 1;
    }
  }
  return pruned;
};

/**
 * Stubbable API for testing
 */
export const usersApi = {
  acceptInvite,
  activateKeylessUser,
  createInvitedUser,
  createUser,
  decryptAdminLevel,
  decryptUsername,
  deleteUser,
  getAllUserIds,
  getAllUsers,
  getUserById,
  getUserByInviteCode,
  getUserByUsername,
  getUserDisplayFields,
  hashInviteCode,
  invalidateUsersCache,
  isInviteExpired,
  isInviteValid,
  isUsernameTaken,
  migrateUserToV2Kek,
  pruneExpiredInvites,
  verifyUserPassword,
};
