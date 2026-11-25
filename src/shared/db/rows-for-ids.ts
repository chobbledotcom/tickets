/** A read of the rows for a list of ids, where an empty list reads no row. */

import { queryAll } from "#db/client.ts";
import { type SqlStatement, sqlList } from "#db/sql.ts";

/** A read for a list of records that gives back one value for each record
 *  that has one, keyed by its id. */
export type ReadByIds<Value> = (
  ids: readonly number[],
) => Promise<Map<number, Value>>;

/** The rows that `read` gives for these ids. No id reads no row and sends no
 *  query, because `IN ()` is not valid SQL. */
export const readForIds = <Row>(
  ids: readonly number[],
  read: () => Promise<Row[]>,
): Promise<Row[]> => (ids.length === 0 ? Promise.resolve([]) : read());

/** The rows that `statement` reads for these ids, through `readAll`. The
 *  statement gets the ids as the slots of an `IN (...)`. */
export const rowsForIds = <Row>(
  ids: readonly number[],
  statement: (idSlots: SqlStatement) => SqlStatement,
  readAll: typeof queryAll = queryAll,
): Promise<Row[]> =>
  readForIds(ids, () => readAll<Row>(statement(sqlList(ids))));
