/**
 * Opening a chosen set of a table's columns.
 *
 * A chosen set names the columns a read wants and reuses the table's own read
 * transforms to open them, so a narrow read decrypts and converts exactly what
 * it selected. It says which columns a read must select and turns the values
 * that come back into a row — nothing more. Running the read is the reader's
 * job (`#shared/db/table-reader.ts` for a table's own rows, `readRows` for a
 * join), and both of them open their rows with this.
 */

import { mapParallel } from "#fp";
import type { ReadColumn, TableSchema } from "#shared/db/table.ts";

type TableColumn<Row> = keyof Row & string;

/** What reading a table's own rows needs to know about it: which columns it
 * has, what to call them, and how to open a stored value. Every defined table
 * is one of these — naming the part a read uses keeps a reader from depending
 * on the write half of a table. */
export type ReadableTable<Row> = {
  columns: readonly string[];
  name: string;
  primaryKey: keyof Row & string;
  readColumn: ReadColumn<Row>;
  schema: TableSchema<Row>;
};

/** One or more of a row's own column names — a read must select something. */
export type ColumnNames<Row> = readonly [
  TableColumn<Row>,
  ...TableColumn<Row>[],
];

/** A selected row before the table's declared read transforms run. Database
 * values are unknown here because booleans and encrypted strings have a
 * different stored representation from the application's Row type. */
export type StoredRowOf<Row, Columns extends ColumnNames<Row>> = {
  [Column in Columns[number]]: unknown;
};

/** The row a chosen set hands back: exactly the columns it named. */
export type ChosenRow<Row, Columns extends ColumnNames<Row>> = Pick<
  Row,
  Columns[number]
>;

export interface ChosenColumns<Row, Columns extends ColumnNames<Row>> {
  readonly columns: Columns;
  /** The chosen columns as a SELECT list — what a join must select for this set
   * to open its rows. */
  columnsSql: (alias?: string) => string;
  read: (
    row: StoredRowOf<Row, Columns>,
    rowId?: unknown,
  ) => Promise<ChosenRow<Row, Columns>>;
  readAll: (
    rows: StoredRowOf<Row, Columns>[],
  ) => Promise<ChosenRow<Row, Columns>[]>;
  /** The same list a read of this table's own rows must select: the chosen
   * columns, plus the row's own key when it was not chosen. A column's read
   * transform may name the row a bad value came from, and it can only do that
   * if the key came back too. */
  readColumnsSql: (alias?: string) => string;
}

/** Choose an explicit set of a table's own columns and reuse its read
 * transforms without loading or decrypting the rest of the row. */
export const chooseColumns = <Row, const Columns extends ColumnNames<Row>>(
  table: ReadableTable<Row>,
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

  const qualified = (column: string, alias?: string): string =>
    alias ? `${alias}.${column}` : column;

  const columnsSql = (alias?: string): string =>
    columns.map((column) => qualified(column, alias)).join(", ");

  const readColumnsSql = (alias?: string): string =>
    columns.some((column) => column === table.primaryKey)
      ? columnsSql(alias)
      : `${columnsSql(alias)}, ${qualified(table.primaryKey, alias)}`;

  return { columns, columnsSql, read, readAll, readColumnsSql };
};
