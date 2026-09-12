import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentTables } from "#db/migrations/schema/tables-content.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete content schema declaration exact", async () => {
  expect(await jsonHash(contentTables)).toBe(
    "308555508f8adb207773ba44d036a814c519e0c2c05b6191898ab83d8654fd12",
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
