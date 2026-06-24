import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  initDb,
  renameEventsToListings,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import {
  columnNames,
  downgradeListingDomainToLegacyNames,
  markMigrationsForRerun,
  rerunMigrationsAndExpectListingDomainRestored,
  schemaHashMarker,
  seedListingDomainRows,
  tableExists,
  tableNames,
  tableRowCount,
} from "../migration-test-helpers.ts";

describeWithEnv(
  "db > migrations > 2026-06-14_rename_events_to_listings",
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

    describe("pre-rename migration ordering", () => {
      test("a pre-rename database migrates successfully and preserves rows in the renamed tables", async () => {
        const listingId = await seedListingDomainRows();
        await downgradeListingDomainToLegacyNames();

        expect(await tableExists("events")).toBe(true);
        expect(await tableExists("event_attendees")).toBe(true);
        expect(await tableExists("event_questions")).toBe(true);
        expect(await tableExists("listings")).toBe(false);
        expect(await tableRowCount("events")).toBe(1);
        expect(await tableRowCount("event_attendees")).toBe(1);
        expect(await tableRowCount("event_questions")).toBe(1);

        await rerunMigrationsAndExpectListingDomainRestored(listingId);

        expect(await schemaHashMarker()).toBe(SCHEMA_HASH);
        await initDb();
        expect(await tableRowCount("listings")).toBe(1);
      });

      test("a failed intermediate state self-heals by dropping empty target tables and renaming legacy ones", async () => {
        const listingId = await seedListingDomainRows();
        await downgradeListingDomainToLegacyNames();

        await getDb().batch(
          [
            "CREATE TABLE listings (id INTEGER PRIMARY KEY, slug_index TEXT)",
            "CREATE TABLE listing_attendees (id INTEGER PRIMARY KEY, listing_id INTEGER, attendee_id INTEGER)",
            "CREATE TABLE listing_questions (id INTEGER PRIMARY KEY, listing_id INTEGER, question_id INTEGER)",
            "ALTER TABLE activity_log ADD COLUMN listing_id INTEGER",
            "ALTER TABLE built_sites ADD COLUMN assigned_listing_id INTEGER DEFAULT NULL",
          ],
          "write",
        );

        expect(await tableRowCount("events")).toBe(1);
        expect(await tableRowCount("event_attendees")).toBe(1);
        expect(await tableRowCount("event_questions")).toBe(1);
        expect(await tableRowCount("listings")).toBe(0);
        expect(await tableRowCount("listing_attendees")).toBe(0);
        expect(await tableRowCount("listing_questions")).toBe(0);

        await rerunMigrationsAndExpectListingDomainRestored(listingId);

        expect(await columnNames("activity_log")).not.toContain("event_id");
        expect(await columnNames("built_sites")).not.toContain(
          "assigned_event_id",
        );
        expect(await schemaHashMarker()).toBe(SCHEMA_HASH);
      });

      test("a database with duplicate legacy and target column values self-heals by dropping the legacy column", async () => {
        const listing = await createTestListing();
        await getDb().execute(
          "INSERT INTO activity_log (created, listing_id, message) VALUES ('2024-01-01T00:00:00Z', ?, 'duplicate listing activity')",
          [listing.id],
        );
        await getDb().execute(
          "ALTER TABLE activity_log ADD COLUMN event_id INTEGER",
        );
        await getDb().execute(
          "UPDATE activity_log SET event_id = listing_id WHERE listing_id IS NOT NULL",
        );

        await markMigrationsForRerun();
        await initDb();

        expect(await columnNames("activity_log")).toContain("listing_id");
        expect(await columnNames("activity_log")).not.toContain("event_id");
        const row = await getDb().execute(
          "SELECT listing_id FROM activity_log WHERE message = 'duplicate listing activity'",
        );
        expect(row.rows[0]?.listing_id).toBe(listing.id);
        expect(await schemaHashMarker()).toBe(SCHEMA_HASH);
      });

      test("a duplicate column state with a stale legacy foreign key self-heals by rebuilding the table", async () => {
        const listing = await createTestListing();
        await getDb().execute("DROP TABLE activity_log");
        await getDb().execute(
          `CREATE TABLE activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created TEXT NOT NULL,
            event_id INTEGER,
            listing_id INTEGER,
            message TEXT NOT NULL,
            FOREIGN KEY (event_id) REFERENCES listings(id) ON DELETE SET NULL
          )`,
        );
        await getDb().execute(
          "INSERT INTO activity_log (created, event_id, listing_id, message) VALUES ('2024-01-01T00:00:00Z', ?, ?, 'stale fk listing activity')",
          [listing.id, listing.id],
        );

        await markMigrationsForRerun();
        await initDb();

        const cols = await columnNames("activity_log");
        expect(cols).toContain("listing_id");
        expect(cols).toContain("attendee_id");
        expect(cols).not.toContain("event_id");
        const row = await getDb().execute(
          "SELECT listing_id FROM activity_log WHERE message = 'stale fk listing activity'",
        );
        expect(row.rows[0]?.listing_id).toBe(listing.id);
        const foreignKeys = await getDb().execute(
          "PRAGMA foreign_key_list(activity_log)",
        );
        expect(
          foreignKeys.rows.some(
            (foreignKey) => String(foreignKey.from) === "event_id",
          ),
        ).toBe(false);
        expect(await schemaHashMarker()).toBe(SCHEMA_HASH);
      });

      test("a database with both legacy and target tables containing rows fails with a clear manual-repair error", async () => {
        await seedListingDomainRows();
        await getDb().batch(
          [
            "CREATE TABLE events (id INTEGER PRIMARY KEY, name TEXT)",
            "INSERT INTO events (name) VALUES ('legacy-event-row')",
          ],
          "write",
        );

        expect(await tableRowCount("listings")).toBe(1);
        expect(await tableRowCount("events")).toBe(1);

        await markMigrationsForRerun();

        await expect(initDb()).rejects.toThrow(
          'Cannot migrate "events" -> "listings"',
        );
        await expect(initDb()).rejects.toThrow("Manual migration is required");

        expect(await tableExists("events")).toBe(true);
        expect(await tableRowCount("events")).toBe(1);
        expect(await tableRowCount("listings")).toBe(1);
        const lockResult = await getDb().execute(
          "SELECT 1 FROM settings WHERE key = 'migration_lock'",
        );
        expect(lockResult.rows.length).toBe(0);
      });

      test("a database with both legacy and target columns containing data fails with a clear manual-repair error", async () => {
        const listing = await createTestListing();
        const listingId = listing.id;
        await getDb().execute(
          "INSERT INTO activity_log (created, listing_id, message) VALUES ('2024-01-01T00:00:00Z', ?, 'target listing activity')",
          [listingId],
        );
        await getDb().execute(
          "ALTER TABLE activity_log ADD COLUMN event_id INTEGER",
        );
        await getDb().execute(
          "UPDATE activity_log SET event_id = 999 WHERE message = 'target listing activity'",
        );

        await markMigrationsForRerun();

        await expect(initDb()).rejects.toThrow(
          'Cannot migrate "activity_log.event_id" -> "activity_log.listing_id"',
        );
        await expect(initDb()).rejects.toThrow("Manual migration is required");

        const row = await getDb().execute(
          "SELECT event_id, listing_id FROM activity_log WHERE message = 'target listing activity'",
        );
        expect(row.rows[0]?.event_id).toBe(999);
        expect(row.rows[0]?.listing_id).toBe(listingId);
      });
    });
  },
);
