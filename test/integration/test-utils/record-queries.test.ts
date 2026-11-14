/** Every client call shape must record and forward correctly — a mishandled
 *  shape would silently corrupt the exact-query assertions built on this. */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";

describeWithEnv("recordQueries", { db: true }, () => {
  test("records every client call shape and forwards to the real client", async () => {
    const real = getDb();
    const seen: string[] = [];
    const restore = recordQueries(seen);
    try {
      const withArgs = await getDb().execute(sql`SELECT ${1} AS n`);
      expect(Number(withArgs.rows[0]?.n)).toBe(1);

      const objectForm = await getDb().execute(sql`SELECT ${2} AS n`);
      expect(Number(objectForm.rows[0]?.n)).toBe(2);

      const bareString = await getDb().execute(sql`SELECT 3 AS n`);
      expect(Number(bareString.rows[0]?.n)).toBe(3);

      await getDb().batch([sql`SELECT ${4} AS n`], "read");

      // Non-query members forward to the wrapped client: plain values as-is,
      // methods bound to the real client so they still work when called.
      expect(getDb().protocol).toBe(real.protocol);

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
});
