import { LibsqlError, type ResultSet, type Transaction } from "@libsql/client";
import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import {
  getDb,
  withTransaction,
  writeRowInTransaction,
} from "#shared/db/client.ts";
import {
  runWithQueryLogContext,
  setN1GuardNotifyOnly,
  TRANSACTION_ROUNDTRIP_THRESHOLD,
} from "#shared/db/query-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import { stubTransaction } from "#test-utils/db-helpers/stub-transaction.ts";

/**
 * Interactive-transaction internals: the per-transaction statement budget (the
 * "Transaction timed-out" guard), the rollback that runs on any failure, and
 * the write queue that serialises concurrent transactions even across a
 * failure. The budget tests drive a real transaction through
 * `runWithQueryLogContext` (the guard only counts inside a request scope); the
 * rollback and queue tests stub the client so the transaction's behaviour is
 * deterministic.
 */
describeWithEnv("db > client transaction", { db: true }, () => {
  // A file that boots the app switches the guard to notify-only for the rest
  // of the shared isolate; the budget tests need the default throw mode.
  beforeEach(() => setN1GuardNotifyOnly(null));

  /** Run a transaction that issues `executes` single statements, then one
   *  two-statement batch. Each statement carries a distinct SQL string so the
   *  N+1 read guard (per-SQL, threshold 25) stays quiet and only the
   *  transaction's own statement budget is exercised. */
  const runChattyTransaction = (executes: number): Promise<unknown> =>
    runWithQueryLogContext(() =>
      withTransaction(async (tx) => {
        for (let i = 0; i < executes; i++) {
          await tx.execute(`SELECT ${i}`);
        }
        await tx.batch(["SELECT 100", "SELECT 101"]);
      }),
    );

  test("a transaction may use the full statement budget", async () => {
    // Off-by-one in the running count would fire the guard one statement
    // early, failing a legitimate transaction at exactly the threshold.
    await runChattyTransaction(TRANSACTION_ROUNDTRIP_THRESHOLD - 1);
  });

  test("the single-statement over the budget throws", async () => {
    await expect(
      runWithQueryLogContext(() =>
        withTransaction(async (tx) => {
          for (let i = 0; i <= TRANSACTION_ROUNDTRIP_THRESHOLD; i++) {
            await tx.execute(`SELECT ${i}`);
          }
        }),
      ),
    ).rejects.toThrow("Interactive transaction too chatty");
  });

  test("the batch over the budget throws, naming its joined statements", async () => {
    await expect(
      runChattyTransaction(TRANSACTION_ROUNDTRIP_THRESHOLD),
    ).rejects.toThrow("Last statement: SELECT 100; SELECT 101");
  });

  test("a failure rolls the transaction back and rethrows the original error", async () => {
    const rollback = spy(() => Promise.resolve());
    using _txStub = stubTransaction({
      commit: () => Promise.resolve(),
      execute: () => Promise.resolve(emptyResultSet()),
      rollback,
    });
    await expect(
      withTransaction(async (tx) => {
        await tx.execute("INSERT INTO t (x) VALUES (1)");
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(rollback.calls.length).toBe(1);
  });

  test("a rollback failure after a commit failure still surfaces the commit error", async () => {
    using _txStub = stubTransaction({
      commit: () => Promise.reject(new Error("commit failed")),
      rollback: () => Promise.reject(new Error("rollback failed too")),
    });
    await expect(withTransaction(() => Promise.resolve())).rejects.toThrow(
      "commit failed",
    );
  });

  test("a failed transaction does not poison the queue behind it", async () => {
    await expect(
      withTransaction(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    // The next transaction waits on the failed one's tail; it must still run
    // its own work rather than inherit the rejection.
    const result = await withTransaction(() => Promise.resolve("ran"));
    expect(result).toBe("ran");
  });

  test("a committed transaction does not roll back", async () => {
    const rollback = spy(() => Promise.resolve());
    using _txStub = stubTransaction({
      batch: () => Promise.resolve([] as ResultSet[]),
      commit: () => Promise.resolve(),
      rollback,
    });
    await withTransaction(async (tx) => {
      await tx.batch(["SELECT 1"]);
    });
    expect(rollback.calls.length).toBe(0);
  });

  test("a fleeting upstream 504 at commit is not retried", async () => {
    // A 5xx at begin or commit may have landed server-side, so a transaction
    // never retries upstream gateway errors — the failure surfaces as itself
    // rather than replaying the writes.
    using txStub = stubTransaction({
      commit: () =>
        Promise.reject(
          new LibsqlError("Server returned HTTP status 504", "SERVER_ERROR"),
        ),
      execute: () => Promise.resolve(emptyResultSet()),
      rollback: () => Promise.resolve(),
    });
    await expect(
      withTransaction(async (tx) => {
        await tx.execute("INSERT INTO t (x) VALUES (1)");
      }),
    ).rejects.toThrow("SERVER_ERROR: Server returned HTTP status 504");
    // One begin, no retry — a replayed transaction would double-apply the write.
    expect(txStub.calls.length).toBe(1);
  });

  test("a second transaction waits for the first to settle before it begins", async () => {
    const events: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    using _txStub = stub(getDb(), "transaction", () => {
      events.push("begin");
      return Promise.resolve({
        commit: () => Promise.resolve(),
        rollback: () => Promise.resolve(),
      } as unknown as Transaction);
    });
    const first = withTransaction(async () => {
      events.push("first work");
      await gate;
      events.push("first settled");
    });
    const second = withTransaction(async () => {
      events.push("second work");
    });
    // Flush microtasks: with the queue intact the second transaction is
    // parked on the first's tail and cannot have begun; without the wait it
    // begins immediately, overlapping the open first transaction.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(events).toEqual(["begin", "first work"]);
    openGate();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "begin",
      "first work",
      "first settled",
      "begin",
      "second work",
    ]);
  });

  test("writeRowInTransaction honours an explicit existing id of 0", async () => {
    // `existingId ?? lastInsertRowid` must be nullish- (not falsy-) coalescing:
    // only a null existingId means "this was an INSERT, use its new rowid". An
    // explicit 0 must reach persist as 0, not be swapped for lastInsertRowid.
    const persistedIds: number[] = [];
    using _txStub = stubTransaction({
      commit: () => Promise.resolve(),
      execute: () =>
        Promise.resolve({ lastInsertRowid: 42n } as unknown as ResultSet),
      rollback: () => Promise.resolve(),
    });
    const id = await writeRowInTransaction(
      "UPDATE rows SET x = 1",
      0,
      (_tx, rowId) => {
        persistedIds.push(rowId);
        return Promise.resolve();
      },
    );
    expect(id).toBe(0);
    expect(persistedIds).toEqual([0]);
  });

  /** Run an INSERT through writeRowInTransaction against a driver whose
   *  RETURNING gives back `rows`, recording the ids persist saw. */
  const insertReturningRows = async (
    rows: unknown[],
  ): Promise<{ persistedIds: number[]; error: unknown }> => {
    const persistedIds: number[] = [];
    using _txStub = stubTransaction({
      commit: () => Promise.resolve(),
      execute: () => Promise.resolve({ rows } as unknown as ResultSet),
      rollback: () => Promise.resolve(),
    });
    try {
      await writeRowInTransaction(
        "INSERT INTO rows (x) VALUES (1)",
        null,
        (_tx, rowId) => {
          persistedIds.push(rowId);
          return Promise.resolve();
        },
      );
      return { error: null, persistedIds };
    } catch (thrown) {
      return { error: thrown, persistedIds };
    }
  };

  // The join writes are keyed on the id, so an INSERT that hands back no row —
  // or a row without a usable key — has to fail before persist runs, leaving the
  // whole write to roll back rather than writing rows against a bad id.
  test("writeRowInTransaction rejects an INSERT that returns no row", async () => {
    const { error, persistedIds } = await insertReturningRows([]);

    expect(String(error)).toContain(
      "did not return the id of the row it wrote",
    );
    expect(persistedIds).toEqual([]);
  });

  test("writeRowInTransaction rejects a returned row whose id is 0", async () => {
    const { error, persistedIds } = await insertReturningRows([{ id: 0 }]);

    expect(String(error)).toContain(
      "did not return the id of the row it wrote",
    );
    expect(persistedIds).toEqual([]);
  });

  test("writeRowInTransaction persists against the id the INSERT returned", async () => {
    const { error, persistedIds } = await insertReturningRows([{ id: 7 }]);

    expect(error).toBeNull();
    expect(persistedIds).toEqual([7]);
  });
});
