import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_listing_customisable_days",
  "Add customisable_days and day_prices columns to listings so visitors can choose how many days to book with per-day-count pricing. (This historically also added a day_prices column, since dropped — per-day-count prices live in the listing_prices 'day_count' dimension; see 2026-07-02_drop_listings_day_prices.)",
  {
    columns: { listings: ["customisable_days"] },
  },
);
