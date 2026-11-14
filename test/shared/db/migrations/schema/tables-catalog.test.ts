import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { catalogTables } from "#db/migrations/schema/tables-catalog.ts";
import {
  expectSchemaDeclarationExact,
  schemaTableNamed,
} from "#test-utils/db/schema-declaration.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete catalog schema exact", async () => {
  await expectSchemaDeclarationExact(
    catalogTables,
    "eb32697e7850fe4b0ec2ad6799488c5c7a863267e4e3825f642c3d8d13807c12",
  );
});

test("keeps a group's stored door and visibility defaults", () => {
  const columns = sqlText(schemaTableNamed(catalogTables, "groups").columns);
  for (const column of [
    ["show_hidden_listings", "INTEGER NOT NULL DEFAULT 1"],
    // The door default keeps one listing admitted per scan until a group
    // ticks its checkbox.
    ["scan_checks_in_all_listings", "INTEGER NOT NULL DEFAULT 0"],
  ]) {
    expect(columns).toContainEqual(column);
  }
});
