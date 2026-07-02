import { mapParallel } from "#fp";
import {
  execute,
  inPlaceholders,
  queryAll,
  resultRows,
  withTransaction,
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
export const swapSortOrder = (
  table: string,
  id1: number,
  id2: number,
): Promise<void> =>
  // Read the two orders and write the swap in one transaction, so concurrent
  // reorders serialise on the write lock instead of applying the same stale
  // snapshot and leaving two rows with the same sort_order (there is no
  // (table, sort_order) uniqueness constraint to repair such drift).
  withTransaction(async (tx) => {
    const rows = resultRows<{ id: number; sort_order: number }>(
      await tx.execute({
        args: [id1, id2],
        sql: `SELECT id, sort_order FROM ${table} WHERE id IN (?, ?)`,
      }),
    );
    const orderById = new Map(rows.map((r) => [r.id, r.sort_order]));
    const order1 = orderById.get(id1);
    const order2 = orderById.get(id2);
    // No-op when either row is gone (a stale click racing a delete): binding
    // an undefined sort_order would fail the NOT NULL constraint with a 500.
    if (order1 === undefined || order2 === undefined) return;
    await tx.execute({
      args: [order2, id1],
      sql: `UPDATE ${table} SET sort_order = ? WHERE id = ?`,
    });
    await tx.execute({
      args: [order1, id2],
      sql: `UPDATE ${table} SET sort_order = ? WHERE id = ?`,
    });
  });

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

type NameRow<Raw> = { id: number; name: Raw };
type Decryptor<Raw> = (raw: Raw) => Promise<string>;
type NameMap = Promise<Map<number, string>>;

/** Decrypt each fetched row's name into an `id → name` map. */
const decryptNameMap = async <Raw>(
  rows: Promise<NameRow<Raw>[]>,
  decryptName: Decryptor<Raw>,
): NameMap => {
  const entries = await Promise.all(
    (await rows).map(async (r) => [r.id, await decryptName(r.name)] as const),
  );
  return new Map(entries);
};

/** Project `alias.id, alias.nameColumn` from `table`, with an optional tail. */
const nameSelect = (
  table: string,
  alias: string,
  nameColumn: string,
  tail: string,
): string =>
  `SELECT ${alias}.id, ${alias}.${nameColumn} AS name FROM ${table} AS ${alias} ${tail}`;

/**
 * `id → name` for the rows of `table` whose id is in `ids`, decrypting only the
 * name column. `alias` qualifies the selected columns (repo SQL convention);
 * `decryptName` turns the raw stored value into plaintext (decryption-agnostic).
 * `table`/`alias`/`nameColumn` are internal constants. Empty `ids` ⇒ empty map.
 */
export const nameMapByIds = <Raw>(
  table: string,
  alias: string,
  nameColumn: string,
  ids: number[],
  decryptName: Decryptor<Raw>,
): NameMap =>
  decryptNameMap(
    rowsByIds<NameRow<Raw>>(ids, (placeholders) =>
      nameSelect(
        table,
        alias,
        nameColumn,
        `WHERE ${alias}.id IN (${placeholders})`,
      ),
    ),
    decryptName,
  );

/** `id, slug, name` rows (+ `extras` plain columns) for the given `ids`,
 * decrypting only slug and name — the narrow projection link surfaces (the
 * public nav) need, without loading a full-row cache. Empty `ids` ⇒ no query.
 * `table`/`alias`/`extras` are internal constants, never user input. */
export const linkRowsByIds = async <Extra extends string = never>(
  table: string,
  alias: string,
  ids: number[],
  decryptText: (raw: string) => Promise<string>,
  extras: readonly Extra[] = [],
): Promise<
  ({ id: number; name: string; slug: string } & Record<Extra, number>)[]
> => {
  const cols = ["id", "slug", "name", ...extras]
    .map((c) => `${alias}.${c}`)
    .join(", ");
  const rows = await rowsByIds<
    { id: number; name: string; slug: string } & Record<Extra, number>
  >(
    ids,
    (placeholders) =>
      `SELECT ${cols} FROM ${table} AS ${alias} WHERE ${alias}.id IN (${placeholders})`,
  );
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      name: await decryptText(r.name),
      slug: await decryptText(r.slug),
    })),
  );
};

/** `id → name` for **every** row of `table`, decrypting only the name column —
 * the narrow projection the item pickers need, without loading a full-row cache.
 * Ordered by id for a stable list. */
export const allNamesById = <Raw>(
  table: string,
  alias: string,
  nameColumn: string,
  decryptName: Decryptor<Raw>,
): NameMap =>
  decryptNameMap(
    queryAll<NameRow<Raw>>(
      nameSelect(table, alias, nameColumn, `ORDER BY ${alias}.id ASC`),
    ),
    decryptName,
  );

/**
 * Map each row's `id` to one of its integer columns (`id → column`) for the
 * rows of `table` whose id is in `ids`, optionally narrowed by an extra `where`
 * fragment appended verbatim (e.g. ` AND modifier_id IS NOT NULL`). `alias` is
 * the table's singular-word alias and qualifies the selected columns. `table`,
 * `alias`, `column` and `where` are always internal constants, never user input.
 */
export const columnMapByIds = (
  table: string,
  alias: string,
  column: string,
  ids: number[],
  where = "",
): Promise<Map<number, number>> =>
  mapByIds<{ id: number; value: number }>(
    ids,
    (placeholders) =>
      `SELECT ${alias}.id, ${alias}.${column} AS value FROM ${table} AS ${alias} WHERE ${alias}.id IN (${placeholders})${where}`,
    (row) => [row.id, row.value],
  );
