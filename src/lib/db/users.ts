/**
 * Users table operations
 */

import {
  decrypt,
  deriveKEK,
  encrypt,
  hashPassword,
  hashSessionToken,
  hmacHash,
  verifyPassword,
  wrapKey,
} from "#lib/crypto.ts";
import { getDb, queryOne } from "#lib/db/client.ts";
import { now } from "#lib/now.ts";
import type { AdminLevel, User } from "#lib/types.ts";

/** Shared user creation logic */
const insertUser = async (opts: {
  username: string;
  adminLevel: AdminLevel;
  passwordHash: string;
  wrappedDataKey: string | null;
  inviteCodeHash: string | null;
  inviteExpiry: string | null;
}): Promise<User> => {
  const usernameIndex = await hmacHash(opts.username.toLowerCase());
  const encryptedUsername = await encrypt(opts.username.toLowerCase());
  const encryptedAdminLevel = await encrypt(opts.adminLevel);
  const encryptedPasswordHash = opts.passwordHash ? await encrypt(opts.passwordHash) : "";
  const encryptedInviteCode = opts.inviteCodeHash ? await encrypt(opts.inviteCodeHash) : null;
  const encryptedInviteExpiry = opts.inviteExpiry ? await encrypt(opts.inviteExpiry) : null;

  const result = await getDb().execute({
    sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      encryptedUsername,
      usernameIndex,
      encryptedPasswordHash,
      opts.wrappedDataKey,
      encryptedAdminLevel,
      encryptedInviteCode,
      encryptedInviteExpiry,
    ],
  });

  const id = Number(result.lastInsertRowid);
  return {
    id,
    username_hash: encryptedUsername,
    username_index: usernameIndex,
    password_hash: encryptedPasswordHash,
    wrapped_data_key: opts.wrappedDataKey,
    admin_level: encryptedAdminLevel,
    invite_code_hash: encryptedInviteCode,
    invite_expiry: encryptedInviteExpiry,
  };
};

/**
 * Create a new user with encrypted fields
 */
export const createUser = (
  username: string,
  passwordHash: string,
  wrappedDataKey: string | null,
  adminLevel: AdminLevel,
): Promise<User> =>
  insertUser({ username, adminLevel, passwordHash, wrappedDataKey, inviteCodeHash: null, inviteExpiry: null });

/**
 * Create an invited user (no password yet, has invite code)
 */
export const createInvitedUser = (
  username: string,
  adminLevel: AdminLevel,
  inviteCodeHash: string,
  inviteExpiry: string,
): Promise<User> =>
  insertUser({ username, adminLevel, passwordHash: "", wrappedDataKey: null, inviteCodeHash, inviteExpiry });

/**
 * Look up a user by username (using blind index)
 */
export const getUserByUsername = async (
  username: string,
): Promise<User | null> => {
  const usernameIndex = await hmacHash(username.toLowerCase());
  return queryOne<User>(
    "SELECT id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry FROM users WHERE username_index = ?",
    [usernameIndex],
  );
};

/**
 * Get a user by ID
 */
export const getUserById = (id: number): Promise<User | null> =>
  queryOne<User>(
    "SELECT id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry FROM users WHERE id = ?",
    [id],
  );

/**
 * Check if a username is already taken
 */
export const isUsernameTaken = async (username: string): Promise<boolean> => {
  const user = await getUserByUsername(username);
  return user !== null;
};

/**
 * Get all users (for admin user management page)
 */
export const getAllUsers = async (): Promise<User[]> => {
  const result = await getDb().execute(
    "SELECT id, username_hash, username_index, password_hash, wrapped_data_key, admin_level, invite_code_hash, invite_expiry FROM users ORDER BY id ASC",
  );
  return result.rows as unknown as User[];
};

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
export const decryptAdminLevel = (user: User): Promise<AdminLevel> =>
  decrypt(user.admin_level) as Promise<AdminLevel>;

/**
 * Decrypt a user's username
 */
export const decryptUsername = (user: User): Promise<string> =>
  decrypt(user.username_hash);

/**
 * Set a user's password (for invite flow)
 */
export const setUserPassword = async (
  userId: number,
  password: string,
): Promise<string> => {
  const passwordHash = await hashPassword(password);
  const encryptedHash = await encrypt(passwordHash);
  const encryptedNull = await encrypt("");

  await getDb().execute({
    sql: "UPDATE users SET password_hash = ?, invite_code_hash = ?, invite_expiry = ? WHERE id = ?",
    args: [encryptedHash, encryptedNull, encryptedNull, userId],
  });

  return passwordHash;
};

/**
 * Activate a user by wrapping the data key with their KEK
 */
export const activateUser = async (
  userId: number,
  dataKey: CryptoKey,
  decryptedPasswordHash: string,
): Promise<void> => {
  const kek = await deriveKEK(decryptedPasswordHash);
  const wrappedDataKey = await wrapKey(dataKey, kek);

  await getDb().execute({
    sql: "UPDATE users SET wrapped_data_key = ? WHERE id = ?",
    args: [wrappedDataKey, userId],
  });
};

/**
 * Delete a user and all their sessions
 */
export const deleteUser = async (userId: number): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE user_id = ?",
    args: [userId],
  });
  await getDb().execute({
    sql: "DELETE FROM users WHERE id = ?",
    args: [userId],
  });
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
 * Check if a user has set their password (password_hash is non-empty encrypted value)
 */
export const hasPassword = async (user: User): Promise<boolean> => {
  if (!user.password_hash) return false;
  const decrypted = await decrypt(user.password_hash);
  return decrypted.length > 0;
};

/**
 * Stubbable API for testing
 */
export const usersApi = {
  createUser,
  createInvitedUser,
  getUserByUsername,
  getUserById,
  isUsernameTaken,
  getAllUsers,
  verifyUserPassword,
  decryptAdminLevel,
  decryptUsername,
  setUserPassword,
  activateUser,
  deleteUser,
  getUserByInviteCode,
  hashInviteCode,
  isInviteValid,
  hasPassword,
};
