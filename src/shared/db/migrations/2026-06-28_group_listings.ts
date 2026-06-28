import { schemaMigration } from "./define.ts";

/**
 * Replace the single `listings.group_id` foreign key with a `group_listings`
 * join table so a listing can belong to several groups at once (and a group can
 * act as a "package" of listings with per-listing price overrides).
 *
 * `up()`:
 *  1. `applySchemaChanges` creates `group_listings` (group_id, listing_id,
 *     package_price) and adds `groups.is_package`.
 *  2. Backfill one membership row per currently-grouped listing from the legacy
 *     `listings.group_id` column.
 *  3. `recreateTable("listings")` rebuilds listings from the (now group_id-free)
 *     SCHEMA, dropping the column while preserving every other column and the
 *     aggregate triggers (which fire on listing_attendees, not listings).
 *
 * The dropped column is covered by the schema-hash guard rather than the
 * requirement verifier (which has no "absent column" concept); verify() asserts
 * the new table, its index, and the new groups column landed.
 */
export default schemaMigration(
  "2026-06-28_group_listings",
  "Add a group_listings join table (with package_price) and groups.is_package, migrate listings.group_id into it, and drop the column.",
  {
    columns: { groups: ["is_package"] },
    indexes: ["idx_group_listings_pair", "idx_group_listings_listing"],
    newTables: ["group_listings"],
  },
  async ({ getDb, recreateTable }) => {
    await getDb().execute(
      "INSERT INTO group_listings (group_id, listing_id) " +
        "SELECT group_id, id FROM listings WHERE group_id > 0",
    );
    await recreateTable("listings");
  },
);
