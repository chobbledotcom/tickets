import { backfillDropColumnMigration } from "./define.ts";

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
 * Gated on the legacy column so a re-run (or a fresh DB whose SCHEMA never had
 * the column) is a no-op — see {@link backfillDropColumnMigration}.
 */
export default backfillDropColumnMigration(
  "2026-07-02_drop_listings_day_prices",
  "listings",
  "day_prices",
  "Migrate listings.day_prices into the listing_prices 'day_count' dimension and drop the column.",
  async (getDb) => {
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
  },
);
