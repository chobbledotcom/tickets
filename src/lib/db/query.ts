import type { InStatement } from "@libsql/client";

import { mapAsync } from "#fp";
import { getDb, resultRows } from "#lib/db/client.ts";
import { trackQuery } from "#lib/db/query-log.ts";

/**
 * Execute a statement and map result rows through an async transformer.
 *
 * Useful for running a query and decrypting/transforming each row via `table.fromDb`.
 */
export const queryAndMap = <Row, Out>(
  toOut: (row: Row) => Promise<Out>,
) =>
async (stmt: InStatement): Promise<Out[]> => {
  const sql = typeof stmt === "string" ? stmt : stmt.sql;
  const result = await trackQuery(sql, () => getDb().execute(stmt));
  return mapAsync(toOut)(resultRows<Row>(result));
};
