import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-22_listing_attendee_ledger_event_group",
  "Add a ledger_event_group column to listing_attendees — the ledger event " +
    "group of the booking order each row belongs to — so a per-row amount-paid " +
    "projection can resolve exactly that booking's sale leg even when an attendee " +
    "holds several orders for one listing. Stamped at booking creation going " +
    "forward and, for existing rows, by the 2026-06-22_backfill_transfers " +
    "migration that runs immediately after this one (which is why this is " +
    "registered before it). Additive column add — applied via applySchemaChanges.",
  {
    columns: { listing_attendees: ["ledger_event_group"] },
  },
);
