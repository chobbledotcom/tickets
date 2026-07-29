/**
 * Reading a chosen set of a table's columns.
 *
 * A projection names the columns a read wants and reuses the table's own read
 * transforms to open them, so a narrow read decrypts and converts exactly what
 * it selected. Paired with the shared filters it also knows how to fetch
 * itself — {@link TableProjection.select} — so an ordinary single-table read
 * needs no SQL of its own.
 */

import type { InValue } from "@libsql/client";
import { mapParallel } from "#fp";
import { queryAll, type SqlStatement } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import {
  queryTail,
  rowsUnlessNoneMatch,
  type WhereClause,
} from "#shared/db/where-clauses.ts";

type TableColumn<Row> = keyof Row & string;
type ProjectionColumns<Row> = readonly [
  TableColumn<Row>,
  ...TableColumn<Row>[],
];

/** A selected row before the table's declared read transforms run. Database
 * values are unknown here because booleans and encrypted strings have a
 * different stored representation from the application's Row type. */
export type StoredTableProjectionRow<
  Row,
  Columns extends ProjectionColumns<Row>,
> = {
  [Column in Columns[number]]: unknown;
};

type SelectedTableProjectionRow<
  Row,
  Columns extends ProjectionColumns<Row>,
> = Pick<Row, Columns[number]>;

type TableProjectionQuery<Result> = (
  sql: string,
  args?: InValue[],
) => Promise<Result>;

/**
 * A read declared rather than written. The projection already knows its table
 * and columns, so this is the whole of an ordinary single-table read; one that
 * joins or carries a subquery writes its own SQL and runs it through
 * {@link TableProjection.queryAll}.
 */
export type ProjectionSelect = {
  /** The filters, from `#shared/db/where-clauses.ts`. Absent keeps every row. */
  where?: WhereClause[];
  /** An `ORDER BY` body without the keyword. Omit for no ordering. */
  order?: string;
  /** A row cap. Omit for no limit. */
  limit?: number;
  /** Table alias, when the clauses qualify their columns with one. */
  alias?: string;
};

export interface TableProjection<Row, Columns extends ProjectionColumns<Row>> {
  readonly columns: Columns;
  columnsSql: (alias?: string) => string;
  queryAll: TableProjectionQuery<SelectedTableProjectionRow<Row, Columns>[]>;
  read: (
    row: StoredTableProjectionRow<Row, Columns>,
    rowId?: unknown,
  ) => Promise<SelectedTableProjectionRow<Row, Columns>>;
  readAll: (
    rows: StoredTableProjectionRow<Row, Columns>[],
  ) => Promise<SelectedTableProjectionRow<Row, Columns>[]>;
  /** Run a declared read and return every matching row. A filter that cannot
   * match anything skips the round-trip. */
  select: (
    query?: ProjectionSelect,
  ) => Promise<SelectedTableProjectionRow<Row, Columns>[]>;
  /** Run a declared read for at most one row. */
  selectOne: (
    query?: ProjectionSelect,
  ) => Promise<SelectedTableProjectionRow<Row, Columns> | null>;
}

/** Define an explicit physical-column projection and reuse the table's read
 * transforms without loading or decrypting the rest of the row. */
export const defineTableProjection = <
  Row,
  Input,
  const Columns extends ProjectionColumns<Row>,
>(
  table: Table<Row, Input>,
  columns: Columns,
): TableProjection<Row, Columns> => {
  const missingColumn = columns.find(
    (column) => !table.columns.includes(column),
  );
  if (missingColumn) {
    throw new Error(
      `Cannot select projected column ${missingColumn} from ${table.name}`,
    );
  }

  const read = async (
    row: StoredTableProjectionRow<Row, Columns>,
    rowId?: unknown,
  ): Promise<SelectedTableProjectionRow<Row, Columns>> => {
    const stored = row as Record<string, unknown>;
    const missingValueColumn = columns.find(
      (column) => !Object.hasOwn(stored, column),
    );
    if (missingValueColumn) {
      throw new Error(
        `Projected column ${missingValueColumn} is missing from ${table.name} query result`,
      );
    }
    const readRowId = rowId === undefined ? stored[table.primaryKey] : rowId;
    const entries = await mapParallel(
      async (column: Columns[number]) =>
        [
          column,
          await table.readColumn(
            column,
            stored[column] as Row[Columns[number]],
            readRowId,
          ),
        ] as const,
    )([...columns]);
    return Object.fromEntries(entries) as SelectedTableProjectionRow<
      Row,
      Columns
    >;
  };
  const readAll = (
    rows: StoredTableProjectionRow<Row, Columns>[],
  ): Promise<SelectedTableProjectionRow<Row, Columns>[]> =>
    mapParallel((row: StoredTableProjectionRow<Row, Columns>) => read(row))(
      rows,
    );

  const columnsSql = (alias?: string): string =>
    columns.map((column) => (alias ? `${alias}.${column}` : column)).join(", ");

  /** Turn a declared read into SQL and its bound values. The projection
   * supplies the columns and the table; the caller supplies the rest. */
  const statementFor = (query: ProjectionSelect): SqlStatement => {
    const from = query.alias ? `${table.name} AS ${query.alias}` : table.name;
    const tail = queryTail(query.where ?? [], query);
    return {
      args: tail.args,
      sql: `SELECT ${columnsSql(query.alias)} FROM ${from}${tail.sql}`,
    };
  };

  /** The stored rows a declared read selects, before the read transforms. */
  const storedRowsFor = (
    query: ProjectionSelect,
  ): Promise<StoredTableProjectionRow<Row, Columns>[]> =>
    rowsUnlessNoneMatch(query.where ?? [], () => {
      const { sql, args } = statementFor(query);
      return queryAll<StoredTableProjectionRow<Row, Columns>>(sql, args);
    });

  return {
    columns,
    columnsSql,
    queryAll: async (sql, args) =>
      readAll(
        await queryAll<StoredTableProjectionRow<Row, Columns>>(sql, args),
      ),
    read,
    readAll,
    select: async (query = {}) => readAll(await storedRowsFor(query)),
    selectOne: async (query = {}) => {
      // One row is a read capped at one — the same path, not a second one.
      const row = (await storedRowsFor({ ...query, limit: 1 }))[0];
      return row === undefined ? null : read(row);
    },
  };
};
