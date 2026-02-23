import { mapAsync } from "#fp";
import { getDb, resultRows } from "#lib/db/client.ts";
import { trackQuery } from "#lib/db/query-log.ts";

/**
 * Execute a SQL query and map result rows through an async transformer.
 *
 * Useful for running a query and decrypting/transforming each row via `table.fromDb`.
 */
export const queryAndMap = <Row, Out>(
  toOut: (row: Row) => Promise<Out>,
) =>
async (sql: string): Promise<Out[]> => {
  const result = await trackQuery(sql, () => getDb().execute(sql));
  return mapAsync(toOut)(resultRows<Row>(result));
};
