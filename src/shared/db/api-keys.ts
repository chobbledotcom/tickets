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
import { records } from "#db/record-table.ts";
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
  const row = await records.api_keys.insert({
    created: nowIso(),
    keyIndex: keyIndex,
    name,
    userId: userId,
    wrappedDataKey: wrappedDataKey,
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
    apiKeys({ keyIndex: await hmacHash(token) })
      .limit(1)
      .pick(
        "id",
        "userId",
        "keyIndex",
        "wrappedDataKey",
        "created",
        "lastUsed",
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
    apiKeys({ userId: userId })
      .sortedBy("id")
      .pick("id", "name", "created", "lastUsed"),
  );
  return decrypted.map((row) => ({
    created: row.created,
    id: row.id,
    lastUsed: row.lastUsed,
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
  readOneRow(apiKeys({ id, userId: userId }).limit(1).pick("id", "name"));

/**
 * Delete an API key by ID (must belong to the given user).
 */
export const deleteApiKey = async (
  id: number,
  userId: number,
): Promise<boolean> =>
  executeChangedRow(deleteFrom(tables.api_keys).where({ id, userId }));

/**
 * Update last_used timestamp for an API key.
 * Uses fire-and-forget pattern to avoid slowing down requests.
 */
export const touchApiKeyLastUsed = async (id: number): Promise<void> => {
  const override = getTouchOverride();
  if (override) throw override;
  await execute(update(tables.api_keys, { lastUsed: nowIso() }).where({ id }));
};
