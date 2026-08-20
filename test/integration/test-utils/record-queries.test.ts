/** Every client call shape must record and forward correctly — a mishandled
 *  shape would silently corrupt the exact-query assertions built on this. */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries, statementSql } from "#test-utils/record-queries.ts";

describeWithEnv("recordQueries", { db: true }, () => {
  test("records every client call shape and forwards to the real client", async () => {
    const real = getDb();
    const seen: string[] = [];
    const restore = recordQueries(seen);
    try {
      const withArgs = await getDb().execute("SELECT ? AS n", [1]);
      expect(Number(withArgs.rows[0]?.n)).toBe(1);

      const objectForm = await getDb().execute({
        args: [2],
        sql: "SELECT ? AS n",
      });
      expect(Number(objectForm.rows[0]?.n)).toBe(2);

      const bareString = await getDb().execute("SELECT 3 AS n");
      expect(Number(bareString.rows[0]?.n)).toBe(3);

      await getDb().batch([["SELECT ? AS n", [4]]], "read");

      // Non-query members forward to the wrapped client: plain values as-is,
      // methods bound to the real client so they still work when called.
      expect(getDb().protocol).toBe(real.protocol);
      await getDb().executeMultiple("SELECT 5 AS n");

      expect(seen).toEqual([
        "SELECT ? AS n",
        "SELECT ? AS n",
        "SELECT 3 AS n",
        "batch[SELECT ? AS n]",
      ]);
    } finally {
      restore();
    }
    expect(getDb()).toBe(real);
  });

  test("reads SQL from every statement form", () => {
    expect(statementSql("SELECT 1")).toBe("SELECT 1");
    expect(statementSql({ args: [2], sql: "SELECT ?" })).toBe("SELECT ?");
    expect(statementSql(["SELECT ?", [3]])).toBe("SELECT ?");
  });
});
