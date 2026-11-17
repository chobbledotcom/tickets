/**
 * The libsql client and transaction types, narrowed so that they run only
 * statements that the `sql` tag built.
 */

import type {
  Client,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";
import type { SqlStatement } from "#db/sql.ts";

/** Run statements that the `sql` tag built. */
type StatementRunners = {
  batch: (statements: SqlStatement[]) => Promise<ResultSet[]>;
  execute: (statement: SqlStatement) => Promise<ResultSet>;
};

/** A libsql transaction that runs only statements the `sql` tag built. */
export type StatementTransaction = Omit<
  Transaction,
  "batch" | "execute" | "executeMultiple"
> &
  StatementRunners;

/** The libsql client, narrowed to run only statements the `sql` tag built. */
export type StatementClient = Omit<
  Client,
  "batch" | "execute" | "executeMultiple" | "migrate" | "transaction"
> & {
  batch: (
    statements: SqlStatement[],
    mode?: TransactionMode,
  ) => Promise<ResultSet[]>;
  transaction: (mode?: TransactionMode) => Promise<StatementTransaction>;
} & Pick<StatementRunners, "execute">;
