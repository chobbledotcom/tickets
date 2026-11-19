/**
 * The removal of rows together with the rows that belong to them. A child
 * table names its parent row in one column, so the child rows go first and
 * no child outlives its parent.
 */

import { executeBatch } from "#db/client.ts";
import type { RecordTarget, RecordTargets } from "#db/record-target.ts";
import {
  type Condition,
  equal,
  inQuery,
  named,
  type ValuesStatement,
} from "#db/select/expression.ts";
import type { TableHandle, TableName, TableWithId } from "#db/select/tables.ts";
import { deleteFrom, type Write } from "#db/write.ts";

/** A table whose rows belong to a row of another table, and the column that
 *  holds the id of that row. */
export type ChildRows = readonly [table: TableHandle, column: string];

/** The rows to remove: one id, or the ids that a read gives. */
export type RemovedIds = number | ValuesStatement<number>;

/** The test that keeps a row whose column holds one of the ids. */
const holdsOneOf = (column: string, ids: RemovedIds): Condition =>
  typeof ids === "number"
    ? equal(named<number>(column), ids)
    : inQuery(named<number>(column), ids);

/** The deletes that remove the rows of `table` with these ids, after the
 *  child rows of each table in `children`. */
export const removalWithChildren =
  (table: TableHandle<TableWithId>, children: readonly ChildRows[]) =>
  (ids: RemovedIds): Write<TableName>[] =>
    [...children, [table, "id"] as const].map(([rows, column]) =>
      deleteFrom(rows).where(() => holdsOneOf(`${rows.name}.${column}`, ids)),
    );

/** Run the deletes of one row and its child rows as one batch. */
export const inOneBatch =
  (removal: (id: number) => Write<TableName>[]) =>
  (id: number): Promise<void> =>
    executeBatch(removal(id));

/** The delete of every row of `table` that hangs off one record. */
export const targetRowsRemoval =
  <Kind extends string>(table: TableHandle, targets: RecordTargets<Kind>) =>
  (target: RecordTarget<Kind>): Write<TableName> =>
    deleteFrom(table).where(() => targets.where(target));
