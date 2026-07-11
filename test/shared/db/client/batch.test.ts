import type { ResultSet, TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { returnsNext, stub } from "@std/testing/mock";
import { getDb, queryBatch, queryBatchPrimary } from "#shared/db/client.ts";
import {
  enableQueryLog,
  getQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** A minimal libsql ResultSet for stubbed batch calls. */
const emptyResultSet = (): ResultSet => ({
  columns: [],
  columnTypes: [],
  lastInsertRowid: undefined,
  rows: [],
  rowsAffected: 0,
  toJSON: () => ({}),
});

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

  test("queryBatchPrimary runs its statements in write mode", async () => {
    // "write" mode is the read-your-writes guarantee: Turso always serves it
    // from the primary, so a just-committed row is visible.
    expect(await captureBatchModes(queryBatchPrimary)).toEqual(["write"]);
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
