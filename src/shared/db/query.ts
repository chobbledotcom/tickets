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
 * Run an id-keyed SELECT, short-circuiting to `[]` (no query) when `ids` is
 * empty. `buildSql` receives the bound `?`-placeholder list for `ids`, so `ids`
 * are the only query args. The base skeleton for the id-map helpers below.
 */
export const rowsByIds = async <Row>(
  ids: number[],
  buildSql: (placeholders: string) => string,
): Promise<Row[]> =>
  ids.length === 0 ? [] : queryAll<Row>(buildSql(inPlaceholders(ids)), ids);

/**
 * Run an integer-keyed lookup query and turn each row into a `[key, value]`
 * pair via `toEntry`, returning the id-keyed map (empty when `ids` is empty).
 */
export const mapByIds = async <Row>(
  ids: number[],
  buildSql: (placeholders: string) => string,
  toEntry: (row: Row) => [number, number],
): Promise<Map<number, number>> =>
  new Map((await rowsByIds<Row>(ids, buildSql)).map(toEntry));

/**
 * Map each row's `id` to a decrypted display name (`id → name`) for the rows of
 * `table` whose id is in `ids`. `nameColumn` is the (encrypted) column to read;
 * `decryptName` turns its raw stored value into the plaintext name — so this
 * stays decryption-agnostic. `table`/`nameColumn` are internal constants, never
 * user input. Empty `ids` ⇒ empty map and no query.
 */
export const nameMapByIds = async <Raw>(
  table: string,
  nameColumn: string,
  ids: number[],
  decryptName: (raw: Raw) => Promise<string>,
): Promise<Map<number, string>> => {
  const rows = await rowsByIds<{ id: number; name: Raw }>(
    ids,
    (placeholders) =>
      `SELECT id, ${nameColumn} AS name FROM ${table} WHERE id IN (${placeholders})`,
  );
  const entries = await Promise.all(
    rows.map(async (row) => [row.id, await decryptName(row.name)] as const),
  );
  return new Map(entries);
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
