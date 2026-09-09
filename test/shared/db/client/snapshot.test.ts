import {
  type Client,
  LibsqlError,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb, setDb, withReadSnapshot } from "#db/client.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

/**
 * The read snapshot's own contract: only SELECTs pass its gates, and the
 * transaction is closed — never committed — whatever the work did. A snapshot
 * attempt that dies on a fleeting upstream failure replays whole, on a fresh
 * transaction, because every statement inside is a SELECT.
 */
describeWithEnv("db > client read snapshot", { db: true }, () => {
  test("refuses a write smuggled into the snapshot", async () => {
    await expect(
      withReadSnapshot((snapshot) => snapshot.execute("DELETE FROM listings")),
    ).rejects.toThrow("accept only SELECT statements");
  });

  test("refuses a write smuggled into a snapshot batch", async () => {
    await expect(
      withReadSnapshot((snapshot) =>
        snapshot.batch([
          { args: [], sql: "SELECT 1" },
          { args: [], sql: "UPDATE settings SET value = 'x'" },
        ]),
      ),
    ).rejects.toThrow("accept only SELECT statements");
  });

  test("closes the transaction when the work throws", async () => {
    const guarded = getDb();
    let opened: Transaction | undefined;
    const capturing = proxyMembers(guarded, {
      transaction: async (mode?: TransactionMode): Promise<Transaction> => {
        opened = await guarded.transaction(mode);
        return opened;
      },
    });
    setDb(capturing);
    try {
      await expect(
        withReadSnapshot(() => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");
      // The snapshot's transaction is closed, not committed: no further
      // statement can run on it.
      await expect(opened!.execute("SELECT 1")).rejects.toThrow();
    } finally {
      setDb(guarded);
    }
  });

  test("a fleeting upstream failure replays the whole snapshot attempt", async () => {
    using time = new FakeTime();
    const upstreamError = new LibsqlError(
      "Server returned HTTP status 421",
      "SERVER_ERROR",
    );
    let transactions = 0;
    const failingFirst = {
      transaction: (_mode?: TransactionMode) => {
        transactions += 1;
        const attempt = transactions;
        const failOr = <T>(result: Promise<T>): Promise<T> =>
          attempt === 1 ? Promise.reject(upstreamError) : result;
        return Promise.resolve({
          batch: (statements: unknown[]) =>
            failOr(Promise.resolve(statements.map(() => emptyResultSet()))),
          close: () => {},
          execute: () => failOr(Promise.resolve(emptyResultSet())),
        });
      },
    } as unknown as Client;
    setDb(failingFirst);
    try {
      let runs = 0;
      const promise = withReadSnapshot(async (snapshot) => {
        runs += 1;
        return snapshot.batch([{ args: [], sql: "SELECT 1" }]);
      });
      await time.tickAsync(50);
      const seen = await promise;
      expect(seen).toHaveLength(1);
      // The whole attempt replayed: a fresh transaction, and the work ran again.
      expect(transactions).toBe(2);
      expect(runs).toBe(2);
    } finally {
      setDb(null);
    }
  });
});
