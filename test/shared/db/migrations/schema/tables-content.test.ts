import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentTables } from "#db/migrations/schema/tables-content.ts";
import {
  expectSchemaDeclarationExact,
  schemaTableNamed,
} from "#test-utils/db/schema-declaration.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete content schema declaration exact", async () => {
  await expectSchemaDeclarationExact(
    contentTables,
    "b1b41c33da47029827fe9a77ca567017be5267bc195409ae4d5364a6798f3dd4",
  );
});

test("declares the refund-order link on every transfer and indexes it", () => {
  const transfers = schemaTableNamed(contentTables, "transfers");
  expect(sqlText(transfers.columns)).toContainEqual([
    "reverses_group",
    "TEXT NOT NULL DEFAULT ''",
  ]);
  expect(sqlText(transfers.indexes)).toContainEqual({
    columns: ["reverses_group"],
    name: "idx_transfers_reverses_group",
  });
});
