import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";
import { proxyMembers } from "#shared/proxy-members.ts";

export type ExecuteMethod = (
  statement: InStatement | string,
  args?: InArgs,
) => Promise<ResultSet>;

type AroundExecute = (
  statement: InStatement | string,
  run: () => Promise<ResultSet>,
) => Promise<ResultSet>;

/** Build an execute method whose caller can count, time, or intercept the call. */
export const wrapExecute =
  (target: Pick<Client, "execute">, around: AroundExecute): ExecuteMethod =>
  (statement, args) =>
    around(statement, () =>
      typeof statement === "string" && args !== undefined
        ? target.execute(statement, args)
        : target.execute(statement as InStatement),
    );

/** Start a transaction without passing an explicit undefined mode. */
export const beginTransaction = (
  target: Pick<Client, "transaction">,
  mode?: TransactionMode,
): Promise<Transaction> =>
  mode === undefined ? target.transaction() : target.transaction(mode);

/** The name of one interactive transaction operation, so a wrapper can treat
 * the closing operations (commit, rollback) differently from statements. */
export type TransactionOperation =
  | "batch"
  | "commit"
  | "execute"
  | "executeMultiple"
  | "rollback";

/** Wrap each interactive transaction operation with `wrap`. The closing
 * operations (commit, rollback) reach `wrap` too, so a wrapper that must
 * never block them can pass them straight through. */
export const wrapTransactionOperations = (
  transaction: Transaction,
  wrap: <T>(
    operation: TransactionOperation,
    run: () => Promise<T>,
  ) => Promise<T>,
): Transaction =>
  proxyMembers(transaction, {
    batch: (statements: InStatement[]) =>
      wrap("batch", () => transaction.batch(statements)),
    commit: () => wrap("commit", () => transaction.commit()),
    execute: (stmt: InStatement) =>
      wrap("execute", () => transaction.execute(stmt)),
    executeMultiple: (sql: string) =>
      wrap("executeMultiple", () => transaction.executeMultiple(sql)),
    rollback: () => wrap("rollback", () => transaction.rollback()),
  });
