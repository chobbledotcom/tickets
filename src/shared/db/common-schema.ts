import {
  type DependsOnEntry,
  registerCache,
  registerDependencies,
  registerTableInvalidation,
} from "#shared/cache-registry.ts";
import {
  createKeyedCache,
  type KeyedCache,
  type KeyedCacheConfig,
} from "#shared/db/keyed-cache.ts";
import { col, type Table } from "#shared/db/table.ts";

export { defineIdTable } from "#shared/db/define-id-table.ts";
// Re-exported for users.ts, which caches a table-less query and so wires the
// cache by hand rather than through cachedEntityTable.
export { createKeyedCache, registerCache, registerTableInvalidation };

/**
 * Wire a keyed cache to an id-table in one step: build the cache, register it
 * for the debug-footer stats, and register it with the table→cache invalidation
 * registry so any write to the table (or to a `dependsOn` table whose triggers
 * feed it — e.g. listings depend on listing_attendees) clears the cache
 * automatically at the db-client layer. Centralises the create-cache + register
 * trio that listings and groups would otherwise each repeat. `Cached` lets the
 * cache hold a richer row than the table writes (e.g. listings cached with
 * attendee counts).
 *
 * `dependsOn` entries may carry `whenColumns` to narrow the `listing_attendees`
 * → `listings` dependency: the cache is only cleared on UPDATEs that touch one
 * of those columns. INSERT / DELETE always clear.
 */
export const cachedEntityTable = <Row, Input, Cached = Row>(
  name: string,
  table: Table<Row, Input>,
  config: KeyedCacheConfig<Cached>,
  dependsOn: ReadonlyArray<DependsOnEntry> = [],
): { cache: KeyedCache<Cached>; table: Table<Row, Input> } => {
  const cache = createKeyedCache(config);
  registerCache(() => ({ entries: cache.size(), name }));
  const invalidate = (): void => cache.invalidate();
  registerDependencies(table.name, dependsOn, invalidate);
  return { cache, table };
};

type EncryptFn = (v: string) => Promise<string>;
type DecryptFn = (v: string) => Promise<string>;

/** Shared columns for tables with encrypted `slug` + blind-index `slug_index`. */
export const idAndEncryptedSlugSchema = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => ({
  id: col.generated<number>(),
  slug: col.encrypted<string>(encrypt, decrypt),
  slug_index: col.simple<string>(),
});

/** Shared encrypted `name` column for tables that store a display name. */
export const encryptedNameSchema = (
  encrypt: EncryptFn,
  decrypt: DecryptFn,
) => ({
  name: col.encrypted<string>(encrypt, decrypt),
});
