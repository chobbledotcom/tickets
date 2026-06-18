import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-16_listing_aggregates",
  "Add booked_quantity, tickets_count and income aggregate columns to listings, maintained by triggers on listing_attendees, so listing reads and active-listing stats avoid scanning the attendee rows; backfill from existing data",
  {
    columns: {
      listings: ["booked_quantity", "tickets_count", "income"],
    },
    triggers: [
      "trg_listing_attendees_aggregates_insert",
      "trg_listing_attendees_aggregates_delete",
      "trg_listing_attendees_aggregates_update",
    ],
  },
  ({ backfillListingAggregates }) => backfillListingAggregates(),
);
