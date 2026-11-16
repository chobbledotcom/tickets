/**
 * Users table operations
 */

import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hashSessionToken, hmacHash, verifyPassword } from "#crypto/hashing.ts";
import type {
  EnvKeyEncrypted,
  PasswordHash,
  WrappedKey,
} from "#crypto/sealed.ts";
import { inOneBatch, removalWithChildren } from "#db/child-rows.ts";
import { execute, insertedRowId, queryAll } from "#db/client.ts";
import { createKeyedCache } from "#db/keyed-cache.ts";
import { rowsById } from "#db/record-table.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql, sqlList } from "#db/sql.ts";
import { tableCache } from "#db/table-cache.ts";
import { insertInto } from "#db/write.ts";
import type { CacheInvalidation } from "#shared/cache-registry.ts";
import { now } from "#shared/now.ts";
import { type AdminLevel, isAdminLevel, type User } from "#types";

const USER_COLUMNS = sql`id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry, kek_version, invite_wrapped_data_key`;

const USER_SELECT = sql`SELECT ${USER_COLUMNS} FROM users ORDER BY id ASC`;

/** Fetch only the users matching the given blind-index keys, in one query, so a
 * by-username read never loads the whole table. Powers the cache's targeted
 * `getByKey`/`getByKeys` path. */
const fetchUsersByIndex = (keys: string[]): Promise<User[]> =>
  queryAll<User>(
    sql`SELECT ${USER_COLUMNS} FROM users WHERE username_index IN (${sqlList(keys)})`,
  );

export type UserDisplayFields = Pick<
  User,
  "admin_level" | "id" | "username_hash"
>;

const USER_DISPLAY_SELECT = from(tables.users)
  .sortedBy("id")
  .pick("id", "username_hash", "admin_level");

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

export const getAllUsers = (): Promise<User[]> => usersCache.getAll();

/** Invalidate the users cache (for testing or after writes). */
export const invalidateUsersCache = (
  cause: CacheInvalidation = "manual",
): void => {
  usersCache.invalidate(cause);
  for (const listener of usersInvalidationListeners) listener();
};

// Any write to the users table clears the cache at the client. The
// registration calls invalidateUsersCache, so that onUsersInvalidated
// listeners such as the superuser account-state cache also fire.
tableCache(tables.users, {
  invalidate: invalidateUsersCache,
  size: () => usersCache.size(),
});

/** Fields needed to build a users row. */
type InsertUserOpts = {
  username: string;
  adminLevel: AdminLevel;
  /** "" for an invited user who has not set a password yet. */
  passwordHash: PasswordHash | "";
  wrappedDataKey: WrappedKey | null;
  inviteCodeHash: string | null;
  inviteExpiry: string | null;
  kekVersion: number;
  inviteWrappedDataKey: WrappedKey | null;
};

/**
 * Encrypt a user's fields and build the users INSERT without running it,
 * returning the statement alongside the row values so a caller that executes it
 * can reconstruct the {@link User}.
 */
const buildUserInsert = async (
  opts: InsertUserOpts,
): Promise<{
  statement: SqlStatement;
  values: Omit<User, "id">;
}> => {
  const usernameIndex = await hmacHash(opts.username.toLowerCase());
  const encryptedUsername = await encrypt(opts.username.toLowerCase());
  const encryptedAdminLevel = await encrypt(opts.adminLevel);
  const encryptedPasswordHash: EnvKeyEncrypted<PasswordHash> | "" =
    opts.passwordHash ? await encrypt(opts.passwordHash) : "";
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
  return {
    statement: insertInto(tables.users, values).returning("id"),
    values,
  };
};

/** A user INSERT statement plus the row values needed to rebuild the User. */
type BuiltUserInsert = Awaited<ReturnType<typeof buildUserInsert>>;

/** Execute a built users INSERT and reconstruct the full {@link User}. */
const runUserInsert = async ({
  statement,
  values,
}: BuiltUserInsert): Promise<User> => {
  const result = await execute(statement);
  return { id: insertedRowId(result), ...values };
};

/** Shared user creation logic */
const insertUser = async (opts: InsertUserOpts): Promise<User> =>
  runUserInsert(await buildUserInsert(opts));

/** Build the opts for an already-activated user (no invite, password-bound).
 * `passwordHash` may be "" — the stored not-yet-set sentinel. */
const activatedUserOpts = (
  username: string,
  passwordHash: PasswordHash | "",
  wrappedDataKey: WrappedKey | null,
  adminLevel: AdminLevel,
  kekVersion = 2,
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
  async (...args: Parameters<typeof activatedUserOpts>): Promise<T> =>
    consume(await buildUserInsert(activatedUserOpts(...args)));

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
  inviteWrappedDataKey: WrappedKey | null = null,
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
  (
    await queryAll(
      rowsById(tables.users, id).limit(1).pick("id", "admin_level"),
    )
  )[0] ?? null;

/**
 * Check if a username is already taken
 */
export const isUsernameTaken = async (username: string): Promise<boolean> => {
  const user = await getUserByUsername(username);
  return user !== null;
};

/** Get the minimal encrypted user fields needed to show assignable users. */
export const getUserDisplayFields = (): Promise<UserDisplayFields[]> =>
  queryAll<UserDisplayFields>(USER_DISPLAY_SELECT);

/**
 * Verify a user's password (decrypt stored hash, then verify)
 * Returns the decrypted password hash if valid (needed for KEK derivation)
 */
export const verifyUserPassword = async (
  user: User,
  password: string,
): Promise<PasswordHash | null> => {
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

/** The deletes that remove users with their sessions, API keys, and logistics
 *  agent links. */
export const userRemoval = removalWithChildren(tables.users, [
  [tables.api_keys, "user_id"],
  [tables.sessions, "user_id"],
  [tables.user_logistics_agents, "user_id"],
]);

/**
 * Delete a user and all their sessions and API keys
 */
export const deleteUser = inOneBatch(userRemoval);

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
