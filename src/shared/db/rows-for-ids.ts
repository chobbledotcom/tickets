/** A read of the rows for a list of ids, where an empty list reads no row. */

import { queryAll } from "#db/client.ts";
import { type SqlStatement, sqlList } from "#db/sql.ts";

/** The rows that `statement` reads for these ids, through `readAll`. The
 *  statement gets the ids as the slots of an `IN (...)`. No id reads no row
 *  and sends no query, because `IN ()` is not valid SQL. */
export const rowsForIds = <Row>(
  ids: readonly number[],
  statement: (idSlots: SqlStatement) => SqlStatement,
  readAll: typeof queryAll = queryAll,
): Promise<Row[]> =>
  ids.length === 0
    ? Promise.resolve([])
    : readAll<Row>(statement(sqlList(ids)));
