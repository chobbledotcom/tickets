/**
 * API keys table operations
 *
 * API keys allow programmatic access to admin endpoints without
 * password-based login. Each key wraps the shared DATA_KEY with
 * a token-derived key (same crypto as session tokens), so the
 * plaintext API key is needed to decrypt attendee PII.
 *
 * Keys inherit admin_level from their parent user.
 */

import {
  decrypt,
  encrypt,
  hmacHash,
  unwrapKeyWithToken,
  wrapKeyWithToken,
} from "#lib/crypto.ts";
import { deleteByField, getDb, queryAll, queryOne } from "#lib/db/client.ts";
import { nowIso } from "#lib/now.ts";
import type { ApiKey } from "#lib/types.ts";

/**
 * Create a new API key for a user.
 * Requires the plaintext DATA_KEY (available during an authenticated session).
 * Returns the plaintext API key token — shown once, never stored.
 */
export const createApiKey = async (
  userId: number,
  name: string,
  dataKey: CryptoKey,
  generateToken: () => string,
): Promise<{ apiKey: string; id: number }> => {
  const apiKey = generateToken();
  const keyIndex = await hmacHash(apiKey);
  const wrappedDataKey = await wrapKeyWithToken(dataKey, apiKey);
  const encryptedName = await encrypt(name);

  const result = await getDb().execute({
    sql: `INSERT INTO api_keys (user_id, key_index, wrapped_data_key, name, created, last_used)
          VALUES (?, ?, ?, ?, ?, '')`,
    args: [userId, keyIndex, wrappedDataKey, encryptedName, nowIso()],
  });

  return { apiKey, id: Number(result.lastInsertRowid) };
};

/**
 * Look up an API key by its plaintext token.
 * Returns the row if found (for auth), null otherwise.
 */
export const getApiKeyByToken = async (
  token: string,
): Promise<ApiKey | null> => {
  const keyIndex = await hmacHash(token);
  return queryOne<ApiKey>(
    "SELECT id, user_id, key_index, wrapped_data_key, name, created, last_used FROM api_keys WHERE key_index = ?",
    [keyIndex],
  );
};

/**
 * Unwrap the DATA_KEY from an API key row using the plaintext token.
 * Throws if unwrapping fails (e.g. corrupted or rotated key).
 */
export const unwrapApiKeyDataKey = (
  wrappedDataKey: string,
  token: string,
): Promise<CryptoKey> => unwrapKeyWithToken(wrappedDataKey, token);

/**
 * List all API keys for a user (decrypts names for display).
 */
export const getApiKeysForUser = async (
  userId: number,
): Promise<
  Array<{ id: number; name: string; created: string; lastUsed: string }>
> => {
  const rows = await queryAll<ApiKey>(
    "SELECT id, user_id, key_index, wrapped_data_key, name, created, last_used FROM api_keys WHERE user_id = ? ORDER BY id ASC",
    [userId],
  );

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: await decrypt(row.name),
      created: row.created,
      lastUsed: row.last_used,
    })),
  );
};

/**
 * Get a single API key by ID and user, with decrypted name.
 */
export const getApiKeyForUser = async (
  id: number,
  userId: number,
): Promise<{ id: number; name: string } | null> => {
  const row = await queryOne<ApiKey>(
    "SELECT id, user_id, key_index, wrapped_data_key, name, created, last_used FROM api_keys WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  if (!row) return null;
  return { id: row.id, name: await decrypt(row.name) };
};

/**
 * Count API keys for a user.
 */
export const countApiKeysForUser = async (userId: number): Promise<number> => {
  const result = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?",
    [userId],
  );
  return result!.count;
};

/**
 * Delete an API key by ID (must belong to the given user).
 */
export const deleteApiKey = async (
  id: number,
  userId: number,
): Promise<boolean> => {
  const result = await getDb().execute({
    sql: "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
  return result.rowsAffected > 0;
};

/**
 * Delete all API keys for a user.
 */
export const deleteAllApiKeysForUser = (userId: number): Promise<void> =>
  deleteByField("api_keys", "user_id", userId);

/**
 * Update last_used timestamp for an API key.
 * Uses fire-and-forget pattern to avoid slowing down requests.
 */
export const touchApiKeyLastUsed = async (id: number): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE api_keys SET last_used = ? WHERE id = ?",
    args: [nowIso(), id],
  });
};

export const apiKeysApi = {
  createApiKey,
  getApiKeyByToken,
  unwrapApiKeyDataKey,
  getApiKeysForUser,
  getApiKeyForUser,
  countApiKeysForUser,
  deleteApiKey,
  deleteAllApiKeysForUser,
  touchApiKeyLastUsed,
};
