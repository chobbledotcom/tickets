import groupScanChecksInAllListings from "#db/migrations/2026-09-15_group_scan_checks_in_all_listings.ts";
import { sql } from "#db/sql.ts";
import { describeColumnMigration } from "#test-utils/migration-column-suite.ts";

// DEFAULT 0 is the door promise: an upgraded site's groups keep the
// one-listing-at-a-time rule until each group ticks its own box.
describeColumnMigration({
  column: "scan_checks_in_all_listings",
  declared: {
    description:
      "Add groups.scan_checks_in_all_listings. A group's edit form offers a " +
      'checkbox, "Check in every listing in this group when scanning any". ' +
      "The column stores that preference: 0 keeps the default door rule (each " +
      "scan checks in one member listing at a time), 1 checks in every member " +
      "listing the ticket holds. The column defaults to 0, so every stored " +
      "group keeps the one-listing-at-a-time rule until an operator ticks the " +
      "box.",
    id: "2026-09-15_group_scan_checks_in_all_listings",
  },
  defaultValue: 0,
  insertRow: sql`INSERT INTO groups (id, slug, slug_index, name) VALUES (9092, 'scan-all-group', 'scan-all-index', 'Scan All Group')`,
  migration: groupScanChecksInAllListings,
  name: "db > migrations > group scan checks in all listings",
  rowId: 9092,
  table: "groups",
  title: "adds the door setting so a stored group keeps one-listing scans",
});
