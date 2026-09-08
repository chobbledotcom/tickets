import type { Transaction, TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, setDb, withReadSnapshot } from "#db/client.ts";
import { proxyMembers } from "#shared/proxy-members.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/**
 * The read snapshot's own contract: only SELECTs pass its gates, and the
 * transaction is closed — never committed — whatever the work did.
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
});
