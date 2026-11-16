/**
 * A cache of rows that a table holds. A write to the table, or to a table in
 * `dependsOn` whose triggers feed it, clears the cache at the client, so no
 * write path clears it by hand. The cache stats count its entries.
 */

import type { TableHandle } from "#db/select/tables.ts";
import {
  type CacheInvalidation,
  type DependsOnEntry,
  registerCache,
  registerDependencies,
} from "#shared/cache-registry.ts";

/** What a cache must give for the registry to clear it and count it. */
type ClearableCache = {
  invalidate: (cause?: CacheInvalidation) => void;
  size: () => number;
};

/** Register `cache` against `table` and the tables in `dependsOn`. A
 *  `whenColumns` entry clears the cache on an update of those columns only.
 *  An insert and a delete always clear it. */
export const tableCache = <Cache extends ClearableCache>(
  table: TableHandle<string>,
  cache: Cache,
  dependsOn: readonly DependsOnEntry[] = [],
): Cache => {
  registerCache(() => ({ entries: cache.size(), name: table.name }));
  registerDependencies(table.name, dependsOn, cache.invalidate);
  return cache;
};
