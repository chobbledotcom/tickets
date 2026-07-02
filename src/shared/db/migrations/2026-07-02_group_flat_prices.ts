import { schemaMigration } from "./define.ts";

/**
 * Migrate the flat package price override from `group_listings.package_price`
 * into the `group` dimension of `listing_prices` (`("group", "<groupId>")`), then
 * drop the column. This completes the switch of package pricing onto
 * `listing_prices`: the per-day `group_day` rows already lived there; the flat
 * override now joins them, so `listing_prices` is the single source of truth for
 * package pricing and `group_listings` keeps only membership + quantity.
 *
 * `up()`:
 *  1. Backfill one `group` price row per membership row with a non-null
 *     `package_price` (0 and positive alike; NULL = no override → no row).
 *  2. `recreateTable("group_listings")` rebuilds the table from the (now
 *     `package_price`-free) SCHEMA, preserving membership + quantity.
 *
 * Gated on the legacy column so a re-run after a verify retry or crash is a
 * no-op, and `INSERT OR IGNORE` tolerates rows a prior partial run wrote. The
 * dropped column is covered by the schema-hash guard (no additive object to
 * verify), matching the other column-drop migrations.
 */
export default schemaMigration(
  "2026-07-02_group_flat_prices",
  "Migrate group_listings.package_price into the listing_prices 'group' dimension and drop the column.",
  {},
  async ({ getDb, recreateTable }) => {
    const info = await getDb().execute("PRAGMA table_info(group_listings)");
    const hasLegacyColumn = info.rows.some(
      (row) => row.name === "package_price",
    );
    if (!hasLegacyColumn) return;
    await getDb().execute(
      "INSERT OR IGNORE INTO listing_prices (listing_id, price_type, price_id, unit_price) " +
        "SELECT listing_id, 'group', CAST(group_id AS TEXT), package_price " +
        "FROM group_listings WHERE package_price IS NOT NULL",
    );
    await recreateTable("group_listings");
  },
);
