import type { ResultSet } from "@libsql/client";

/** A minimal libsql ResultSet for stubbed execute/batch calls. The `toJSON`
 *  method is deliberately omitted (nothing in the exercised paths calls it),
 *  so this file stays fully covered. */
export const emptyResultSet = (): ResultSet =>
  ({
    columns: [],
    columnTypes: [],
    lastInsertRowid: undefined,
    rows: [],
    rowsAffected: 0,
  }) as unknown as ResultSet;
