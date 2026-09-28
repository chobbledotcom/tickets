import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentTables } from "#db/migrations/schema/tables-content.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete content schema declaration exact", async () => {
  expect(await jsonHash(contentTables)).toBe(
    "7de9c14f8a08d1a5038b221cf827d9af7150fedcbe1db24abb9c0d2f99503601",
  );
});

test("declares the refund-order link on every transfer and indexes it", () => {
  const transfers = contentTables.find(([name]) => name === "transfers");
  expect(transfers).toBeDefined();
  const table = transfers![1];
  expect(table.columns).toContainEqual([
    "reverses_group",
    "TEXT NOT NULL DEFAULT ''",
  ]);
  expect(table.indexes).toContainEqual({
    columns: ["reverses_group"],
    name: "idx_transfers_reverses_group",
  });
});
