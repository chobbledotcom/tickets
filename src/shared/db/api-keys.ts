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

import { mapParallel } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { wrapKeyWithToken } from "#shared/crypto/keys.ts";
import type { BlindIndex, WrappedKey } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeUpdate,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { idAndCreatedSchema } from "#shared/db/common-schema.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { col } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import { getTouchOverride } from "#shared/test-overrides.ts";
import type { ApiKey } from "#shared/types.ts";

/** A row with its `name` decrypted for display — the table's read shape. */
type ApiKeyRow = {
  id: number;
  user_id: number;
  key_index: BlindIndex;
  wrapped_data_key: WrappedKey;
  name: string;
  created: string;
  last_used: string;
};

/** Fields a caller supplies to create a key: `name` is plaintext (the table
 * encrypts it), and `created`/`last_used` fall back to their column defaults. */
type ApiKeyInput = {
  userId: number;
  keyIndex: BlindIndex;
  wrappedDataKey: WrappedKey;
  name: string;
};

/** Declarative api_keys table — `name` is encrypted at rest (decrypted on read),
 * every other column is stored as-is. The single source of the column set and
 * the encrypt/decrypt policy for this table. */
const apiKeysTable = defineIdTable<ApiKeyRow, ApiKeyInput>("api_keys", {
  ...idAndCreatedSchema(nowIso),
  key_index: col.simple<BlindIndex>(),
  last_used: col.withDefault(() => ""),
  name: col.encrypted(encrypt, decrypt),
  user_id: col.simple<number>(),
  wrapped_data_key: col.simple<WrappedKey>(),
});

/** The api_keys columns, in one place, for the reads that select every column. */
const API_KEY_COLUMNS =
  "id, user_id, key_index, wrapped_data_key, name, created, last_used";

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
  const row = await apiKeysTable.insert({
    keyIndex,
    name,
    userId,
    wrappedDataKey,
  });
  return { apiKey, id: row.id };
};

/**
 * Look up an API key by its plaintext token.
 * Returns the row (name still sealed — the auth path never reads it) if found,
 * null otherwise.
 */
export const getApiKeyByToken = async (
  token: string,
): Promise<ApiKey | null> => {
  const keyIndex = await hmacHash(token);
  return queryOne<ApiKey>(
    `SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE key_index = ?`,
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
  const rows = await queryAll<ApiKeyRow>(
    `SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = ? ORDER BY id ASC`,
    [userId],
  );
  const decrypted = await mapParallel(apiKeysTable.fromDb)(rows);
  return decrypted.map((row) => ({
    created: row.created,
    id: row.id,
    lastUsed: row.last_used,
    name: row.name,
  }));
};

/**
 * Get a single API key by ID and user, with decrypted name.
 */
export const getApiKeyForUser = async (
  id: number,
  userId: number,
): Promise<{ id: number; name: string }> => {
  const row = await queryOne<ApiKeyRow>(
    `SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  if (!row) throw new Error(`API key ${id} not found for user ${userId}`);
  const decrypted = await apiKeysTable.fromDb(row);
  return { id: decrypted.id, name: decrypted.name };
};

/**
 * Delete an API key by ID (must belong to the given user).
 */
export const deleteApiKey = async (
  id: number,
  userId: number,
): Promise<boolean> => {
  const result = await execute(
    "DELETE FROM api_keys WHERE id = ? AND user_id = ?",
    [id, userId],
  );
  return result.rowsAffected > 0;
};

/**
 * Update last_used timestamp for an API key.
 * Uses fire-and-forget pattern to avoid slowing down requests.
 */
export const touchApiKeyLastUsed = async (id: number): Promise<void> => {
  const override = getTouchOverride();
  if (override) throw override;
  await executeUpdate("api_keys", { last_used: nowIso() }, { id });
};
