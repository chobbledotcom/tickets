import type { ResultSet } from "@libsql/client";
import { trackSql } from "#db/query-log.ts";
import type { SqlStatement } from "#db/sql.ts";
import type { StatementTransaction } from "#db/statement-client.ts";

/** Track both read snapshots and write transactions through the same query log. */
export const trackedTxBatch =
  (tx: Pick<StatementTransaction, "batch">) =>
  (statements: SqlStatement[]): Promise<ResultSet[]> =>
    trackSql(
      statements.map((statement) => statement.sql),
      () => tx.batch(statements),
    );

export const trackedTxExecute =
  (tx: Pick<StatementTransaction, "execute">) =>
  (statement: SqlStatement): Promise<ResultSet> =>
    trackSql(statement.sql, () => tx.execute(statement));
