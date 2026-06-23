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
    // The backfill reconstructs historical money from listing_attendees.refunded
    // and price_paid, which 2026-06-22_drop_listing_attendee_refunded /
    // 2026-06-22_drop_listing_attendee_price_paid remove *after* this runs. In
    // production both columns are still present here (real values intact); ensure
    // they exist so a freshly-created schema — where they have already been
    // dropped from the table definition — doesn't fail the backfill's read.
    const columns = await getExistingColumns("listing_attendees");
    if (!columns.has("refunded")) {
      await getDb().execute(
        "ALTER TABLE listing_attendees ADD COLUMN refunded INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.has("price_paid")) {
      await getDb().execute(
        "ALTER TABLE listing_attendees ADD COLUMN price_paid INTEGER NOT NULL DEFAULT 0",
      );
    }
    await backfillTransfers();
  },
);
