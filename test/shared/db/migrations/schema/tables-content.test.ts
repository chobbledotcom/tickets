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
    "0992766f07fce4905048ab46b56ecd3edebc23b95f2ea2f6432ece044512ed10",
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
