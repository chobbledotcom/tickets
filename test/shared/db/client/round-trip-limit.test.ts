import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb, queryBatch } from "#shared/db/client.ts";
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
});
