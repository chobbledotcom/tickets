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
    "719724ad74bb085aec12dcc8cd40cd72294037dbdc53abf6d44bcb259ab66c8a",
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
