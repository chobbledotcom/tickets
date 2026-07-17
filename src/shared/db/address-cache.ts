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

/* jscpd:ignore-start */
import type { AddressMatch } from "#shared/address-lookup/types.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { ADDRESS_CACHE_MS } from "#shared/limits.ts";
import { isoBefore, nowMs } from "#shared/now.ts";
/* jscpd:ignore-end */

/**
 * Compute the blind-index HMAC for a lookup. The provider is part of the
 * keyed input so two providers' results for the same search never collide.
 */
export const computeAddressSearchIndex = (
  provider: string,
  normalisedSearch: string,
): Promise<BlindIndex> => hmacHash(`${provider}:${normalisedSearch}`);

/** The oldest `created` a cache row may have and still be served. */
const freshCutoffIso = (): string => isoBefore(ADDRESS_CACHE_MS);

/** Read a fresh cached result. Null on miss (absent or expired). Rows cached
 * before matches carried coordinates hold bare line strings; those read as a
 * miss too, so the next lookup re-fetches the postcode WITH coordinates and
 * overwrites the row instead of serving locationless results until expiry. */
export const getCachedAddresses = async (
  searchIndex: BlindIndex,
): Promise<AddressMatch[] | null> => {
  const row = await queryOne<{ results: EnvKeyEncrypted }>(
    "SELECT results FROM address_cache WHERE search_index = ? AND created >= ? LIMIT 1",
    [searchIndex, freshCutoffIso()],
  );
  if (!row) return null;
  const entries = JSON.parse(await decrypt(row.results)) as (
    | string
    | AddressMatch
  )[];
  if (entries.some((entry) => typeof entry === "string")) return null;
  return entries as AddressMatch[];
};

/** Cache a lookup result, replacing any previous row for the same search. */
export const storeCachedAddresses = async (
  searchIndex: BlindIndex,
  addresses: AddressMatch[],
): Promise<void> => {
  await execute(
    "INSERT INTO address_cache (search_index, results, created) VALUES (?, ?, ?) " +
      "ON CONFLICT(search_index) DO UPDATE SET results = excluded.results, created = excluded.created",
    [
      searchIndex,
      await encrypt(JSON.stringify(addresses)),
      new Date(nowMs()).toISOString(),
    ],
  );
};
