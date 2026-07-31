/* jscpd:ignore-start */
import type { InValue, Row } from "@libsql/client";
import { mapParallel } from "#fp";
import { decrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  execute,
  inPlaceholders,
  queryAll,
  resultRows,
} from "#shared/db/client.ts";
/* jscpd:ignore-end */

/**
 * Execute a SQL query and map result rows through an async transformer.
 *
 * Useful for running a query and decrypting/transforming each row via `table.fromDb`.
 */
export const queryAndMap =
  <Row, Out>(toOut: (row: Row) => Promise<Out>) =>
  async (sql: string, args: InValue[] = []): Promise<Out[]> =>
    mapParallel(toOut)(resultRows<Row>(await execute(sql, args)));

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

export const columnFrom =
  (sourceName: string): ((name: string) => string) =>
  (name: string): string =>
    `${sourceName}.${name}`;

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
