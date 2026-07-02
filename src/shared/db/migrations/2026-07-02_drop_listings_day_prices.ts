import { schemaMigration } from "./define.ts";

/**
 * Retire the `listings.day_prices` JSON column: per-day-count prices now live in
 * the `day_count` dimension of `listing_prices` (`("day_count", "<n>")`). The
 * `day_count` rows were first backfilled by the `2026-07-01_listing_prices`
 * migration and kept in step by every listing write since, but this migration
 * rebuilds them authoritatively from the column one last time (via `json_each`)
 * before dropping it — so no site can lose a day price to a missed sync. Only
 * `unit_price` stays a column (the hot-path base price, mirrored by the `base`
 * row); `day_prices` is projected back on read from the `day_count` rows.
 *
 * `up()`:
 *  1. Rebuild every listing's `day_count` rows from the JSON column (`DELETE` +
 *     `INSERT … json_each`), so the rows are exactly the column's contents.
 *  2. `recreateTable("listings")` rebuilds the table from the (now
 *     `day_prices`-free) SCHEMA, preserving every other column.
 *
 * Gated on the legacy column so a re-run after a verify retry or crash is a
 * no-op. The dropped column is covered by the schema-hash guard (no additive
 * object to verify), matching the other column-drop migrations.
 */
export default schemaMigration(
  "2026-07-02_drop_listings_day_prices",
  "Migrate listings.day_prices into the listing_prices 'day_count' dimension and drop the column.",
  {},
  async ({ getDb, recreateTable }) => {
    const info = await getDb().execute("PRAGMA table_info(listings)");
    const hasLegacyColumn = info.rows.some((row) => row.name === "day_prices");
    if (!hasLegacyColumn) return;
    // Authoritative rebuild of the day_count rows from the column: replace the
    // whole dimension, then repopulate one row per (listing, day count) entry.
    await getDb().execute(
      "DELETE FROM listing_prices WHERE price_type = 'day_count'",
    );
    await getDb().execute(
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) " +
        "SELECT listing.id, 'day_count', dayPrice.key, dayPrice.value " +
        "FROM listings AS listing, json_each(listing.day_prices) AS dayPrice",
    );
    await recreateTable("listings");
  },
);
