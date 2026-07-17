import { getDb } from "#shared/db/client.ts";

/**
 * Reject the first transactional statement whose SQL matches `matches`, then
 * delegate every subsequent write to the real tx — so the failure lands
 * mid-flow (after the in-transaction DELETE ran, for `saveAttendeeAnswers`) and
 * the caller's rollback/compensation runs against a working client.
 *
 * Swaps the db client's `transaction` method in place (module namespaces are
 * frozen, but the client instance's method is configurable), then restores it
 * in `finally`. `saveAttendeeAnswers` runs its DELETE + string interning +
 * INSERT inside one `withTransaction`, so a poison that intercepts
 * `db.transaction` is what reaches its writes.
 */
export const withPoisonedTransactionWrite =
  (matches: (sql: string) => boolean, message: string) =>
  async (body: () => Promise<void>): Promise<void> => {
    const db = getDb();
    const realTransaction = db.transaction.bind(db);
    let poisoned = true;
    db.transaction = (async (mode: "read" | "write" = "write") => {
      const tx = await realTransaction(mode);
      const realBatch = tx.batch.bind(tx);
      const realExecute = tx.execute.bind(tx);
      tx.batch = ((statements: Array<{ sql: string }>) => {
        const matched = statements.find((statement) => matches(statement.sql));
        if (poisoned && matched) {
          poisoned = false;
          return Promise.reject(new Error(message));
        }
        return realBatch(statements as never);
      }) as typeof tx.batch;
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
      db.transaction = realTransaction;
    }
  };
