import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import groupScanChecksInAllListings from "#db/migrations/2026-09-15_group_scan_checks_in_all_listings.ts";
import {
  applySchemaChanges,
  getExistingColumns,
  syncIndexes,
} from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const migration = () => groupScanChecksInAllListings(context);

describeWithEnv(
  "db > migrations > group scan checks in all listings",
  { db: true },
  () => {
    test("adds the door setting so a stored group keeps one-listing scans", async () => {
      await getDb().execute(
        "INSERT INTO groups (id, slug, slug_index, name) VALUES (9092, 'scan-all-group', 'scan-all-index', 'Scan All Group')",
      );
      await getDb().execute(
        "ALTER TABLE groups DROP COLUMN scan_checks_in_all_listings",
      );

      await migration().up();

      expect(
        (await getExistingColumns("groups")).has("scan_checks_in_all_listings"),
      ).toBe(true);
      const result = await getDb().execute(
        "SELECT scan_checks_in_all_listings FROM groups WHERE id = 9092",
      );
      // DEFAULT 0 is the door promise: an upgraded site's groups keep the
      // one-listing-at-a-time rule until each group ticks its own box.
      expect(Number(result.rows[0]?.scan_checks_in_all_listings)).toBe(0);
    });

    test("declares every object it owns", () => {
      // Anything left off this list is never verified, so a partial upgrade
      // would record itself as applied.
      expect(migration().id).toBe(
        "2026-09-15_group_scan_checks_in_all_listings",
      );
      expect(migration().requires).toEqual({
        columns: { groups: ["scan_checks_in_all_listings"] },
      });
      expect(migration().description).toBe(
        "Add groups.scan_checks_in_all_listings. A group's edit form offers a " +
          'checkbox, "Check in every listing in this group when scanning any". ' +
          "The column stores that preference: 0 keeps the default door rule (each " +
          "scan checks in one member listing at a time), 1 checks in every member " +
          "listing the ticket holds. The column defaults to 0, so every stored " +
          "group keeps the one-listing-at-a-time rule until an operator ticks the " +
          "box.",
      );
    });
  },
);
