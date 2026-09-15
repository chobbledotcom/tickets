import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { catalogTables } from "#db/migrations/schema/tables-catalog.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete catalog schema exact", async () => {
  expect(await jsonHash(catalogTables)).toBe(
    "4ed2d6953b217469e5abf9c31fb7e02519215365964951bac048cba207957afd",
  );
});

test("defaults a group's hidden-listings flag to showing them", () => {
  const groups = catalogTables.find(([name]) => name === "groups");
  if (!groups) throw new Error("groups schema is missing");

  expect(groups[1].columns).toContainEqual([
    "show_hidden_listings",
    "INTEGER NOT NULL DEFAULT 1",
  ]);
});
