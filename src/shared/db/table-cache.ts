/**
 * A cache of rows that a table holds. The client clears the cache on a write
 * to the table, or to a table in `dependsOn` whose triggers feed it. No write
 * path clears it by hand. The cache stats count its entries.
 */

import { readRows } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import type { Node, Query } from "#db/select/shape.ts";
import type { TableHandle, TableName } from "#db/select/tables.ts";
import type { Read } from "#db/sql.ts";
import type { CollectionCache } from "#fp";
import {
  type DependsOnEntry,
  registerCache,
  registerDependencies,
} from "#shared/cache-registry.ts";
import { requestCache } from "#shared/request-cache.ts";

/** What a cache must give for the registry to clear it and count it. */
type ClearableCache = Pick<CollectionCache<unknown>, "invalidate" | "size">;

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

/** The rows that `read` picks from the table, cached for the request. */
export const requestCachedRows = <Name extends TableName, Row>(
  table: TableHandle<Name>,
  read: (rows: Query<Node<Name>>) => Read<Row>,
) =>
  tableCache(
    table,
    requestCache(() => readRows(read(from(table)))),
  );
