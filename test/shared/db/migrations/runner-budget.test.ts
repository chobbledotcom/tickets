import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { releaseMigrationLock } from "#shared/db/migrations/lock.ts";
import {
  applyMigrationWithRetry,
  runPendingMigrations,
  verifyMigrationWithRetry,
} from "#shared/db/migrations/runner.ts";
import type { Migration } from "#shared/db/migrations/types.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { runWithSubrequestBudget } from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { takeMigrationLock } from "#test-utils/migrations.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/** The error countSubrequest raises once the request's budget is spent. */
const budgetError = (n: number): Error =>
  new Error(
    `Subrequest allowance exceeded: ${n} database + 0 external calls. Blocked database operation: batch`,
  );

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
    test("inside a request, runs as many migrations as fit and returns the finished prefix", async () => {
      // Each migration spends several round-trips; the batch as a whole exceeds
      // the request's budget, so the run stops partway and leaves headroom for
      // the caller's bookkeeping.
      const spend = async (): Promise<void> => {
        for (let i = 0; i < 12; i += 1) await getDb().execute("SELECT 1");
      };
      const costly = (id: string): Migration => ({
        description: id,
        id,
        up: spend,
        verify: () => Promise.resolve(),
      });
      const pending = ["m1", "m2", "m3", "m4", "m5", "m6"].map(costly);
      const lockToken = await takeMigrationLock();
      try {
        const completed = await runWithSubrequestBudget(() =>
          runWithQueryLogContext(() =>
            runPendingMigrations(pending, lockToken),
          ),
        );
        // Some — but not all — ran: the budget stopped the batch.
        expect(completed.length).toBeGreaterThan(0);
        expect(completed.length).toBeLessThan(pending.length);
        // The ones that ran are the leading prefix, in order.
        expect(completed.map((migration) => migration.id)).toEqual(
          pending.slice(0, completed.length).map((migration) => migration.id),
        );
      } finally {
        await releaseMigrationLock(lockToken);
      }
    });
  },
);
