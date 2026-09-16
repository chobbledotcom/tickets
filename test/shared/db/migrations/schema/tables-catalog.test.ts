import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { catalogTables } from "#db/migrations/schema/tables-catalog.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete catalog schema exact", async () => {
  expect(await jsonHash(catalogTables)).toBe(
    "eb32697e7850fe4b0ec2ad6799488c5c7a863267e4e3825f642c3d8d13807c12",
  );
});

test("keeps a group's stored door and visibility defaults", () => {
  const groups = catalogTables.find(([name]) => name === "groups");
  if (!groups) throw new Error("groups schema is missing");

  expect(groups[1].columns).toContainEqual([
    "show_hidden_listings",
    "INTEGER NOT NULL DEFAULT 1",
  ]);
  // The door default keeps one listing admitted per scan until a group ticks
  // its checkbox.
  expect(groups[1].columns).toContainEqual([
    "scan_checks_in_all_listings",
    "INTEGER NOT NULL DEFAULT 0",
  ]);
});
