import { columnDropMigration } from "./define.ts";

export default columnDropMigration(
  "2026-06-22_drop_listing_attendee_refunded",
  "listing_attendees",
  "Drop listing_attendees.refunded: an attendee/order's refund status is now " +
    "projected from the transfers ledger at read time — refunded iff a " +
    "refund_cash leg sourced from the attendee exists (set by both live refunds " +
    "and the historical backfill) — so the per-row aggregate column is removed. " +
    "Unlike the income drop, refunded has no triggers or indexes, so the table " +
    "is simply recreated from SCHEMA. No `requires`: a bare column drop isn't an " +
    "additive object, so it owns nothing the restore test can drop and rebuild; " +
    "the schema-hash guard covers the change.",
);
