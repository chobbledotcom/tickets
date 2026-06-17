import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  columns: {
    listings: ["booked_quantity", "tickets_count", "income"],
  },
  triggers: [
    "trg_listing_attendees_aggregates_insert",
    "trg_listing_attendees_aggregates_delete",
    "trg_listing_attendees_aggregates_update",
  ],
};

export default function listingAggregatesMigration({
  additive,
  applySchemaChanges,
  backfillListingAggregates,
  syncTriggers,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add booked_quantity, tickets_count and income aggregate columns to listings, maintained by triggers on listing_attendees, so listing reads and active-listing stats avoid scanning the attendee rows; backfill from existing data",
    id: "2026-06-16_listing_aggregates",
    requires,
    up: async () => {
      await applySchemaChanges();
      // Triggers first, then an absolute recompute: any attendee write that
      // slips in between is counted by the trigger and then overwritten by the
      // fresh backfill total, so no insert can be lost.
      await syncTriggers();
      await backfillListingAggregates();
    },
  });
}
