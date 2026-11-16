/** A hook on the read that `hasRow` runs, so a test can make the row go at
 *  that exact moment. */

import type { ResultSet } from "@libsql/client";
import { stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
import { rowsById } from "#db/record-table.ts";
import type { TableHandle, TableWithId } from "#db/select/tables.ts";
import { sqlText } from "#test-utils/sql-text.ts";

/** Run `around` in place of each check that row `id` of `table` is there.
 *  `check` runs the real read. Every other statement runs as it is. */
export const aroundRowCheck = <Name extends TableWithId>(
  table: TableHandle<Name>,
  id: number,
  around: (check: () => Promise<ResultSet>) => Promise<ResultSet>,
) => {
  const rowCheck = rowsById(table, id).probe().sql;
  const db = getDb();
  const realExecute = db.execute.bind(db);
  return stub(db, "execute", (...args) => {
    const run = () => realExecute(...(args as Parameters<typeof realExecute>));
    return sqlText(args[0]) === rowCheck ? around(run) : run();
  });
};
