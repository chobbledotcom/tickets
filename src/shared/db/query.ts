import { mapParallel } from "#fp";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  resultRows,
} from "#shared/db/client.ts";

/**
 * Execute a SQL query and map result rows through an async transformer.
 *
 * Useful for running a query and decrypting/transforming each row via `table.fromDb`.
 */
export const queryAndMap =
  <Row, Out>(toOut: (row: Row) => Promise<Out>) =>
  async (sql: string): Promise<Out[]> =>
    mapParallel(toOut)(resultRows<Row>(await execute(sql)));

/**
 * Swap the `sort_order` of two rows (by id) in a table that has `id` and
 * `sort_order` columns. The current values are read first so callers only need
 * the two ids. `table` is always an internal constant, never user input.
 */
export const swapSortOrder = async (
  table: string,
  id1: number,
  id2: number,
): Promise<void> => {
  const rows = await queryAll<{ id: number; sort_order: number }>(
    `SELECT id, sort_order FROM ${table} WHERE id IN (?, ?)`,
    [id1, id2],
  );
  const orderById = new Map(rows.map((r) => [r.id, r.sort_order]));
  await executeBatch([
    {
      args: [orderById.get(id2)!, id1],
      sql: `UPDATE ${table} SET sort_order = ? WHERE id = ?`,
    },
    {
      args: [orderById.get(id1)!, id2],
      sql: `UPDATE ${table} SET sort_order = ? WHERE id = ?`,
    },
  ]);
};

/**
 * Run an integer-keyed lookup query, short-circuiting to an empty map when
 * `ids` is empty. `buildSql` receives the bound `?`-placeholder list for `ids`
 * (so `ids` are the only query args); `toEntry` turns each row into a
 * `[key, value]` pair. The base for the id-map helpers below.
 */
export const mapByIds = async <Row>(
  ids: number[],
  buildSql: (placeholders: string) => string,
  toEntry: (row: Row) => [number, number],
): Promise<Map<number, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await queryAll<Row>(buildSql(inPlaceholders(ids)), ids);
  return new Map(rows.map(toEntry));
};

/**
 * Map each row's `id` to one of its integer columns (`id → column`) for the
 * rows of `table` whose id is in `ids`, optionally narrowed by an extra `where`
 * fragment appended verbatim (e.g. ` AND modifier_id IS NOT NULL`). `table`,
 * `column` and `where` are always internal constants, never user input.
 */
export const columnMapByIds = (
  table: string,
  column: string,
  ids: number[],
  where = "",
): Promise<Map<number, number>> =>
  mapByIds<{ id: number; value: number }>(
    ids,
    (placeholders) =>
      `SELECT id, ${column} AS value FROM ${table} WHERE id IN (${placeholders})${where}`,
    (row) => [row.id, row.value],
  );
