import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import listingSortOrder from "#db/migrations/2026-11-21_listing_sort_order.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

describeWithEnv("db > migrations > listing sort order", { db: true }, () => {
  test("owns the listings.sort_order column", () => {
    const migration = listingSortOrder(buildMigrationContext());

    expect([migration.id, migration.requires]).toEqual([
      "2026-11-21_listing_sort_order",
      { columns: { listings: ["sort_order"] } },
    ]);
  });

  test("a new listing starts unmoved, at place 0", async () => {
    expect((await createTestListing()).sortOrder).toBe(0);
  });
});
