import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_drop_listing_attendee_price_paid",
  "Drop listing_attendees.price_paid: a booking row's amount paid is now " +
    "projected from the transfers ledger at read time — the gross sale leg " +
    "billed from the attendee to the listing's revenue account within the " +
    "row's ledger_event_group — so the per-row column is removed. Runs AFTER " +
    "the backfill, which reads price_paid to reconstruct those sale legs; the " +
    "column is dead by this point (income, the attendee list, CSV, emails and " +
    "the order summary all read the projection). recreateTable rebuilds the " +
    "table from SCHEMA (without price_paid) and re-creates its count-aggregate " +
    "triggers, which never referenced price_paid. No `requires`: a bare column " +
    "drop isn't an additive object, so the restore test has nothing to rebuild; " +
    "the schema-hash guard covers the change.",
  {},
  async ({ recreateTable }) => {
    await recreateTable("listing_attendees"); // rebuild from SCHEMA, dropping price_paid
  },
);
