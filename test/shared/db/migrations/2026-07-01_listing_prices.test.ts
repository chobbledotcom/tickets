import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import listingPricesMigration from "#db/migrations/2026-07-01_listing_prices.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import { expectBackfillRebuildsBaseRows } from "#test/shared/db/listing-prices/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  appliedMigrationIds,
  buildMigrationContext,
} from "#test-utils/migrations.ts";

// The migration reaches exactly these two sync members (newTables and indexes
// are both non-empty); every other member would throw by default.
const context = buildMigrationContext({ applySchemaChanges, syncIndexes });

describe("db > migrations > 2026-07-01_listing_prices", () => {
  test("registers the table, its indexes, and its description under its id", () => {
    const migration = listingPricesMigration(context);
    expect(migration.description).toBe(
      "Add listing_prices and backfill base + day-count rows from listings.unit_price/day_prices.",
    );
    expect(migration.id).toBe("2026-07-01_listing_prices");
    expect(migration.requires).toEqual({
      indexes: ["idx_listing_prices_key", "idx_listing_prices_listing"],
      newTables: ["listing_prices"],
    });
  });
});

describeWithEnv(
  "db > migrations > 2026-07-01_listing_prices",
  { db: true },
  () => {
    test("up() rebuilds every listing's base row from its unit_price", async () => {
      // The migration's own id, as the stored marker rows will say it.
      expect(await appliedMigrationIds()).toContain(
        "2026-07-01_listing_prices",
      );
      await expectBackfillRebuildsBaseRows(() =>
        listingPricesMigration(context).up(),
      );
    });
  },
);
