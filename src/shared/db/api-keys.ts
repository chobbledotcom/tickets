/**
 * API keys table operations
 *
 * API keys allow programmatic access to admin endpoints without
 * password-based login. Each key wraps the shared DATA_KEY with
 * a token-derived key (same crypto as session tokens). The
 * plaintext API key is needed to decrypt attendee PII.
 *
 * Keys inherit admin_level from their parent user.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { wrapKeyWithToken } from "#crypto/keys.ts";
import { execute } from "#db/client.ts";
import { executeChangedRow } from "#db/guarded-writes.ts";
import { readOneRow, readRows } from "#db/read.ts";
import { insertRow } from "#db/record-table.ts";
import { from } from "#db/select/query.ts";
import type { Matching, Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { deleteFrom, update } from "#db/write.ts";
import { nowIso } from "#shared/now.ts";
import { getTouchOverride } from "#shared/test-overrides.ts";
import type { ApiKey } from "#types";

/** The keys that `where` keeps. */
const apiKeys = (where: Matching<Node<"api_keys">>) =>
  from(tables.api_keys).where(where);

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
  const row = await insertRow(tables.api_keys, {
    created: nowIso(),
    key_index: keyIndex,
    name,
    user_id: userId,
    wrapped_data_key: wrappedDataKey,
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
): Promise<Omit<ApiKey, "name"> | null> =>
  readOneRow(
    // The auth path never shows the name, so it is neither read nor decrypted.
    apiKeys({ key_index: await hmacHash(token) })
      .limit(1)
      .pick(
        "id",
        "user_id",
        "key_index",
        "wrapped_data_key",
        "created",
        "last_used",
      ),
  );

/**
 * List all API keys for a user (decrypts names for display).
 */
export const getApiKeysForUser = async (
  userId: number,
): Promise<
  Array<{ id: number; name: string; created: string; lastUsed: string }>
> => {
  const decrypted = await readRows(
    apiKeys({ user_id: userId })
      .sortedBy("id")
      .pick("id", "name", "created", "last_used"),
  );
  return decrypted.map((row) => ({
    created: row.created,
    id: row.id,
    lastUsed: row.last_used,
    name: row.name,
  }));
};

/** The key's display facts: its id and its decrypted name. */
export type ApiKeyName = { id: number; name: string };

/**
 * Find one API key by ID and user, with its decrypted name, or null.
 */
export const findApiKeyForUser = async (
  id: number,
  userId: number,
): Promise<ApiKeyName | null> =>
  readOneRow(apiKeys({ id, user_id: userId }).limit(1).pick("id", "name"));

/**
 * Delete an API key by ID (must belong to the given user).
 */
export const deleteApiKey = async (
  id: number,
  userId: number,
): Promise<boolean> =>
  executeChangedRow(deleteFrom(tables.api_keys).where({ id, user_id: userId }));

/**
 * Update last_used timestamp for an API key.
 * Uses fire-and-forget pattern to avoid slowing down requests.
 */
export const touchApiKeyLastUsed = async (id: number): Promise<void> => {
  const override = getTouchOverride();
  if (override) throw override;
  await execute(update(tables.api_keys, { last_used: nowIso() }).where({ id }));
};
