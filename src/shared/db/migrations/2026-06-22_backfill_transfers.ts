import { backfillTransfers } from "#shared/accounting/backfill.ts";
import { getDb } from "#shared/db/client.ts";
import { schemaMigration } from "./define.ts";
import { getExistingColumns } from "./schema-sync.ts";

export default schemaMigration(
  "2026-06-22_backfill_transfers",
  "Backfill the transfers ledger from every existing paid booking — one sale " +
    "per listing plus a payment, and a full reversal for refunded bookings — so " +
    "the ledger holds the complete money history before reads move off the " +
    "price_paid/refunded columns. No production modifier or reservation has " +
    "ever existed, so every booking is paid (or refunded) in full. Carries no " +
    "`requires`; LATEST_UPDATE is bumped so already-up-to-date sites still run " +
    "it. Idempotent via the mappers' deterministic references (INSERT OR IGNORE).",
  {},
  async () => {
    // The backfill reconstructs historical refunds from listing_attendees.refunded,
    // which 2026-06-22_drop_listing_attendee_refunded removes *after* this runs.
    // In production the column is still present here (real refund values intact);
    // ensure it exists so a freshly-created schema — where it has already been
    // dropped from the table definition — doesn't fail the backfill's read.
    if (!(await getExistingColumns("listing_attendees")).has("refunded")) {
      await getDb().execute(
        "ALTER TABLE listing_attendees ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0",
      );
    }
    await backfillTransfers();
  },
);
