import { columnDropMigration } from "./define.ts";

export default columnDropMigration(
  "2026-06-22_drop_attendees_price_paid",
  "attendees",
  "Drop the vestigial attendees.price_paid column. A booking's amount paid is a " +
    "per-row figure that lived on listing_attendees (itself now ledger-projected); " +
    "the attendees-level price_paid was never written by the booking insert and " +
    "never read (the attendee read columns omit it, and the amount shown comes " +
    "from the listing_attendees projection), so the dead column is removed. " +
    "recreateTable rebuilds attendees from SCHEMA (without price_paid) and its " +
    "indexes; attendees has no triggers and nothing FK-references it. No " +
    "`requires`: a bare column drop isn't an additive object, so the restore test " +
    "has nothing to rebuild; the schema-hash guard covers the change.",
);
