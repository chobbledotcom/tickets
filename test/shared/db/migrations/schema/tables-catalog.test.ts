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
    "84f40e5b22a69567dfd79b28eb30805a3a0c8edb261214f37b458f4c905b73de",
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
