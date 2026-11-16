/**
 * One row of a table with an `id`: find it, add it, change it, and remove it.
 * Each write encodes its values through the column codecs, and the client
 * decodes each row that a read or a write gives back.
 *
 * The admin record layer works over any such table, so it holds the table
 * as a handle and names the row by its id.
 */

import { execute, queryOnePrimary, resultRows } from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { readExists, readOneRow } from "#db/read.ts";
import { type Condition, equal, named } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type {
  DecodedRowOf,
  NewRowOf,
  TableHandle,
  TableName,
  TableWithId,
} from "#db/select/tables.ts";
import type { RowsStatement } from "#db/sql.ts";
import {
  type ColumnName,
  deleteFrom,
  type InsertOptions,
  insertInto,
  type NewValues,
  rowsWith,
  update,
} from "#db/write.ts";

/** A new row as the code holds it: a value for every column that the
 *  database cannot fill, and any of the others. */
export type NewRecord<Name extends TableName> = {
  [Column in keyof NewRowOf<Name>]: DecodedRowOf<Name>[Column &
    keyof DecodedRowOf<Name>];
};

/** New values for some columns of a row, as the code holds them. */
export type RecordChanges<Name extends TableName> = Partial<DecodedRowOf<Name>>;

/** Every column of the table, for a write that gives back the whole row. */
const everyColumnOf = <Name extends TableName>(
  table: TableHandle<Name>,
): [ColumnName<Name>, ...ColumnName<Name>[]] =>
  table.columns.map(([column]) => column) as [
    ColumnName<Name>,
    ...ColumnName<Name>[],
  ];

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

/** The read of the whole row with this id. The read picks every column of
 *  the table, so each row it gives is the decoded row of the table. */
const rowRead = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
): RowsStatement<DecodedRowOf<Name>> =>
  rowById(table, id).everyColumn() as RowsStatement<DecodedRowOf<Name>>;

/** The row with this id, or null when there is none. */
export const findRow = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
): Promise<DecodedRowOf<Name> | null> => readOneRow(rowRead(table, id));

/** The row with this id, read on the primary. A write that reads its own
 *  row back uses this, because a replica can lag behind the write. */
export const findRowPrimary = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
): Promise<DecodedRowOf<Name> | null> => queryOnePrimary(rowRead(table, id));

/** Whether the table has a row with this id. */
export const hasRow = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
): Promise<boolean> =>
  readExists(rowById(table, id));

/** The insert of one row that gives back the row it wrote. */
export const insertRowStatement = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  values: NewRecord<Name>,
  options: InsertOptions<Name> = {},
): Promise<RowsStatement<DecodedRowOf<Name>>> =>
  insertInto(
    table,
    // Each column that the new row must give is in `values`, and `encoded`
    // keeps the columns that it is given.
    (await encoded(table, values as RecordChanges<Name>)) as NewValues<Name>,
    options,
  ).returning(...everyColumnOf(table)) as RowsStatement<DecodedRowOf<Name>>;

/** The update of the row with this id that gives back the row it wrote.
 *  `condition` must hold too, or the update changes no row. */
export const updateRowStatement = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
  changes: RecordChanges<Name>,
  condition: Condition = true,
): Promise<RowsStatement<DecodedRowOf<Name>>> =>
  update(table, await encoded(table, changes))
    .where(() => [withId(table.name, id)(), condition])
    .returning(...everyColumnOf(table)) as RowsStatement<DecodedRowOf<Name>>;

/** Add one row and give back the row that the table holds. */
export const insertRow = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  values: NewRecord<Name>,
): Promise<DecodedRowOf<Name>> => {
  const [row] = resultRows(
    await execute(await insertRowStatement(table, values)),
  );
  if (row === undefined) {
    throw new Error(`The insert into ${table.name} gave back no row`);
  }
  return row;
};

/** Change the row with this id, and give back the row that the table now
 *  holds. Null when there is no such row. Changes that name no column change
 *  nothing, so the row is read as it is. */
export const updateRow = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
  changes: RecordChanges<Name>,
): Promise<DecodedRowOf<Name> | null> => {
  if (Object.values(changes).every((value) => value === undefined)) {
    return findRow(table, id);
  }
  const [row] = resultRows(
    await execute(await updateRowStatement(table, id, changes)),
  );
  return row ?? null;
};

/** Remove the row with this id. */
export const deleteRow = async <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
): Promise<void> => {
  await execute(
    deleteFrom(table).where(rowsWith(table, "id" as ColumnName<Name>, id)),
  );
};
