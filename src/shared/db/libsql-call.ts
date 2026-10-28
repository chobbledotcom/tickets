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
 * the closing operations (commit, rollback) differently from statements.
 * Derived from the SDK's own Transaction type: an operation is one that
 * returns a Promise. A renamed or added SDK operation then fails to compile
 * here until every wrapper handles it. */
export type TransactionOperation = {
  [K in keyof Transaction]-?: Transaction[K] extends (
    ...args: never[]
  ) => Promise<unknown>
    ? K
    : never;
}[keyof Transaction];

/** Each wrapped operation keeps the signature the SDK declares for it. */
type WrappedTransactionOperations = {
  [K in TransactionOperation]: Transaction[K];
};

/** Wrap each interactive transaction operation with `wrap`. The closing
 * operations (commit, rollback) reach `wrap` too, so a wrapper that must
 * never block them can pass them straight through. */
export const wrapTransactionOperations = (
  transaction: Transaction,
  wrap: <T>(
    operation: TransactionOperation,
    run: () => Promise<T>,
  ) => Promise<T>,
): Transaction => {
  const operations: WrappedTransactionOperations = {
    batch: (statements) => wrap("batch", () => transaction.batch(statements)),
    commit: () => wrap("commit", () => transaction.commit()),
    execute: (stmt) => wrap("execute", () => transaction.execute(stmt)),
    executeMultiple: (sql) =>
      wrap("executeMultiple", () => transaction.executeMultiple(sql)),
    rollback: () => wrap("rollback", () => transaction.rollback()),
  };
  return proxyMembers(transaction, operations);
};
