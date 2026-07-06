import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-06_listing_attendees_end_start_index",
  "Add idx_listing_attendees_end_start so the Logistics tab's Other " +
    "Attendees query (getOverlappingBookings: start_at < ? AND end_at > ? " +
    "across ALL listings) range-scans active rows instead of walking every " +
    "booking ever made — the existing overlap index leads with listing_id, " +
    "which this cross-listing read cannot use.",
  {
    indexes: ["idx_listing_attendees_end_start"],
  },
);
