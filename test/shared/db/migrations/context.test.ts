import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings/records.ts";
import {
  loadMigrations,
  renameEventsToListings,
} from "#shared/db/migrations/context.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import {
  columnNames,
  downgradeListingDomainToLegacyNames,
  tableNames,
} from "#test/test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { indexExists } from "#test-utils/migrations.ts";

describe("db > migrations > context", () => {
  test("builds one migration per registry entry, in run order", async () => {
    const migrations = await loadMigrations();

    expect(migrations.map((migration) => migration.id)).toEqual([
      ...MIGRATION_IDS,
    ]);
  });

  test("every built migration describes itself", async () => {
    const migrations = await loadMigrations();

    expect(
      migrations.filter((migration) => migration.description.length === 0),
    ).toEqual([]);
  });

  test("loading again reuses the first build instead of re-importing", async () => {
    const first = await loadMigrations();

    expect(await loadMigrations()).toBe(first);
  });
});

describeWithEnv(
  "db > migrations > context against a database",
  { db: true },
  () => {
    describe("renameEventsToListings", () => {
      test("renames legacy tables and columns while preserving rows", async () => {
        await createTestListing();
        await downgradeListingDomainToLegacyNames();

        await renameEventsToListings();

        const tables = await tableNames();
        expect(tables.has("listings")).toBe(true);
        expect(tables.has("events")).toBe(false);
        expect(tables.has("listing_attendees")).toBe(true);
        expect(tables.has("listing_questions")).toBe(true);

        expect(await columnNames("listings")).toContain("listing_type");
        expect(await columnNames("listing_attendees")).toContain("listing_id");
        expect(await columnNames("listing_questions")).toContain("listing_id");
        expect(await columnNames("activity_log")).toContain("listing_id");
        expect(await columnNames("built_sites")).toContain(
          "assigned_listing_id",
        );

        const listings = await getAllListings();
        expect(listings.length).toBe(1);
      });

      test("skips column renames for tables that do not exist", async () => {
        await downgradeListingDomainToLegacyNames();
        await getDb().execute("DROP TABLE built_sites");

        await renameEventsToListings();

        const tables = await tableNames();
        expect(tables.has("listings")).toBe(true);
        expect(await columnNames("built_sites")).toContain(
          "assigned_listing_id",
        );
      });

      test("is a no-op when listing tables already exist", async () => {
        const before = await getAllListings();

        await renameEventsToListings();

        const after = await getAllListings();
        expect(after.length).toBe(before.length);

        const tables = await tableNames();
        expect(tables.has("events")).toBe(false);
        expect(tables.has("listings")).toBe(true);
      });
    });

    test("the rename puts back a column the current schema declares", async () => {
      await getDb().execute("ALTER TABLE listings DROP COLUMN thank_you_url");

      await renameEventsToListings();

      expect(await columnNames("listings")).toContain("thank_you_url");
    });

    test("the rename puts back an index the current schema declares", async () => {
      await getDb().execute("DROP INDEX idx_listings_slug_index");

      await renameEventsToListings();

      expect(await indexExists("idx_listings_slug_index")).toBe(true);
    });
  },
);
