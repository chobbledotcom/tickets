import { schemaMigration } from "./define.ts";

/** The three listing-aggregate triggers whose tickets_count bodies change. */
const LISTING_AGGREGATE_TRIGGER_NAMES = [
  "trg_listing_attendees_aggregates_insert",
  "trg_listing_attendees_aggregates_delete",
  "trg_listing_attendees_aggregates_update",
];

export default schemaMigration(
  "2026-06-23_ticket_count_no_quantity",
  "Exclude no-quantity (quantity = 0) booking lines from listings.tickets_count by rebuilding the three listing-aggregate triggers so an INSERT/DELETE/UPDATE only shifts tickets_count for a quantity > 0 row; recompute tickets_count for existing data. Runs after 2026-06-22_drop_listing_income, which rebuilt these same triggers in their income-free form, so this is the final word on their bodies on every database — fresh or already-migrated",
  {},
  async ({ getDb, syncTriggers, backfillListingAggregates }) => {
    // syncTriggers only CREATEs absent trigger names, so the three triggers —
    // same names, new CASE bodies — must be dropped first. Otherwise a database
    // that already ran 2026-06-22_drop_listing_income keeps the COUNT(*)-style
    // bodies and goes on counting quantity = 0 writes. (Mirrors the answer-/
    // modifier-aggregate migrations.)
    for (const name of LISTING_AGGREGATE_TRIGGER_NAMES) {
      await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    }
    await syncTriggers();
    // Recompute tickets_count for existing data. A no-op today (no quantity = 0
    // lines exist yet), but correct once the owner UI can write them.
    await backfillListingAggregates();
  },
);
