/* jscpd:ignore-start */
import type { InValue, Row } from "@libsql/client";
import { mapParallel } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  nextSortOrder,
  queryAll,
  resultRows,
  type TxScope,
  update,
  withTransaction,
} from "#shared/db/client.ts";
/* jscpd:ignore-end */

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
 * Swap the `sort_order` of two rows in one write transaction, so concurrent
 * reorders serialise on the write lock instead of applying the same stale
 * snapshot and leaving two rows sharing a sort_order (there is no
 * (…, sort_order) uniqueness constraint to repair such drift). `readOrders`
 * loads the two current orders (keyed however the table identifies its rows);
 * `writeSwap` writes them crossed over. No-op when either order is missing (a
 * stale click racing a delete): binding an undefined sort_order would fail the
 * NOT NULL constraint with a 500.
 */
export const swapSortOrders = <Row>(
  select: { sql: string; args: InValue[] },
  ordersFrom: (rows: Row[]) => [number | undefined, number | undefined],
  writeSwap: (
    tx: TxScope,
    firstOrder: number,
    secondOrder: number,
  ) => Promise<void>,
): Promise<void> =>
  withTransaction(async (tx) => {
    const [first, second] = ordersFrom(
      resultRows<Row>(await tx.execute(select)),
    );
    if (first === undefined || second === undefined) return;
    await writeSwap(tx, first, second);
  });

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
  swapSortOrders<{ id: number; sort_order: number }>(
    {
      args: [id1, id2],
      sql: `SELECT id, sort_order FROM ${table} WHERE id IN (?, ?)`,
    },
    (rows) => {
      const orderById = new Map(rows.map((r) => [r.id, r.sort_order]));
      return [orderById.get(id1), orderById.get(id2)];
    },
    async (tx, order1, order2) => {
      await tx.execute(update(table, { sort_order: order2 }, { id: id1 }));
      await tx.execute(update(table, { sort_order: order1 }, { id: id2 }));
    },
  );

/**
 * Give a freshly-created row the next `sort_order`: one more than the largest
 * among its siblings (always >= 1, so a new row never collides with legacy rows
 * still sat at 0). `table` is always an internal constant, never user input.
 */
export const assignNextSortOrder = async (
  table: string,
  id: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [id, id],
      sql: `UPDATE ${table}
            SET sort_order = COALESCE(
              (SELECT MAX(sort_order) FROM ${table} WHERE id != ?), 0
            ) + 1
            WHERE id = ?`,
    },
  ]);
};

/** Bind the shared append and swap operations to one ordered table. */
export const orderedRows = (
  table: string,
): {
  append: (id: number) => Promise<void>;
  swap: (first: number, second: number) => Promise<void>;
} => ({
  append: (id) => assignNextSortOrder(table, id),
  swap: (first, second) => swapSortOrder(table, first, second),
});

/** Add parent-scoped next-order lookup to an ordered table. */
export const orderedChildren = (
  table: string,
  parentField: string,
): ReturnType<typeof orderedRows> & {
  next: (parentId: number) => Promise<number>;
} => ({
  ...orderedRows(table),
  next: (parentId) => nextSortOrder(table, parentField, parentId),
});

/** Collapse a result's rows to the set of one column's values, as strings —
 * the shared tail of the "which names/ids already exist" reads (applied
 * migrations, live table columns, index and trigger names). */
export const stringColumnSet = (rows: Row[], column: string): Set<string> =>
  new Set(rows.map((row) => String(row[column])));

/** Run a single-column SELECT and collect that column's values into a Set of
 * strings — the shared shape of the "which hashes/names already exist" reads
 * (e.g. the live table names, the unsubscribed contact hashes). */
export const queryColumnSet = async (
  sql: string,
  column: string,
  args: InValue[] = [],
): Promise<Set<string>> =>
  stringColumnSet(await queryAll<Row>(sql, args), column);

/**
 * Run an id-keyed SELECT, short-circuiting to `[]` (no query) when `ids` is
 * empty. `buildSql` receives the bound `?`-placeholder list for `ids`, so `ids`
 * are the only query args. The base skeleton for the id-map helpers below and
 * for any read that loads rows for a caller-supplied id list.
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
export const mapByIds = async <Row, Value = number>(
  ids: number[],
  buildSql: (placeholders: string) => string,
  toEntry: (row: Row) => [number, Value],
): Promise<Map<number, Value>> =>
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
 * A table's `id → name` projection, bound to its columns once. `byIds` returns
 * the map for the requested ids (empty ids ⇒ empty map); `all` returns it for
 * every row, ordered by id. Only the name column is decrypted, via the
 * decryption-agnostic `decryptName`; `table`/`alias`/`nameColumn` (`alias`
 * qualifies the selected columns, repo SQL convention) are internal constants.
 *
 * This is the single home for narrow id→name reads that skip the full-row cache:
 * the per-table `getXNamesByIds` wrappers bind it and expose `.byIds`, and the
 * pickers/labels that need every name call `.all()`.
 */
export const nameSource = <Raw>(
  table: string,
  alias: string,
  nameColumn: string,
  decryptName: Decryptor<Raw>,
) => ({
  all: (): NameMap =>
    decryptNameMap(
      queryAll<NameRow<Raw>>(
        nameSelect(table, alias, nameColumn, `ORDER BY ${alias}.id ASC`),
      ),
      decryptName,
    ),
  byIds: (ids: number[]): NameMap =>
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
    ),
});

/** A table's env-key-encrypted `name` column as an `id → name` source. The env
 * decrypt and the `name` column are the common case, so per-table wrappers bind
 * just the table and its singular-word alias, then take `.byIds` (narrow id
 * lookups) or `.all()` (every name, for pickers/labels). */
export const envNameSource = (table: string, alias: string) =>
  nameSource(table, alias, "name", (raw: EnvKeyEncrypted) => decrypt(raw));

/**
 * Map each row's `id` to one of its columns (`id → column`) for the rows of
 * `table` whose id is in `ids`, optionally narrowed by an extra `where`
 * fragment appended verbatim (e.g. ` AND modifier_id IS NOT NULL`). `Value` is
 * the column's stored type (a number unless the caller says otherwise —
 * strings and nullable columns work too). `alias` is the table's singular-word
 * alias and qualifies the selected columns. `table`, `alias`, `column` and
 * `where` are always internal constants, never user input.
 */
/** A batch loader: takes a list of ids and returns, for each id, the list of
 * related numbers found for it. Ids with no matches are absent from the map. */
export type ListsByIds = (ids: number[]) => Promise<Map<number, number[]>>;

export const columnMapByIds = <Value extends InValue = number>(
  table: string,
  alias: string,
  column: string,
  ids: number[],
  where = "",
): Promise<Map<number, Value>> =>
  mapByIds<{ id: number; value: Value }, Value>(
    ids,
    (placeholders) =>
      `SELECT ${alias}.id, ${alias}.${column} AS value FROM ${table} AS ${alias} WHERE ${alias}.id IN (${placeholders})${where}`,
    (row) => [row.id, row.value],
  );
