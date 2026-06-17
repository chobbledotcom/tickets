import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  absentTables: ["events", "event_attendees", "event_questions"],
  columns: {
    activity_log: ["listing_id"],
    built_sites: ["assigned_listing_id"],
    listing_attendees: ["listing_id"],
    listing_questions: ["listing_id"],
    listings: ["listing_type"],
  },
};

export default function renameEventsToListingsMigration({
  additive,
  renameEventsToListings,
}: MigrationContext): Migration {
  return additive({
    description:
      "Rename the 'event' domain to 'listing' (tables, columns and indexes); also runs as an idempotent verification/cleanup step after the baseline reconcile has already performed the rename",
    id: "2026-06-14_rename_events_to_listings",
    requires,
    up: renameEventsToListings,
  });
}
