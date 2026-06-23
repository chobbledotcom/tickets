import { triggerRewriteDropMigration } from "./define.ts";

/** The listing-aggregate triggers whose income maintenance is being removed. */
const AGGREGATE_TRIGGERS = [
  "trg_listing_attendees_aggregates_insert",
  "trg_listing_attendees_aggregates_delete",
  "trg_listing_attendees_aggregates_update",
];

export default triggerRewriteDropMigration(
  "2026-06-22_drop_listing_income",
  "listings",
  AGGREGATE_TRIGGERS,
  "Drop listings.income and the price_paid lines of its maintaining triggers: a " +
    "listing's income is now projected from the transfers ledger (gross credits " +
    "to revenue:<listingId>) at read time, so the stored aggregate is removed. " +
    "booked_quantity and tickets_count stay trigger-maintained. No `requires`: a " +
    "column drop plus a trigger-body change isn't an additive object, so it owns " +
    "nothing the restore test can drop and rebuild; the schema-hash guard covers " +
    "the change.",
);
