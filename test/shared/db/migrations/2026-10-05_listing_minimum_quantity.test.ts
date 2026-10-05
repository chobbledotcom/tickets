import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import listingMinimumQuantity from "#db/migrations/2026-10-05_listing_minimum_quantity.ts";
import { coreTables } from "#db/migrations/schema/tables-core.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => listingMinimumQuantity(buildMigrationContext());

// The exemplar pair (minimum_quantity beside max_quantity) inside the
// listings table declaration.
const listingsColumns = coreTables
  .filter((entry) => entry[0] === "listings")
  .flatMap((entry) => (entry[1] as { columns: [string, string][] }).columns);
const minimumColumn = listingsColumns.find(
  ([name]) => name === "minimum_quantity",
);

describeWithEnv(
  "db > migrations > listing minimum quantity",
  { db: true },
  () => {
    test("declares the column it owns", () => {
      // Anything left off this list is never verified by the chain, so a
      // partial upgrade would record itself as applied.
      expect(migration().id).toBe("2026-10-05_listing_minimum_quantity");
      expect(migration().requires).toEqual({
        columns: { listings: ["minimum_quantity"] },
      });
    });

    test("the schema stores a NOT NULL default of 1", () => {
      // STE(minimum_quantity): the default is the identity element — old rows
      // keep today's choice set, so the column must never read NULL.
      expect(minimumColumn).toEqual([
        "minimum_quantity",
        "INTEGER NOT NULL DEFAULT 1",
      ]);
    });
  },
);
