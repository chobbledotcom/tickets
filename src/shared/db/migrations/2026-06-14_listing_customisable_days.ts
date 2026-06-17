import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-14_listing_customisable_days",
  "Add customisable_days and day_prices columns to listings so visitors can choose how many days to book with per-day-count pricing",
  {
    columns: { listings: ["customisable_days", "day_prices"] },
  },
);
