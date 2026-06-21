import { schemaMigration } from "./define.ts";

/** The three listing-aggregate triggers whose tickets_count bodies change. */
const LISTING_AGGREGATE_TRIGGER_NAMES = [
  "trg_listing_attendees_aggregates_insert",
  "trg_listing_attendees_aggregates_delete",
  "trg_listing_attendees_aggregates_update",
];

export default schemaMigration(
  "2026-06-21_ticket_count_no_quantity",
  "Exclude no-quantity (quantity = 0) booking lines from listings.tickets_count by rebuilding the three listing-aggregate triggers so an INSERT/DELETE/UPDATE only shifts tickets_count for a quantity > 0 row; recompute tickets_count for existing data",
  {
    triggers: LISTING_AGGREGATE_TRIGGER_NAMES,
  },
  async ({ getDb, syncTriggers, backfillListingAggregates }) => {
    // syncTriggers only CREATEs triggers whose names are MISSING (CREATE TRIGGER
    // IF NOT EXISTS runs only for absent names), so the three listing-aggregate
    // triggers — same names, new CASE bodies — must be dropped explicitly before
    // re-syncing. Otherwise upgraded databases keep the old COUNT(*) bodies and
    // go on incrementing tickets_count for quantity = 0 writes. Mirrors the
    // answer-/modifier-aggregate migrations, which drop before re-syncing.
    for (const name of LISTING_AGGREGATE_TRIGGER_NAMES) {
      await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    }
    await syncTriggers();
    // Recompute tickets_count for existing data. A no-op today (no quantity = 0
    // lines exist yet), but correct once the owner UI / importer can write them.
    await backfillListingAggregates();
  },
);
