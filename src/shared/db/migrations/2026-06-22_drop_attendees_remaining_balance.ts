import { columnDropMigration } from "./define.ts";

export default columnDropMigration(
  "2026-06-22_drop_attendees_remaining_balance",
  "attendees",
  "Drop attendees.remaining_balance: an attendee's outstanding balance now " +
    "projects from the transfers ledger as −balanceOf(attendee) (money billed " +
    "to them on sale legs minus cash received on payment legs), so the stored " +
    "column is removed. Every booking that owes money records the owed amount " +
    "with its sale leg at creation, and a balance settlement posts a payment leg " +
    "guarded on the projected balance — there is no column to write. Production " +
    "balances were uniformly zero (no reservations), so the projection equals 0 " +
    "for every existing attendee. recreateTable rebuilds attendees from SCHEMA " +
    "and its indexes; no triggers or FKs reference it. No `requires`: a bare " +
    "column drop isn't an additive object; the schema-hash guard covers it.",
);
