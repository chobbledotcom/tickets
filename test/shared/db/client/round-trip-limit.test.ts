import type { Transaction } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryBatch, setDb } from "#db/client.ts";
import { runWithQueryLogContext } from "#db/query-log.ts";
import {
  BUNNY_SUBREQUEST_LIMIT,
  getSubrequestUsage,
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > client round-trip limit", { db: true }, () => {
  test("counts every database operation at the client boundary", async () => {
    await runWithQueryLogContext(async () => {
      // Eleven guarded calls below are counted, including the rolledBack
      // rollback: a rollback is counted like any other subrequest (it is only
      // exempt from being *blocked*), so the running total stays accurate.
      const guardedCalls = 11;
      const executeWithArgsCalls = 1;
      const directCalls =
        BUNNY_SUBREQUEST_LIMIT - guardedCalls - executeWithArgsCalls;
      await Promise.all(
        Array.from({ length: directCalls }, () => getDb().execute("SELECT 1")),
      );
      await getDb().execute("SELECT ?", [1]);
      await queryBatch([
        { args: [], sql: "SELECT 2" },
        { args: [], sql: "SELECT 3" },
      ]);
      const transaction = await getDb().transaction("write");
      await transaction.execute("SELECT 4");
      await transaction.batch(["SELECT 5", "SELECT 6"]);
      await transaction.executeMultiple("SELECT 7;");
      await transaction.commit();
      await getDb().executeMultiple("SELECT 8;");
      await getDb().migrate(["SELECT 9"]);
      await expect(getDb().sync()).rejects.toThrow('SyncNotSupported("File")');
      const rolledBack = await getDb().transaction();
      await rolledBack.rollback();

      const blocked = async () => {
        await getDb().execute("SELECT missing_column_that_must_not_run");
      };
      await expect(blocked()).rejects.toThrow(/51 calls.*limit 50.*statement/);
    });
  });

  test("the blocked call names the operation it stopped", async () => {
    type Operation = {
      label: string;
      needsTx: boolean;
      run: (tx: Transaction) => Promise<unknown>;
    };
    const operations: Operation[] = [
      {
        label: "batch",
        needsTx: false,
        run: () => queryBatch([{ args: [], sql: "SELECT 1" }]),
      },
      {
        label: "script",
        needsTx: false,
        run: () => getDb().executeMultiple("SELECT 1;"),
      },
      {
        label: "migration batch",
        needsTx: false,
        run: () => getDb().migrate(["SELECT 1"]),
      },
      { label: "replica sync", needsTx: false, run: () => getDb().sync() },
      {
        label: "transaction begin",
        needsTx: false,
        run: () => getDb().transaction(),
      },
      {
        label: "transaction batch",
        needsTx: true,
        run: (tx) => tx.batch(["SELECT 1"]),
      },
      {
        label: "transaction commit",
        needsTx: true,
        run: (tx) => tx.commit(),
      },
      {
        label: "transaction script",
        needsTx: true,
        run: (tx) => tx.executeMultiple("SELECT 1;"),
      },
      {
        label: "transaction statement",
        needsTx: true,
        run: (tx) => tx.execute("SELECT 1"),
      },
    ];
    for (const { label, needsTx, run } of operations) {
      let tx: Transaction | undefined;
      await runWithQueryLogContext(async () => {
        if (needsTx) tx = await getDb().transaction("write");
        const fills = BUNNY_SUBREQUEST_LIMIT - (needsTx ? 1 : 0);
        await Promise.all(
          Array.from({ length: fills }, () => getDb().execute("SELECT 1")),
        );
        const blocked = async () => {
          await run(tx!);
        };
        await expect(blocked()).rejects.toThrow(`Blocked operation: ${label}`);
      });
      // The blocked finish never ran, so the transaction is still open; roll
      // it back outside the counted scope to leave the client clean.
      if (tx) await tx.rollback();
    }
  });

  test("a rollback runs within the reserved headroom, below the platform limit", async () => {
    // A rollback is mandatory cleanup: if the guard blocked it, the interactive
    // transaction would be left open and poison the shared write connection for
    // the rest of the request. The migration runner reserves a few round-trips
    // below the real limit so cleanup and bookkeeping still fit; a low allowance
    // stands in for that reserve here. The rollback runs within it — it does not
    // beat Bunny's hard limit, it stays under it.
    const reservedCap = 6;
    await runWithSubrequestBudget(() =>
      runWithQueryLogContext(async () => {
        await withSubrequestAllowance(
          { database: reservedCap, external: reservedCap, total: reservedCap },
          async () => {
            const tx = await getDb().transaction("write");
            await tx.execute("SELECT 1");
            await Promise.all(
              Array.from({ length: reservedCap - 2 }, () =>
                getDb().execute("SELECT 1"),
              ),
            );
            // A counted transaction statement is blocked at the cap (the guard
            // throws synchronously, so wrap it to observe the rejection)...
            const blockedStatement = async () => {
              await tx.execute("SELECT 1");
            };
            await expect(blockedStatement()).rejects.toThrow(
              /allowance exceeded/,
            );
            // ...but the rollback still runs, closing the transaction.
            await expect(tx.rollback()).resolves.toBeUndefined();
          },
        );
        // The whole request stayed well under Bunny's real subrequest limit, so
        // the rollback was a genuine subrequest the platform would allow.
        expect(getSubrequestUsage().database).toBeLessThan(
          BUNNY_SUBREQUEST_LIMIT,
        );
      }),
    );
  });

  test("a rollback is still blocked at the hard platform limit, as Bunny would", async () => {
    // The budget exemption only lets a rollback past our own stricter reserve,
    // never past the real round-trip limit: at the platform cap the rollback
    // would be a genuine over-limit subrequest that Bunny rejects, so the guard
    // blocks it here too rather than pretending it succeeds.
    const tx = await runWithQueryLogContext(async () => {
      const openTx = await getDb().transaction("write");
      await Promise.all(
        Array.from({ length: BUNNY_SUBREQUEST_LIMIT - 1 }, () =>
          getDb().execute("SELECT 1"),
        ),
      );
      const rollbackAtLimit = async () => {
        await openTx.rollback();
      };
      await expect(rollbackAtLimit()).rejects.toThrow(/limit 50/);
      return openTx;
    });
    // Clean up the still-open transaction outside the counted scope.
    await tx.rollback();
  });

  test("a re-set guarded client is not wrapped again (no double counting)", async () => {
    // Handing an already-guarded client back to setDb must not stack a second
    // guard on top: each statement would then count two round trips, halving
    // the real budget (the 26th statement would throw here).
    setDb(getDb());
    await runWithQueryLogContext(async () => {
      await Promise.all(
        Array.from({ length: 30 }, () => getDb().execute("SELECT 1")),
      );
    });
  });
});
