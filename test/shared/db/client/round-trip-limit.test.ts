import type { Transaction } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryBatch, setDb } from "#shared/db/client.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { BUNNY_SUBREQUEST_LIMIT } from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > client round-trip limit", { db: true }, () => {
  test("counts every database operation at the client boundary", async () => {
    await runWithQueryLogContext(async () => {
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
        label: "transaction rollback",
        needsTx: true,
        run: (tx) => tx.rollback(),
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
