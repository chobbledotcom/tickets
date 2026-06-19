/**
 * Global cache stats registry.
 * Cache modules register stat providers at load time;
 * the debug footer reads them at render time.
 */

/** A single cache's stats snapshot */
export type CacheStat = {
  readonly name: string;
  readonly entries: number;
  readonly capacity?: number;
};

type CacheStatProvider = () => CacheStat;

const providers: CacheStatProvider[] = [];

/** Register a cache stat provider (called at module load time) */
export const registerCache = (provider: CacheStatProvider): void => {
  providers.push(provider);
};

/** Collect stats from all registered caches */
export const getAllCacheStats = (): CacheStat[] => providers.map((p) => p());

/**
 * Table → cache invalidation registry.
 *
 * A cache declares the physical tables whose mutation should clear it (its own
 * table, plus any table a DB trigger writes through to — e.g. the listings
 * cache depends on `listing_attendees` because triggers there maintain the
 * listings aggregate columns). The db client inspects every write statement's
 * target table and fires the registered invalidators, so no write path has to
 * remember to invalidate by hand. Inverting the dependency this way (caches
 * push their invalidator in at load time) keeps the low-level client free of
 * any static import of the cache modules.
 */
type Invalidator = () => void;
const invalidatorsByTable = new Map<string, Set<Invalidator>>();

/** Register `invalidate` to run whenever any of `tables` is written. */
export const registerTableInvalidation = (
  tables: readonly string[],
  invalidate: Invalidator,
): void => {
  for (const table of tables) {
    const set = invalidatorsByTable.get(table) ?? new Set<Invalidator>();
    set.add(invalidate);
    invalidatorsByTable.set(table, set);
  }
};

/** Fire every cache invalidator registered against `table` (no-op if none). */
export const invalidateCachesForTable = (table: string): void => {
  const set = invalidatorsByTable.get(table);
  if (set) for (const invalidate of set) invalidate();
};

/** Reset the registry (for testing) */
export const resetCacheRegistry = (): void => {
  providers.length = 0;
  invalidatorsByTable.clear();
};
