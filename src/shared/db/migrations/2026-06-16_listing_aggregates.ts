import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_listing_aggregates",
  "Add booked_quantity and tickets_count aggregate columns to listings, maintained by triggers on listing_attendees, so listing reads and active-listing stats avoid scanning the attendee rows; backfill from existing data. (This historically also added an income column, since dropped — income is projected from the transfers ledger; see 2026-06-22_drop_listing_income.)",
  {
    columns: {
      listings: ["booked_quantity", "tickets_count"],
    },
    triggers: [
      "trg_listing_attendees_aggregates_insert",
      "trg_listing_attendees_aggregates_delete",
      "trg_listing_attendees_aggregates_update",
    ],
  },
  ({ backfillListingAggregates }) => backfillListingAggregates(),
);
