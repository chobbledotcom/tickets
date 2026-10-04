import { getDb } from "#db/client.ts";

type PoisonedWrite = (body: () => Promise<void>) => Promise<void>;
type SqlStatement = { sql: string };
type RunPoisonedBatch = <Result>(
  statements: SqlStatement[],
  delegate: () => Promise<Result>,
) => Promise<Result>;

/**
 * Reject the first batch whose SQL matches `matches`, then delegate every
 * subsequent write to the real client. Every answer save the suite poisons
 * runs as one batch — a plain write (`db.batch`) or the save's one
 * transactional batch (`tx.batch` inside `withTransaction`).
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
      tx.batch = ((statements: SqlStatement[]) =>
        runPoisonedBatch(statements, () =>
          realBatch(statements as never),
        )) as typeof tx.batch;
      return tx;
    }) as typeof db.transaction;
    try {
      await body();
    } finally {
      db.batch = realDbBatch;
      db.transaction = realTransaction;
    }
  };
