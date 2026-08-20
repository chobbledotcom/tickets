import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { col, defineCachedListTable } from "#db/table.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";

type CachedRow = { id: number; name: string };
type CachedInput = { name: string };

describeWithEnv("db > cached tables", { db: true }, () => {
  test("reads declared columns in order and invalidates after a write", async () => {
    await execute(
      "CREATE TABLE table_cached_rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const rows = defineCachedListTable<CachedRow, CachedInput>({
      name: "table_cached_rows",
      orderBy: "name DESC",
      primaryKey: "id",
      schema: {
        id: col.generated<number>(),
        name: col.simple<string>(),
      },
    });

    await runWithRequestCache(async () => {
      expect(await rows.getAll()).toEqual([]);
      await rows.table.insert({ name: "Alpha" });
      await rows.table.insert({ name: "Beta" });
      expect(await rows.getAll()).toEqual([
        { id: 2, name: "Beta" },
        { id: 1, name: "Alpha" },
      ]);
    });
  });
});
