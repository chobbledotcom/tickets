import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  executeBatch,
  queryBatch,
  queryBatchPrimary,
  setDb,
} from "#db/client.ts";
import { runWithPrimaryReads } from "#db/primary-reads.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";
import { withEnv } from "#test-utils/env.ts";
import { hranaTestDatabase } from "#test-utils/hrana.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

describe("primary pipeline budget and retries", () => {
  afterEach(() => setDb(null));

  for (const scoped of [false, true]) {
    test(`charges one call for ${scoped ? "scoped" : "explicit"} primary reads`, async () => {
      using _env = withEnv({ DB_URL: "libsql://pipeline.test" });
      using remote = hranaTestDatabase();
      setDb(remote.client);
      await runWithSubrequestBudget(async () => {
        const statements = [{ args: [], sql: "SELECT 1" }];
        const rows = await (scoped
          ? runWithPrimaryReads(() => queryBatch(statements))
          : queryBatchPrimary(statements));
        expect(rows).toHaveLength(1);
        expect(getSubrequestUsage()).toEqual({
          database: 1,
          external: 0,
          total: 1,
        });
      });
      expect(remote.requests).toEqual([
        ["BEGIN IMMEDIATE", "batch", "COMMIT", "close"],
      ]);
    });
  }

  for (const status of [421, 502, 503, 504]) {
    test(`retries the whole primary read after HTTP ${status}`, async () => {
      let attempts = 0;
      using remote = hranaTestDatabase({
        reply: (body) =>
          ++attempts === 1
            ? new Response(null, { status })
            : Response.json(body),
      });
      setDb(remote.client);
      await runWithSubrequestBudget(async () => {
        const results = await withVirtualBackoff(() =>
          queryBatchPrimary([{ args: [], sql: "SELECT 1" }]),
        );
        expect(results).toHaveLength(1);
        expect(getSubrequestUsage()).toEqual({
          database: 2,
          external: 0,
          total: 2,
        });
      });
      expect(remote.requests).toHaveLength(2);
    });
  }

  test("does not replay a native write after an upstream failure", async () => {
    using remote = hranaTestDatabase({
      reply: () => new Response(null, { status: 503 }),
    });
    setDb(remote.client);
    await expect(
      executeBatch([{ args: [], sql: "INSERT INTO listings VALUES (1)" }]),
    ).rejects.toMatchObject({ code: "SERVER_ERROR" });
    expect(remote.requests).toHaveLength(1);
    expect(remote.requests[0]).toEqual(["store_sql", "batch", "close"]);
  });
});
