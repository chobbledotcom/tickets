import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";

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
