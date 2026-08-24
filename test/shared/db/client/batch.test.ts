import type { TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { returnsNext, stub } from "@std/testing/mock";
import {
  getDb,
  queryAllPrimary,
  queryBatch,
  queryBatchPrimary,
  withTransaction,
} from "#db/client.ts";
import { runWithPrimaryReads } from "#db/primary-reads.ts";
import {
  enableQueryLog,
  getQueryLog,
  N_PLUS_ONE_THRESHOLD,
  runWithQueryLogContext,
} from "#db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { withEnv } from "#test-utils/env.ts";

/**
 * Batch execution: the transaction mode routes a batch to a replica ("read")
 * or pins it to the primary ("write" — the read-your-writes guarantee), and a
 * logged batch records one shared round-trip window per statement.
 */
describeWithEnv("db > client batch", { db: true }, () => {
  /** Run `batch` with a stubbed client and return the modes it was given. */
  const captureBatchModes = async (
    batch: (stmts: { sql: string; args: never[] }[]) => Promise<unknown>,
  ): Promise<string[]> => {
    const modes: string[] = [];
    const batchStub = stub(
      getDb(),
      "batch",
      (_stmts: unknown, mode?: TransactionMode) => {
        modes.push(mode ?? "");
        return Promise.resolve([emptyResultSet()]);
      },
    );
    try {
      await batch([{ args: [], sql: "SELECT 1" }]);
    } finally {
      batchStub.restore();
    }
    return modes;
  };

  test("queryBatch runs its statements in read mode", async () => {
    // "read" mode lets Turso serve the batch from a replica; anything else
    // would needlessly pin read-only batches to the primary.
    expect(await captureBatchModes(queryBatch)).toEqual(["read"]);
  });

  test("queryBatch does not count repeated statements as separate N+1 reads", async () => {
    await runWithQueryLogContext(async () => {
      const statements = Array.from(
        { length: N_PLUS_ONE_THRESHOLD + 1 },
        () => ({ args: [], sql: "SELECT 1" }),
      );
      expect(await queryBatch(statements)).toHaveLength(statements.length);
    });
  });

  test("transaction batches commit string statements together", async () => {
    await withTransaction(async (tx) => {
      await tx.batch([
        "CREATE TABLE transaction_batch_test (value TEXT NOT NULL)",
        "INSERT INTO transaction_batch_test (value) VALUES ('saved')",
      ]);
    });

    const result = await getDb().execute(
      "SELECT value FROM transaction_batch_test",
    );
    expect(result.rows.map(({ value }) => String(value))).toEqual(["saved"]);
  });

  test("transaction batches track every statement in one shared window", async () => {
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      await withTransaction(async (tx) => {
        await tx.batch([
          "CREATE TABLE tracked_transaction_batch (value TEXT NOT NULL)",
          "INSERT INTO tracked_transaction_batch (value) VALUES ('saved')",
        ]);
      });

      const entries = getQueryLog();
      expect(entries.map(({ sql }) => sql)).toEqual([
        "CREATE TABLE tracked_transaction_batch (value TEXT NOT NULL)",
        "INSERT INTO tracked_transaction_batch (value) VALUES ('saved')",
      ]);
      expect(entries[1]!.startedAtMs).toBe(entries[0]!.startedAtMs);
      expect(entries[1]!.durationMs).toBe(entries[0]!.durationMs);
    });
  });

  test("queryBatchPrimary runs its statements in write mode", async () => {
    // "write" mode is the read-your-writes guarantee: Turso always serves it
    // from the primary, so a just-committed row is visible.
    expect(await captureBatchModes(queryBatchPrimary)).toEqual(["write"]);
  });

  test("queryAllPrimary pins its one statement to the primary", async () => {
    // The plural of queryOnePrimary carries the same promise: read-your-writes,
    // so it must never be answered by a replica that lags behind the write.
    expect(
      await captureBatchModes(([statement]) =>
        queryAllPrimary(statement!.sql, statement!.args),
      ),
    ).toEqual(["write"]);
  });

  test("a :memory: database reads through in read mode even for primary reads", async () => {
    // A local in-memory database has no replica to lag, so pinning its reads
    // to "write" mode would only take a needless lock.
    using _env = withEnv({ DB_URL: ":memory:" });
    expect(
      await runWithPrimaryReads(() => captureBatchModes(queryBatch)),
    ).toEqual(["read"]);
  });

  test("batch query-log entries record the shared window's start and elapsed", async () => {
    await runWithQueryLogContext(async () => {
      enableQueryLog();
      const batchStub = stub(getDb(), "batch", () =>
        Promise.resolve([emptyResultSet()]),
      );
      // Pin the clock: start 1000, end 1007 → elapsed must be the 7ms
      // difference (a ratio regression would record ~1.007). Extra readings
      // absorb any stray fire-and-forget timing calls.
      const nowStub = stub(
        performance,
        "now",
        returnsNext([1000, 1007, 9999, 9999, 9999, 9999]),
      );
      try {
        await queryBatch([{ args: [], sql: "SELECT 1" }]);
      } finally {
        nowStub.restore();
        batchStub.restore();
      }
      const [entry] = getQueryLog();
      expect(entry!.sql).toBe("SELECT 1");
      expect(entry!.startedAtMs).toBe(1000);
      expect(entry!.durationMs).toBe(7);
    });
  });
});
