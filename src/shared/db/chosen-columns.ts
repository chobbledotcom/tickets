/**
 * Reading a chosen set of a table's columns.
 *
 * A chosen set names the columns a read wants and reuses the table's own read
 * transforms to open them, so a narrow read decrypts and converts exactly what
 * it selected. Paired with the shared filters it also knows how to fetch
 * itself — {@link ChosenColumns.select} — so an ordinary single-table read
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
type ColumnNames<Row> = readonly [TableColumn<Row>, ...TableColumn<Row>[]];

/** A selected row before the table's declared read transforms run. Database
 * values are unknown here because booleans and encrypted strings have a
 * different stored representation from the application's Row type. */
export type StoredRowOf<Row, Columns extends ColumnNames<Row>> = {
  [Column in Columns[number]]: unknown;
};

type ChosenRow<Row, Columns extends ColumnNames<Row>> = Pick<
  Row,
  Columns[number]
>;

type ColumnQuery<Result> = (sql: string, args?: InValue[]) => Promise<Result>;

/**
 * A read declared rather than written. The chosen set already knows its table
 * and columns, so this is the whole of an ordinary single-table read; one that
 * joins or carries a subquery writes its own SQL and runs it through
 * {@link ChosenColumns.queryAll}.
 */
export type ReadRequest = {
  /** The filters, from `#shared/db/where-clauses.ts`. Absent keeps every row. */
  where?: WhereClause[];
  /** An `ORDER BY` body without the keyword. Omit for no ordering. */
  order?: string;
  /** A row cap. Omit for no limit. */
  limit?: number;
  /** Table alias, when the clauses qualify their columns with one. */
  alias?: string;
};

export interface ChosenColumns<Row, Columns extends ColumnNames<Row>> {
  readonly columns: Columns;
  columnsSql: (alias?: string) => string;
  queryAll: ColumnQuery<ChosenRow<Row, Columns>[]>;
  read: (
    row: StoredRowOf<Row, Columns>,
    rowId?: unknown,
  ) => Promise<ChosenRow<Row, Columns>>;
  readAll: (
    rows: StoredRowOf<Row, Columns>[],
  ) => Promise<ChosenRow<Row, Columns>[]>;
  /** Run a declared read and return every matching row. A filter that cannot
   * match anything skips the round-trip. */
  select: (query?: ReadRequest) => Promise<ChosenRow<Row, Columns>[]>;
  /** Run a declared read for at most one row. */
  selectOne: (query?: ReadRequest) => Promise<ChosenRow<Row, Columns> | null>;
}

/** Choose an explicit set of a table's own columns and reuse its read
 * transforms without loading or decrypting the rest of the row. */
export const chooseColumns = <
  Row,
  Input,
  const Columns extends ColumnNames<Row>,
>(
  table: Table<Row, Input>,
  columns: Columns,
): ChosenColumns<Row, Columns> => {
  const missingColumn = columns.find(
    (column) => !table.columns.includes(column),
  );
  if (missingColumn) {
    throw new Error(
      `Cannot select ${missingColumn} from ${table.name}: it is not one of its columns`,
    );
  }

  const read = async (
    row: StoredRowOf<Row, Columns>,
    rowId?: unknown,
  ): Promise<ChosenRow<Row, Columns>> => {
    const stored = row as Record<string, unknown>;
    const missingValueColumn = columns.find(
      (column) => !Object.hasOwn(stored, column),
    );
    if (missingValueColumn) {
      throw new Error(
        `Chosen column ${missingValueColumn} is missing from the ${table.name} rows read back`,
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
    return Object.fromEntries(entries) as ChosenRow<Row, Columns>;
  };
  const readAll = (
    rows: StoredRowOf<Row, Columns>[],
  ): Promise<ChosenRow<Row, Columns>[]> =>
    mapParallel((row: StoredRowOf<Row, Columns>) => read(row))(rows);

  const columnsSql = (alias?: string): string =>
    columns.map((column) => (alias ? `${alias}.${column}` : column)).join(", ");

  /** Turn a declared read into SQL and its bound values. The chosen set
   * supplies the columns and the table; the caller supplies the rest. */
  const statementFor = (query: ReadRequest): SqlStatement => {
    const from = query.alias ? `${table.name} AS ${query.alias}` : table.name;
    const tail = queryTail(query.where ?? [], query);
    return {
      args: tail.args,
      sql: `SELECT ${columnsSql(query.alias)} FROM ${from}${tail.sql}`,
    };
  };

  /** The stored rows a declared read selects, before the read transforms. */
  const storedRowsFor = (
    query: ReadRequest,
  ): Promise<StoredRowOf<Row, Columns>[]> =>
    rowsUnlessNoneMatch(query.where ?? [], () => {
      const { sql, args } = statementFor(query);
      return queryAll<StoredRowOf<Row, Columns>>(sql, args);
    });

  return {
    columns,
    columnsSql,
    queryAll: async (sql, args) =>
      readAll(await queryAll<StoredRowOf<Row, Columns>>(sql, args)),
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
