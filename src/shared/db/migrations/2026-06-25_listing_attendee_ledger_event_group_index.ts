import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-25_listing_attendee_ledger_event_group_index",
  "Add idx_listing_attendees_ledger_event_group so the ledger-replay owner " +
    "lookup (attendeeIdByLedgerEventGroup: SELECT attendee_id FROM " +
    "listing_attendees WHERE ledger_event_group = ?) resolves via an index " +
    "seek instead of a full scan of every booking ever made.",
  {
    indexes: ["idx_listing_attendees_ledger_event_group"],
  },
);
