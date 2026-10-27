import type { InStatement, ResultSet, Transaction } from "@libsql/client";
import { trackSql } from "#db/query-log.ts";
import { sqlOf } from "#db/sql-text.ts";

/** Track both read snapshots and write transactions through the same query log. */
export const trackedTxBatch =
  (tx: Transaction) =>
  (statements: InStatement[]): Promise<ResultSet[]> =>
    trackSql(statements.map(sqlOf), () => tx.batch(statements));

export const trackedTxExecute =
  (tx: Transaction) =>
  (stmt: InStatement): Promise<ResultSet> =>
    trackSql(sqlOf(stmt), () => tx.execute(stmt));
