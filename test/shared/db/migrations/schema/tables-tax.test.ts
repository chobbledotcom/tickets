import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { taxTables } from "#db/migrations/schema/tables-tax.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete booking tax schema declaration exact", async () => {
  expect(await jsonHash(sqlText(taxTables))).toBe(
    "0e937595269e5549d0ee405a8b0a373f0005c9cd7df16e13727c5abaf5def173",
  );
});
