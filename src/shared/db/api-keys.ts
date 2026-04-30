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

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { wrapKeyWithToken } from "#shared/crypto/keys.ts";
import {
  deleteByField,
  getDb,
  insert,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import { getTouchOverride } from "#shared/test-overrides.ts";
import type { ApiKey } from "#shared/types.ts";

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

  const result = await getDb().execute(
    insert("api_keys", {
      created: nowIso(),
      key_index: keyIndex,
      last_used: "",
      name: encryptedName,
      user_id: userId,
      wrapped_data_key: wrappedDataKey,
    }),
  );

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
      created: row.created,
      id: row.id,
      lastUsed: row.last_used,
      name: await decrypt(row.name),
    })),
  );
};

/**
 * Get a single API key by ID and user, with decrypted name.
 */
export const getApiKeyForUser = async (
  id: number,
  userId: number,
): Promise<{ id: number; name: string }> => {
  const row = await queryOne<ApiKey>(
    "SELECT id, user_id, key_index, wrapped_data_key, name, created, last_used FROM api_keys WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  if (!row) throw new Error(`API key ${id} not found for user ${userId}`);
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
    args: [id, userId],
    sql: "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
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
  const override = getTouchOverride();
  if (override) throw override;
  await getDb().execute({
    args: [nowIso(), id],
    sql: "UPDATE api_keys SET last_used = ? WHERE id = ?",
  });
};

export const apiKeysApi = {
  countApiKeysForUser,
  createApiKey,
  deleteAllApiKeysForUser,
  deleteApiKey,
  getApiKeyByToken,
  getApiKeyForUser,
  getApiKeysForUser,
  touchApiKeyLastUsed,
};
