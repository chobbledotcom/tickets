import { mapParallel } from "#fp";
import { execute, executeBatch, queryAll, resultRows } from "#shared/db/client.ts";

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
