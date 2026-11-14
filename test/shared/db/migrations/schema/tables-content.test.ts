import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentTables } from "#db/migrations/schema/tables-content.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete content schema declaration exact", async () => {
  expect(await jsonHash(sqlText(contentTables))).toBe(
    "0992766f07fce4905048ab46b56ecd3edebc23b95f2ea2f6432ece044512ed10",
  );
});

test("declares the refund-order link on every transfer and indexes it", () => {
  const transfers = contentTables.find(([name]) => name === "transfers");
  if (!transfers) throw new Error("transfers schema is missing");
  expect(sqlText(transfers[1].columns)).toContainEqual([
    "reverses_group",
    "TEXT NOT NULL DEFAULT ''",
  ]);
  expect(sqlText(transfers[1].indexes)).toContainEqual({
    columns: ["reverses_group"],
    name: "idx_transfers_reverses_group",
  });
});
