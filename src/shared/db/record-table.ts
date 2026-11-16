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
  named,
} from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Matching, Node, Query } from "#db/select/shape.ts";
import type {
  DecodedRowOf,
  NewRowOf,
  RowOf,
  TableHandle,
  TableName,
  TableWithId,
} from "#db/select/tables.ts";
import type { Read, RowsStatement } from "#db/sql.ts";
import {
  type Changes,
  type ColumnName,
  deleteFrom,
  type InsertOptions,
  insertInto,
  type NewValues,
  rowsWith,
  update,
  type Write,
} from "#db/write.ts";
import { fieldById } from "#fp";
import { toCamelCase } from "#shared/column-names.ts";
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
    ...(table.columns.map(([column]) => column) as [
      ColumnName<Name>,
      ...ColumnName<Name>[],
    ]),
  ) as RowsStatement<DecodedRowOf<Name>>;

/** The condition that keeps the row with this id. A type parameter cannot
 *  name the `id` column of its node, so the condition names it by text. */
const withId =
  (word: string, id: number): (() => Condition) =>
  () =>
    equal(named<number>(`${word}.id`), id);

/** The read of the row with this id. */
export const rowById = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
) => from(table).where(withId(table.singular, id));

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

/** The row with this id as `readOne` reads it, or null when there is none.
 *  The read picks every column of the table, so each row it gives is the
 *  decoded row of the table. */
const findRowWith =
  (readOne: <Row>(read: Read<Row>) => Promise<Row | null>): ByRowId<"found"> =>
  (table, id) =>
    readOne(
      rowById(table, id).everyColumn() as RowsStatement<
        DecodedRowOf<typeof table.name>
      >,
    );

/** The row with this id, or null when there is none. */
export const findRow = findRowWith(readOneRow);

/** The row with this id, read on the primary. A write that reads its own
 *  row back uses this, because a replica can lag behind the write. */
export const findRowPrimary = findRowWith(queryOnePrimary);

/** The tables whose rows have an `id` and a `name`. */
type TableWithName = {
  [Name in TableWithId]: "name" extends keyof RowOf<Name> ? Name : never;
}[TableWithId];

/** The name of each row with one of these ids, by id. The read opens only the
 *  name, so a label never loads the whole row. */
export const namesByIds =
  (table: TableHandle<TableWithName>) =>
  async (ids: readonly number[]): Promise<Map<number, string>> =>
    fieldById("name")(
      await readRows(
        from(table)
          .where(() => among(named<number>(`${table.singular}.id`), [...ids]))
          .pick("id", "name"),
      ),
    );

/** Every whole row of the table, newest first. A newer row has a higher id. */
export const allRowsNewestFirst =
  <Name extends TableWithId>(table: TableHandle<Name>) =>
  (): Promise<DecodedRowOf<Name>[]> =>
    readRows(
      from(table)
        .orderBy(() => [desc(named<number>(`${table.singular}.id`))])
        .everyColumn() as RowsStatement<DecodedRowOf<Name>>,
    );

/** The first whole row that `where` keeps, or null when it keeps none. */
export const findRowWhere = <Name extends TableName>(
  table: TableHandle<Name>,
  where: Matching<Node<Name>>,
): Promise<DecodedRowOf<Name> | null> =>
  readOneRow(
    from(table).where(where).limit(1).everyColumn() as RowsStatement<
      DecodedRowOf<Name>
    >,
  );

/** Whether the table has a row with this id. */
export const hasRow: ByRowId<"exists"> = (table, id) =>
  readExists(rowById(table, id));

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
export const insertRowStatement = async <Name extends TableWithId>(
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
export const updateRowStatement = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
  changes: RecordChanges<Name>,
  guard: (row: Node<Name>) => Condition = () => true,
): Promise<RowsStatement<DecodedRowOf<Name>>> =>
  Object.values(changes).every((value) => value === undefined)
    ? (rowById(table, id).where(guard).everyColumn() as RowsStatement<
        DecodedRowOf<Name>
      >)
    : givingRow(
        table,
        update(
          table,
          await storedValues<Name, Changes<Name>>(table, changes),
        ).where((row) => [withId(table.name, id)(), guard(row)]),
      );

/** Run the statement that `build` makes, and give back the first row that it
 *  gives, or null when it gives none. */
const firstRowOf =
  <Args extends unknown[], Row>(
    build: (...args: Args) => Promise<RowsStatement<Row>>,
  ) =>
  async (...args: Args): Promise<Row | null> =>
    resultRows(await execute(await build(...args)))[0] ?? null;

/** Run the insert that `build` makes, and give back the row that it wrote. An
 *  insert that writes no row throws. */
const insertedRowOf =
  <Args extends [TableHandle<string>, ...unknown[]], Row>(
    build: (...args: Args) => Promise<RowsStatement<Row>>,
  ) =>
  async (...args: Args): Promise<Row> => {
    const row = await firstRowOf(build)(...args);
    if (row === null) {
      throw new Error(`The insert into ${args[0].name} gave back no row`);
    }
    return row;
  };

/** Add one row and give back the row that the table holds. */
export const insertRow = insertedRowOf(insertRowStatement);

/** Change the row with this id, and give back the row that the table now
 *  holds. Null when there is no such row. */
export const updateRow = firstRowOf(updateRowStatement);

/** Remove the row with this id. */
export const deleteRow: ByRowId<"removed"> = async (table, id) => {
  await execute(deleteFrom(table).where(rowsWith(table, "id", id)));
};

/** The row values that a record input names. A form names each column in
 * camelCase, so each input key that names a column of the table becomes that
 * column. A key that names no column, such as side data for a join write, is
 * left out. */
export const rowValuesOf = <Name extends TableName>(
  table: TableHandle<Name>,
  input: object,
): RecordChanges<Name> => {
  const named: Readonly<Record<string, unknown>> = { ...input };
  return Object.fromEntries(
    table.columns.flatMap(([column]) => {
      const value = named[toCamelCase(column)];
      return value === undefined ? [] : [[column, value]];
    }),
  ) as RecordChanges<Name>;
};

/** The values of a new row from a record input. First comes the time of the
 * write, where the table records it. Then comes the declared default of each
 * field in `fields`. Last come the values that the input names. */
export const newRowValuesOf = <Name extends TableName>(
  table: TableHandle<Name>,
  input: object,
  fields: FieldSpecs = [],
): RecordChanges<Name> => ({
  ...(table.columns.some(([column]) => column === "created")
    ? { created: nowIso() }
    : {}),
  ...newRowDefaults(fields),
  ...rowValuesOf(table, input),
});
