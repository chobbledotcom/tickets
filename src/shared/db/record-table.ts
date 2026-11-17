/**
 * One row of a table with an `id`: find it, add it, change it, and remove it.
 * Each write encodes its values through the column codecs, and the client
 * decodes each row that a read or a write gives back.
 *
 * The admin record layer works over any such table, so it holds the table
 * as a handle and names the row by its id.
 */

import {
  execute,
  queryOnePrimary,
  resultRows,
  type TxScope,
} from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { readExists, readOneRow, readRows } from "#db/read.ts";
import {
  among,
  type Condition,
  desc,
  equal,
  lessThan,
  named,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node, Query, Where } from "#db/select/shape.ts";
import {
  type DecodedRowOf,
  type NewRowOf,
  type RowOf,
  type TableHandle,
  type TableName,
  type TableWithId,
  tables,
} from "#db/select/tables.ts";
import { type Read, type RowsStatement, typedSql } from "#db/sql.ts";
import {
  type Changes,
  type ColumnName,
  deleteFrom,
  type InsertOptions,
  insertInto,
  type NewValues,
  update,
  type Write,
} from "#db/write.ts";
import { fieldById } from "#fp";
import { fieldName } from "#shared/column-names.ts";
import { definedValuesBy } from "#shared/defined-values.ts";
import { nowIso } from "#shared/now.ts";
import { newRowDefaults } from "#shared/rest/field-defaults.ts";
import type { FieldSpecs } from "#shared/rest/field-specs.ts";

/** A new row as the code holds it: a value for every column that the
 *  database cannot fill, and any of the others. */
export type NewRecord<Name extends TableName> = {
  [Column in keyof NewRowOf<Name>]: DecodedRowOf<Name>[Column &
    keyof DecodedRowOf<Name>];
};

/** New values for some columns of a row, as the code holds them. */
export type RecordChanges<Name extends TableName> = Partial<DecodedRowOf<Name>>;

/** The write with every column of each row that it wrote. A type parameter
 *  hides the columns of the table, so the list comes from the handle. */
const givingRow = <Name extends TableName>(
  table: TableHandle<Name>,
  write: Write<Name>,
): RowsStatement<DecodedRowOf<Name>> =>
  write.returning(
    ...(table.columns.map(([column]) => fieldName(column)) as [
      ColumnName<Name>,
      ...ColumnName<Name>[],
    ]),
  ) as RowsStatement<DecodedRowOf<Name>>;

/** One id, or a list of ids. */
type Ids = number | readonly number[];

/** The condition that keeps the row with this id, or with one of these ids. A
 *  type parameter cannot name the `id` column of its node, so the condition
 *  names it by text. */
const withId =
  (word: string, ids: Ids): (() => Condition) =>
  () =>
    typeof ids === "number"
      ? equal(named<number>(`${word}.id`), ids)
      : among(named<number>(`${word}.id`), [...ids]);

/** The read of every column of each row that `query` keeps. A type parameter
 *  hides the camelCase fields of the table, so the row type comes from its
 *  name. */
const wholeRows = <Name extends TableName>(
  query: Query<Node<Name>>,
): RowsStatement<DecodedRowOf<Name>> =>
  typedSql<RowsStatement<DecodedRowOf<Name>>>(query.everyColumn());

/** The read of the row with this id, or of the rows with these ids. */
const rowsById = <Name extends TableWithId>(
  table: TableHandle<Name>,
  ids: Ids,
) => from(table).where(withId(table.singular, ids));

/** What one operation on the row with an id gives back, by its kind. */
type RowAnswer<Name extends TableName> = {
  exists: Promise<boolean>;
  found: Promise<DecodedRowOf<Name> | null>;
  removed: Promise<void>;
};

/** An operation on the row with this id. */
type ByRowId<Kind extends keyof RowAnswer<TableName>> = <
  Name extends TableWithId,
>(
  table: TableHandle<Name>,
  id: number,
) => RowAnswer<Name>[Kind];

/** The row with this id as `readOne` reads it, or null when there is none. */
const findRowWith =
  (readOne: <Row>(read: Read<Row>) => Promise<Row | null>): ByRowId<"found"> =>
  (table, id) =>
    readOne(wholeRows(rowsById(table, id)));

/** The row with this id, or null when there is none. */
const findRow = findRowWith(readOneRow);

/** The row with this id, read on the primary. A write that reads its own
 *  row back uses this, because a replica can lag behind the write. */
const findRowPrimary = findRowWith(queryOnePrimary);

/** The tables among `Among` whose rows have the column `Column`. */
type TableWith<Column extends string, Among extends TableName = TableName> = {
  [Name in Among]: Column extends keyof RowOf<Name> ? Name : never;
}[Among];

/** The name of each row with one of these ids, by id. The read opens only the
 *  name, so a label never loads the whole row. */
export const namesByIds =
  (table: TableHandle<TableWith<"name", TableWithId>>) =>
  async (ids: readonly number[]): Promise<Map<number, string>> =>
    fieldById("name")(await readRows(rowsById(table, ids).pick("id", "name")));

/** Every whole row of the table, newest first. A newer row has a higher id. */
export const allRowsNewestFirst =
  <Name extends TableWithId>(table: TableHandle<Name>) =>
  (): Promise<DecodedRowOf<Name>[]> =>
    readRows(
      wholeRows(
        from(table).orderBy(() => [
          desc(named<number>(`${table.singular}.id`)),
        ]),
      ),
    );

/** The first whole row that `where` keeps, or null when it keeps none. */
const findRowWhere = <Name extends TableName>(
  table: TableHandle<Name>,
  where: Where<Node<Name>>,
): Promise<DecodedRowOf<Name> | null> =>
  readOneRow(wholeRows(from(table).where(where).limit(1)));

/** Whether the table has a row with this id. */
const hasRow: ByRowId<"exists"> = (table, id) =>
  readExists(rowsById(table, id));

/** Remove every row of the table made before `cutoffIso`. */
export const pruneRowsBefore =
  (table: TableHandle<TableWith<"created">>) =>
  async (cutoffIso: string): Promise<void> => {
    await execute(
      deleteFrom(table).where(() =>
        lessThan(named<string>(`${table.name}.created`), cutoffIso),
      ),
    );
  };

/** Whether the read has a row, read on an open transaction. */
export const existsOn = async (
  tx: TxScope,
  query: Query<unknown, never>,
): Promise<boolean> => resultRows(await tx.execute(query.probe())).length > 0;

/** The stored values of `values`, typed for a write over any table. A type
 *  parameter hides the columns from the type of `encoded`, which keeps each
 *  column that it is given. */
const storedValues = <Name extends TableName, Stored>(
  table: TableHandle<Name>,
  values: RecordChanges<Name> | NewRecord<Name>,
): Promise<Stored> =>
  encoded(table, values as RecordChanges<Name>) as Promise<Stored>;

/** The insert of one row that gives back the row it wrote. */
const insertRowStatement = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  values: NewRecord<Name>,
  options: InsertOptions<Name> = {},
): Promise<RowsStatement<DecodedRowOf<Name>>> =>
  givingRow(
    table,
    insertInto(
      table,
      await storedValues<Name, NewValues<Name>>(table, values),
      options,
    ),
  );

/** The update of the row with this id that gives back the row it wrote.
 *  `guard` must hold too, or the update changes no row. Changes that name no
 *  column change nothing, so the statement reads the row as it is. */
const updateRowStatement = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
  changes: RecordChanges<Name>,
  guard: (row: Node<Name>) => Condition = () => true,
): Promise<RowsStatement<DecodedRowOf<Name>>> =>
  Object.values(changes).every((value) => value === undefined)
    ? wholeRows(rowsById(table, id).where(guard))
    : givingRow(
        table,
        update(
          table,
          await storedValues<Name, Changes<Name>>(table, changes),
        ).where((row) => [withId(table.name, id)(), guard(row)]),
      );

/** Run the statement that `build` makes, and give back the first row that it
 *  gives. When it gives none, the answer comes from `whenNone`. */
const firstRowOf =
  <Args extends [TableHandle<string>, ...unknown[]], Row, None>(
    build: (...args: Args) => Promise<RowsStatement<Row>>,
    whenNone: (table: TableHandle<string>) => None,
  ) =>
  async (...args: Args): Promise<Row | None> =>
    resultRows(await execute(await build(...args)))[0] ?? whenNone(args[0]);

/** Add one row and give back the row that the table holds. An insert that
 *  writes no row throws. */
const insertRow = firstRowOf(insertRowStatement, (table): never => {
  throw new Error(`The insert into ${table.name} gave back no row`);
});

/** Change the row with this id, and give back the row that the table now
 *  holds. Null when there is no such row. */
const updateRow = firstRowOf(updateRowStatement, () => null);

/** Remove the row with this id. */
const deleteRow: ByRowId<"removed"> = async (table, id) => {
  await execute(deleteFrom(table).where(withId(table.name, id)));
};

/** The row values that a record input names: each input key that is a field
 *  of the table. A key that names no field, such as side data for a join
 *  write, is left out. */
export const rowValuesOf = <Name extends TableName>(
  table: TableHandle<Name>,
  input: object,
): RecordChanges<Name> => {
  const named: Readonly<Record<string, unknown>> = { ...input };
  return definedValuesBy(
    table.columns,
    ([column]) => fieldName(column),
    ([column]) => named[fieldName(column)],
  ) as RecordChanges<Name>;
};

/** The values of a new row from a form input. First comes the time of the
 *  write, where the table records it. Then comes the declared default of each
 *  field in `fields`. Last come the values that the input names. The record
 *  rule checked first that the input names every required field, so the
 *  values make a whole new row. */
export const newRecordOf =
  <Name extends TableName>(table: TableHandle<Name>, fields: FieldSpecs = []) =>
  (input: object): NewRecord<Name> =>
    ({
      ...(table.columns.some(([column]) => column === "created")
        ? { created: nowIso() }
        : {}),
      ...newRowDefaults(fields),
      ...rowValuesOf(table, input),
    }) as NewRecord<Name>;

/** An insert of one row. The insert and its statement form share it. */
type RowInsert<Name extends TableWithId, Result> = (
  values: NewRecord<Name>,
  options?: InsertOptions<Name>,
) => Promise<Result>;

/** An update of the row with this id. The update and its statement form
 *  share it. */
type RowUpdate<Name extends TableWithId, Result> = (
  id: number,
  changes: RecordChanges<Name>,
  guard?: (row: Node<Name>) => Condition,
) => Promise<Result>;

/** The reads and writes of one row of a table with an `id`, by its id. */
export type Records<Name extends TableWithId> = Readonly<{
  /** The read of the row with this id, or of the rows with these ids. */
  byId: (ids: Ids) => Query<Node<Name>>;
  delete: (id: number) => Promise<void>;
  /** The row with this id, or null when there is none. */
  find: (id: number) => Promise<DecodedRowOf<Name> | null>;
  /** The row with this id, read on the primary. A write that reads its own
   *  row back uses this, because a replica can lag behind the write. */
  findPrimary: (id: number) => Promise<DecodedRowOf<Name> | null>;
  /** The first whole row that `where` keeps, or null when it keeps none. */
  findWhere: (where: Where<Node<Name>>) => Promise<DecodedRowOf<Name> | null>;
  has: (id: number) => Promise<boolean>;
  /** Add one row and give back the row that the table holds. */
  insert: RowInsert<Name, DecodedRowOf<Name>>;
  /** The insert of one row that gives back the row it wrote. */
  insertStatement: RowInsert<Name, RowsStatement<DecodedRowOf<Name>>>;
  /** Change the row with this id, and give back the row that the table now
   *  holds. Null when there is no such row. `guard` must hold too. */
  update: RowUpdate<Name, DecodedRowOf<Name> | null>;
  /** The update of the row with this id that gives back the row it wrote. */
  updateStatement: RowUpdate<Name, RowsStatement<DecodedRowOf<Name>>>;
}>;

/** The one-row reads and writes of `table`. Code over any table holds the
 *  table as a handle, and reaches its rows through this. */
export const recordsOf = <Name extends TableWithId>(
  table: TableHandle<Name>,
): Records<Name> => ({
  byId: (ids) => rowsById(table, ids),
  delete: (id) => deleteRow(table, id),
  find: (id) => findRow(table, id),
  findPrimary: (id) => findRowPrimary(table, id),
  findWhere: (where) => findRowWhere(table, where),
  has: (id) => hasRow(table, id),
  insert: (values, options) => insertRow(table, values, options),
  insertStatement: (values, options) =>
    insertRowStatement(table, values, options),
  update: (id, changes, guard) => updateRow(table, id, changes, guard),
  updateStatement: (id, changes, guard) =>
    updateRowStatement(table, id, changes, guard),
});

/** The one-row reads and writes of each table with an `id`, by its name. */
type RecordsByTable = { readonly [Name in TableWithId]: Records<Name> };

/** Whether the table has an `id` column. */
const hasId = (table: TableHandle): table is TableHandle<TableWithId> =>
  table.columns.some(([column]) => column === "id");

/** The handles of every table. */
const everyTable: readonly TableHandle[] = Object.values(tables);

/** Some of the one-row reads and writes, by the name of their table. */
type SomeRecords<Names extends TableWithId> = {
  -readonly [Name in Names]?: Records<Name>;
};

/** Adds the one-row reads and writes of `table` under its name. */
const addRecordsOf = <Name extends TableWithId>(
  byTable: SomeRecords<Name>,
  table: TableHandle<Name>,
): SomeRecords<Name> => {
  byTable[table.name] = recordsOf(table);
  return byTable;
};

/** The one-row reads and writes of each table with an `id`. The test that
 *  `hasId` makes at run time is the test that `TableWithId` makes on the
 *  types, so each name has its entry. */
export const records = everyTable
  .filter(hasId)
  .reduce<SomeRecords<TableWithId>>(addRecordsOf, {}) as RecordsByTable;
