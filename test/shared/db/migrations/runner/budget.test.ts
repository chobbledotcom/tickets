import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, withTransaction } from "#db/client.ts";
import { releaseMigrationLock } from "#db/migrations/lock.ts";
import { recordMigrationBatch } from "#db/migrations/markers.ts";
import {
  applyMigrationWithRetry,
  runPendingMigrations,
  verifyMigrationWithRetry,
} from "#db/migrations/runner.ts";
import type { Migration } from "#db/migrations/types.ts";
import { runWithQueryLogContext } from "#db/query-log.ts";
import {
  getSubrequestRemaining,
  runWithSubrequestBudget,
  SubrequestBudgetError,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { takeMigrationLock } from "#test-utils/migrations.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/** The error countSubrequest raises once the request's budget is spent. */
const budgetError = (n: number): Error =>
  new SubrequestBudgetError(
    `Subrequest allowance exceeded: ${n} database + 0 external calls. Blocked database operation: batch`,
  );

/** A migration with the given work as its up() and a verify() that passes. */
const migrationOf = (id: string, up: () => Promise<unknown>): Migration => ({
  description: id,
  id,
  up: async () => {
    await up();
  },
  verify: () => Promise.resolve(),
});

describe("db > migrations > runner subrequest budget", () => {
  test("verify does not retry a spent budget — the reserve is not for retries", async () => {
    let attempts = 0;
    await expect(
      withVirtualBackoff(() =>
        verifyMigrationWithRetry({
          description: "budget during verify",
          id: "budget-verify",
          up: () => Promise.resolve(),
          verify: () => {
            attempts++;
            return Promise.reject(budgetError(46));
          },
        }),
      ),
    ).rejects.toThrow("Subrequest allowance exceeded");
    // One attempt, no backoff retries: a spent budget is not a transient lag.
    expect(attempts).toBe(1);
  });

  test("apply does not re-run up() when verify hits a spent budget", async () => {
    let upCalls = 0;
    await expect(
      withVirtualBackoff(() =>
        applyMigrationWithRetry({
          description: "budget during verify after up",
          id: "budget-apply",
          up: () => {
            upCalls++;
            return Promise.resolve();
          },
          verify: () => Promise.reject(budgetError(46)),
        }),
      ),
    ).rejects.toThrow("Subrequest allowance exceeded");
    // up() ran once; a second run has no budget left, so it is not attempted.
    expect(upCalls).toBe(1);
  });
});

describeWithEnv(
  "db > migrations > runner subrequest budget against a database",
  { db: true },
  () => {
    /** Run `work` the way a request does: one subrequest budget, one query log,
     *  with the migration lock held for it. */
    const asOneRequest = async <T>(
      work: (lockToken: string) => Promise<T>,
    ): Promise<T> => {
      const lockToken = await takeMigrationLock();
      try {
        return await runWithSubrequestBudget(() =>
          runWithQueryLogContext(() => work(lockToken)),
        );
      } finally {
        await releaseMigrationLock(lockToken);
      }
    };

    const runBatch = (pending: Migration[]): Promise<Migration[]> =>
      asOneRequest((lockToken) => runPendingMigrations(pending, lockToken));

    /** Spend the database calls this request still has, keeping `spare` back. */
    const spendAllBut = async (spare: number): Promise<void> => {
      const calls = getSubrequestRemaining().database - spare;
      for (let i = 0; i < calls; i += 1) await getDb().execute("SELECT 1");
    };

    test("inside a request, runs as many migrations as fit and returns the finished prefix", async () => {
      // Each migration spends several round-trips; the batch as a whole exceeds
      // the request's budget, so the run stops partway and leaves headroom for
      // the caller's bookkeeping.
      const spend = async (): Promise<void> => {
        for (let i = 0; i < 12; i += 1) await getDb().execute("SELECT 1");
      };
      const pending = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
        migrationOf(id, spend),
      );
      const completed = await runBatch(pending);
      // Some — but not all — ran: the budget stopped the batch.
      expect(completed.length).toBeGreaterThan(0);
      expect(completed.length).toBeLessThan(pending.length);
      // The ones that ran are the leading prefix, in order.
      expect(completed.map((migration) => migration.id)).toEqual(
        pending.slice(0, completed.length).map((migration) => migration.id),
      );
    });

    test("stops the batch when a migration cannot reserve its transaction rollback", async () => {
      // A table rebuild opens an interactive transaction, which refuses to
      // start without a spare round-trip to roll itself back with. That refusal
      // means "no budget left", not "this migration is broken", so the batch
      // must stop and keep the migration that already finished.
      const completed = await runBatch([
        migrationOf("spend", () => spendAllBut(0)),
        migrationOf("rebuild", () =>
          withTransaction((tx) => tx.execute("SELECT 1")),
        ),
      ]);
      expect(completed.map((migration) => migration.id)).toEqual(["spend"]);
    });

    test("leaves the caller room to record the batch and release the lock", async () => {
      // The held-back round-trips are the whole reason a stale database moves
      // forward: a batch that spent every call could not write its markers, so
      // the next request would replay the same work behind a held lock.
      await asOneRequest(async (lockToken) => {
        const completed = await runPendingMigrations(
          [migrationOf("spend", () => spendAllBut(0))],
          lockToken,
        );
        await recordMigrationBatch(completed, false, lockToken);
      });
    });

    test("runs one migration on the last call the request has", async () => {
      // With less left than the runner holds back, the batch still gets one
      // round-trip, so a reload attempts the next migration instead of
      // stalling on a database that can never finish updating.
      const completed = await asOneRequest(async (lockToken) => {
        await spendAllBut(1);
        return await runPendingMigrations(
          [migrationOf("one call", () => getDb().execute("SELECT 1"))],
          lockToken,
        );
      });
      expect(completed.map((migration) => migration.id)).toEqual(["one call"]);
    });
  },
);
