import { getDb } from "#shared/db/client.ts";

type PoisonedWrite = (body: () => Promise<void>) => Promise<void>;
type SqlStatement = { sql: string };
type RunPoisonedBatch = <Result>(
  statements: SqlStatement[],
  delegate: () => Promise<Result>,
) => Promise<Result>;

/**
 * Reject the first batch or transactional statement whose SQL matches
 * `matches`, then delegate every subsequent write to the real client.
 * Stored-ID answers use `db.batch`; plaintext answers use `db.transaction`.
 */
export const withPoisonedWrite =
  (matches: (sql: string) => boolean, message: string): PoisonedWrite =>
  async (body: () => Promise<void>): Promise<void> => {
    const db = getDb();
    const realDbBatch = db.batch.bind(db);
    const realTransaction = db.transaction.bind(db);
    let poisoned = true;
    const runPoisonedBatch: RunPoisonedBatch = (statements, delegate) => {
      const matched = statements.find((statement) => matches(statement.sql));
      if (poisoned && matched) {
        poisoned = false;
        return Promise.reject(new Error(message));
      }
      return delegate();
    };
    db.batch = ((statements: SqlStatement[], mode: "read" | "write") =>
      runPoisonedBatch(statements, () =>
        realDbBatch(statements as never, mode),
      )) as typeof db.batch;
    db.transaction = (async (mode: "read" | "write" = "write") => {
      const tx = await realTransaction(mode);
      const realBatch = tx.batch.bind(tx);
      const realExecute = tx.execute.bind(tx);
      tx.batch = ((statements: SqlStatement[]) =>
        runPoisonedBatch(statements, () =>
          realBatch(statements as never),
        )) as typeof tx.batch;
      tx.execute = ((stmt: { sql: string }) => {
        if (poisoned && matches(stmt.sql)) {
          poisoned = false;
          return Promise.reject(new Error(message));
        }
        return realExecute(stmt as never);
      }) as typeof tx.execute;
      return tx;
    }) as typeof db.transaction;
    try {
      await body();
    } finally {
      db.batch = realDbBatch;
      db.transaction = realTransaction;
    }
  };
