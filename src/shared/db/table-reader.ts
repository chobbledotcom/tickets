/**
 * Reading a table's own rows, with the filter written as the row.
 *
 * A table already declares its columns, their types, and how to open them. A
 * read of that table should not have to say any of it again — so it doesn't:
 * name the table and the reader knows what to select, what shape comes back,
 * and how to decrypt it.
 *
 * The filter is the row's own shape, so a column that does not exist, or a
 * value of the wrong type, is a mistake the compiler catches rather than the
 * database. A read that joins, or that selects something SQL invents, has no
 * table to infer from — those say their read with `readRows` instead.
 */

import type { InValue } from "@libsql/client";
import {
  type ChosenColumns,
  type ColumnNames,
  chooseColumns,
} from "#shared/db/chosen-columns.ts";
import type { Table } from "#shared/db/table.ts";
import { equals, inList, type WhereClause } from "#shared/db/where-clauses.ts";

/**
 * Which rows to keep, written as the row itself: a value means "equals this",
 * a list means "is one of these". An absent column does not constrain, and an
 * empty filter keeps every row.
 *
 * One item and many are the same filter — `{ id: 3 }` and `{ id: [3] }` differ
 * only in how they read, never in which path runs.
 */
export type RowFilter<Row> = {
  [Column in keyof Row]?: Row[Column] extends InValue
    ? Row[Column] | readonly Row[Column][]
    : never;
};

/** The rest of a read: how the rows come back, and how many. */
export type RowOptions = {
  /** An `ORDER BY` body without the keyword. Omit for no ordering. */
  order?: string;
  /** A row cap. Omit for no limit. */
  limit?: number;
};

/** Turn a filter written as a row into the shared clause vocabulary. */
const filterClauses = <Row>(filter: RowFilter<Row>): WhereClause[] =>
  Object.entries(filter).flatMap(([column, value]) =>
    Array.isArray(value)
      ? inList(column, value as readonly InValue[])
      : equals(column, value as Exclude<InValue, null>),
  );

/**
 * Reading some rows of one table, or one of them. The filter covers the whole
 * row — a read may narrow what it *selects* without narrowing what it can ask
 * about — while `Selected` is what comes back.
 */
export type Rows<Row, Selected = Row> = {
  /** Every row the filter keeps. */
  many: (filter?: RowFilter<Row>, options?: RowOptions) => Promise<Selected[]>;
  /** The first row the filter keeps, or null when it keeps none. */
  one: (
    filter?: RowFilter<Row>,
    options?: RowOptions,
  ) => Promise<Selected | null>;
};

/** Reading a table: its whole row, or just the columns a caller names. */
export type TableReader<Row> = Rows<Row> & {
  /** The same reads over a narrower set of columns — nothing else is selected,
   * so nothing else is fetched or decrypted. */
  pick: <const Columns extends ColumnNames<Row>>(
    columns: Columns,
  ) => Rows<Row, Pick<Row, Columns[number]>>;
};

const rowsOf = <Row, Columns extends ColumnNames<Row>>(
  chosen: ChosenColumns<Row, Columns>,
): Rows<Row, Pick<Row, Columns[number]>> => ({
  many: (filter = {}, options = {}) =>
    chosen.select({ ...options, where: filterClauses(filter) }),
  one: (filter = {}, options = {}) =>
    chosen.selectOne({ ...options, where: filterClauses(filter) }),
});

/**
 * The reader for a table. `pick` narrows the columns; calling the reader's own
 * `one`/`many` reads the whole row.
 */
export const readerFor = <Row, Input>(
  table: Table<Row, Input>,
): TableReader<Row> => {
  const pick = <const Columns extends ColumnNames<Row>>(
    columns: Columns,
  ): Rows<Row, Pick<Row, Columns[number]>> =>
    rowsOf(chooseColumns(table, columns));
  // A table's declared columns are exactly the keys of its row, and a table
  // with no columns cannot be declared — so this is the whole row.
  const whole = pick(table.columns as unknown as ColumnNames<Row>) as Rows<
    Row,
    Row
  >;
  return { ...whole, pick };
};
