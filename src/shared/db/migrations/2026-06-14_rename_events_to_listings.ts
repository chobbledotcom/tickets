import type { LegacyRenamePlan } from "./rename-utils.ts";
import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

export const EVENT_TO_LISTING_RENAME_PLAN: LegacyRenamePlan = {
  columnRenames: [
    ["listings", "event_type", "listing_type"],
    ["listing_attendees", "event_id", "listing_id"],
    ["listing_questions", "event_id", "listing_id"],
    ["activity_log", "event_id", "listing_id"],
    ["built_sites", "assigned_event_id", "assigned_listing_id"],
  ],
  tableRenames: [
    ["events", "listings"],
    ["event_attendees", "listing_attendees"],
    ["event_questions", "listing_questions"],
  ],
};

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
