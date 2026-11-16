/** Runs a write batch on the caller's open transaction, or on the client.
 *
 *  Writers that accept an optional {@link TxScope} share this step: inside a
 *  caller transaction the statements join that transaction, outside one they
 *  run as one client batch. */

import type { ResultSet } from "@libsql/client";
import { executeBatchWithResults, type TxScope } from "#db/client.ts";
import type { SqlStatement } from "#db/sql.ts";

export const batchOnScope = (
  statements: SqlStatement[],
  transaction?: TxScope,
): Promise<ResultSet[]> =>
  transaction
    ? transaction.batch(statements)
    : executeBatchWithResults(statements);
