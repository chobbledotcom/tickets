/**
 * `address_cache` table operations — cached address-lookup results.
 *
 * Decrypt-only-what-you-need applies twice over here: lookups go through a
 * deterministic HMAC blind index of "provider:normalised-search" (never
 * scan-and-decrypt), and the cached address lines are one encrypted JSON blob
 * decrypted only when a lookup hits. Rows older than ADDRESS_CACHE_DAYS are
 * never served — reads filter on the same cutoff the prune task deletes by —
 * so an unpruned-but-expired row cannot come back stale.
 */

import * as v from "valibot";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { blindIndexFor } from "#crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#crypto/sealed.ts";
import { execute, queryOne } from "#db/client.ts";
import { inQuery, lessThan } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { deleteFrom, insertInto } from "#db/write.ts";
import {
  type AddressMatch,
  AddressMatchSchema,
} from "#shared/address-lookup/types.ts";
import { ADDRESS_CACHE_MS, MAINTENANCE_PRUNE_BATCH } from "#shared/limits.ts";
import { isoBefore, nowMs } from "#shared/now.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/**
 * Compute the blind-index HMAC for a lookup. The provider is part of the
 * keyed input so two providers' results for the same search never collide.
 */
export const computeAddressSearchIndex = blindIndexFor("");

/** The oldest `created` a cache row may have and still be served. */
const freshCutoffIso = (): string => isoBefore(ADDRESS_CACHE_MS);

export const addressCachePruneStatement = (): SqlStatement =>
  deleteFrom(tables.address_cache).where((row) =>
    inQuery(
      row.id,
      from(tables.address_cache)
        .where((cached) => lessThan(cached.created, freshCutoffIso()))
        .sortedBy("id")
        .limit(MAINTENANCE_PRUNE_BATCH)
        .values((cached) => cached.id),
    ),
  );

const cachedAddressesJson = defineStoredJson(
  v.union([v.array(v.string()), v.array(AddressMatchSchema)]),
);

/** Read a fresh cached result. Null on miss (absent or expired). Rows cached
 * before matches carried coordinates hold bare line strings; those read as a
 * miss too, so the next lookup re-fetches the postcode WITH coordinates and
 * overwrites the row instead of serving locationless results until expiry. */
export const getCachedAddresses = async (
  searchIndex: BlindIndex,
): Promise<AddressMatch[] | null> => {
  const row = await queryOne<{ results: EnvKeyEncrypted }>(
    sql`SELECT results FROM address_cache WHERE search_index = ${searchIndex} AND created >= ${freshCutoffIso()} LIMIT 1`,
  );
  if (!row) return null;
  const entries = cachedAddressesJson.read(
    await decrypt(row.results),
    `address_cache.results for ${searchIndex}`,
  );
  return entries.every(
    (entry): entry is AddressMatch => typeof entry !== "string",
  )
    ? entries
    : null;
};

/** Cache a lookup result, replacing any previous row for the same search. */
export const storeCachedAddresses = async (
  searchIndex: BlindIndex,
  addresses: AddressMatch[],
): Promise<void> => {
  await execute(
    insertInto(
      tables.address_cache,
      {
        created: new Date(nowMs()).toISOString(),
        results: await encrypt(
          cachedAddressesJson.write(addresses, "address_cache.results"),
        ),
        search_index: searchIndex,
      },
      { onConflict: { on: ["search_index"], take: ["results", "created"] } },
    ),
  );
};
