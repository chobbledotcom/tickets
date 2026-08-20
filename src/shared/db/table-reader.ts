/**
 * Reading a table's own rows, with the filter written as the row.
 *
 * A table already declares its columns, their types, and how to open them. A
 * read of that table should not have to say any of it again — so it doesn't:
 * `table.read` knows what to select, what shape comes back, and how to decrypt
 * it. Every ordinary read of a table's own rows goes through it.
 *
 * The filter is the row's own shape, so a column that does not exist, or a
 * value of the wrong type, is a mistake the compiler catches rather than the
 * database. A read that joins, or that selects something SQL invents, has no
 * table to infer from — those say their read with `readRows` instead, and open
 * their rows with the same chosen set (`table.read.pick([...])`).
 */

import type { InValue } from "@libsql/client";
import {
  type ChosenColumns,
  type ChosenRow,
  type ColumnNames,
  chooseColumns,
  type ReadableTable,
  type StoredRowOf,
} from "#db/chosen-columns.ts";
import type { SqlStatement } from "#db/client.ts";
import { type Read, readOneRow, readRows, readStatement } from "#db/read.ts";
import type { TableSchema } from "#db/table.ts";
import { equals, inList, type WhereClause } from "#db/where-clauses.ts";
import { once } from "#fp";

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

/** The rest of a read: which other rows to keep, how they come back, and how
 * many. */
export type RowOptions = {
  /**
   * Filters the row shape cannot say — a subquery, a comparison, a condition
   * built from settings. Written with the shared clause helpers in
   * `#shared/db/where-clauses.ts`, and combined with the row filter by AND.
   */
  where?: WhereClause[];
  /** Table alias, when the clauses or the order qualify their columns. */
  alias?: string;
  /** An `ORDER BY` body without the keyword. Omit for no ordering. */
  order?: string;
  /** A row cap. Omit for no limit. */
  limit?: number;
};

/**
 * Turn a filter written as a row into the shared clause vocabulary.
 *
 * Two kinds of column are refused rather than answered wrongly. One the table
 * does not store — a value worked out from another table — is not there to be
 * compared against, so the database would fail on a column it has never heard
 * of. One stored in a different form from the value the caller holds — an
 * encrypted one — would match plaintext against ciphertext and quietly find
 * nothing; such a value is found by the column carrying its one-way code,
 * which is stored as it is written.
 */
const filterClauses = <Row>(
  table: { columns: readonly string[]; name: string; schema: TableSchema<Row> },
  filter: RowFilter<Row>,
  alias: string | undefined,
): WhereClause[] =>
  Object.entries(filter).flatMap(([column, value]) => {
    if (!table.columns.includes(column)) {
      throw new Error(
        `Cannot filter ${table.name} by ${column}: it is not one of its columns. A value worked out from another table cannot be compared against.`,
      );
    }
    if (table.schema[column as keyof Row]?.write !== undefined) {
      throw new Error(
        `Cannot filter ${table.name} by ${column}: it is stored in a different form from the value you have. Filter on the column holding its one-way code instead.`,
      );
    }
    const named = alias ? `${alias}.${column}` : column;
    return Array.isArray(value)
      ? inList(named, value as readonly InValue[])
      : equals(named, value as Exclude<InValue, null>);
  });

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
  /** The same read as a statement, for a caller that must run it somewhere
   * this reader cannot reach: inside an open transaction, or as one leg of a
   * batch. The rows it returns are opened with {@link ChosenColumns.readAll},
   * the same way this reader opens its own. */
  statement: (filter?: RowFilter<Row>, options?: RowOptions) => SqlStatement;
};

/**
 * A named set of a table's columns: it reads them, and it opens the rows a
 * join read for it. One set, so a join and a plain read can never disagree
 * about which columns they mean.
 */
export type Selection<Row, Columns extends ColumnNames<Row>> = ChosenColumns<
  Row,
  Columns
> &
  Rows<Row, Pick<Row, Columns[number]>>;

/**
 * Reading a table: its whole stored row, or just the columns a caller names.
 *
 * "Whole" means every column the table stores. A table that works some of its
 * values out from other tables — a listing's first image, say — does not carry
 * those here, and cannot: they are not columns, so `pick` refuses to name them
 * too. A read that wants them says so in its own SQL.
 */
export type TableReader<Row> = Rows<Row> & {
  /**
   * Whether any row passes the filter, read as narrowly as that question
   * allows: the row's own key, capped at one row. Nothing else is fetched, so
   * nothing else is decrypted to answer a yes-or-no — and unlike a whole-row
   * read, a table that works some of its values out from other tables can
   * still answer it.
   */
  exists: (filter?: RowFilter<Row>, options?: RowOptions) => Promise<boolean>;

  /** The same reads over a narrower set of columns — nothing else is selected,
   * so nothing else is fetched or decrypted. */
  pick: <const Columns extends ColumnNames<Row>>(
    columns: Columns,
  ) => Selection<Row, Columns>;
};

/**
 * The filter naming one row by its own key. Code that works over any table —
 * the CRUD resources — cannot spell a key column it does not know the name of,
 * so the one place that has to is here.
 */
export const byPrimaryKey = <Row>(
  table: { primaryKey: keyof Row & string },
  key: InValue,
): RowFilter<Row> => ({ [table.primaryKey]: key }) as RowFilter<Row>;

const selectionOf = <Row, Columns extends ColumnNames<Row>>(
  table: ReadableTable<Row>,
  chosen: ChosenColumns<Row, Columns>,
): Selection<Row, Columns> => {
  /** The chosen set supplies the columns and the table; the caller supplies
   * the rest of the read. */
  const readFor = (
    filter: RowFilter<Row>,
    { alias, limit, order, where = [] }: RowOptions,
  ): Read => ({
    columns: chosen.readColumnsSql(alias),
    from: alias ? `${table.name} AS ${alias}` : table.name,
    limit,
    order,
    where: [...filterClauses(table, filter, alias), ...where],
  });

  const rowsOf = async (read: Read): Promise<ChosenRow<Row, Columns>[]> =>
    chosen.readAll(await readRows<StoredRowOf<Row, Columns>>(read));

  const rowOf = async (read: Read): Promise<ChosenRow<Row, Columns> | null> => {
    const row = await readOneRow<StoredRowOf<Row, Columns>>(read);
    return row === null ? null : chosen.read(row);
  };

  // The read is built before anything is awaited, so a filter the table refuses
  // fails at the call rather than in a rejected promise later.
  return {
    ...chosen,
    many: (filter = {}, options = {}) => rowsOf(readFor(filter, options)),
    one: (filter = {}, options = {}) => rowOf(readFor(filter, options)),
    statement: (filter = {}, options = {}) =>
      readStatement(readFor(filter, options)),
  };
};

/**
 * The reader for a table. `pick` narrows the columns; calling the reader's own
 * `one`/`many` reads the whole row.
 */
export const readerFor = <Row>(table: ReadableTable<Row>): TableReader<Row> => {
  const pick = <const Columns extends ColumnNames<Row>>(
    columns: Columns,
  ): Selection<Row, Columns> =>
    selectionOf(table, chooseColumns(table, columns));

  // A whole-row read can only promise the whole row when the row IS the
  // table's stored columns. A table that works some of its values out from
  // other tables has more in its row than it stores, so a read of every column
  // would still be missing some and the promise would be a lie. Only the
  // whole-row reads are refused — `pick` is how such a table is read — so the
  // check waits until a whole-row read is actually asked for.
  const whole = once((): Rows<Row, Row> => {
    const workedOut = Object.keys(table.schema).filter(
      (column) => table.schema[column as keyof Row]?.projected,
    );
    if (workedOut.length > 0) {
      throw new Error(
        `${table.name} has values that are not stored columns (${workedOut.join(", ")}), so a whole-row read cannot return them. Name the columns you want with read.pick instead.`,
      );
    }
    // A table's declared columns are exactly the keys of its row, and a table
    // with no columns cannot be declared — so this is the whole stored row.
    return pick(table.columns as unknown as ColumnNames<Row>) as Rows<Row, Row>;
  });

  // Every existence check reads the same one column, so the set is built once.
  const key = once(() =>
    pick([table.primaryKey] as unknown as ColumnNames<Row>),
  );

  return {
    // Reading one row already caps the read at one, so this asks for nothing
    // beyond the key column itself.
    exists: async (filter, options) =>
      (await key().one(filter, options)) !== null,
    many: (filter, options) => whole().many(filter, options),
    one: (filter, options) => whole().one(filter, options),
    pick,
    statement: (filter, options) => whole().statement(filter, options),
  };
};
