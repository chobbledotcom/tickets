import { backfillListingPrices } from "#shared/db/listing-prices.ts";
import { schemaMigration } from "./define.ts";

/**
 * Introduce `listing_prices` — generalised per-listing pricing keyed by a
 * dimension (`price_type`/`price_id`), see the table's schema comment. This
 * migration creates the table and backfills the two dimensions that exist today
 * from every listing's `unit_price` (a `("base","")` row) and `day_prices`
 * (`("day_count","<n>")` rows). Those columns stay as read mirrors; the reserved
 * `group`/`start_day` dimensions get no rows here. The backfill deletes and
 * reinserts each listing's managed rows, so it is idempotent on re-run.
 */
export default schemaMigration(
  "2026-07-01_listing_prices",
  "Add listing_prices and backfill base + day-count rows from listings.unit_price/day_prices.",
  {
    indexes: ["idx_listing_prices_key", "idx_listing_prices_listing"],
    newTables: ["listing_prices"],
  },
  backfillListingPrices,
);
