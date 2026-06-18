import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  indexes: ["idx_listing_attendees_listing_end_start"],
};

export default function eventAttendeesOverlapIndexMigration({
  syncIndexes,
  tableExists,
  verifyRequirement,
}: MigrationContext): Migration {
  return {
    description:
      "Reorder listing_attendees overlap index to (listing_id, end_at, start_at) so per-day capacity scans skip historical rows",
    // NB: legacy id retained verbatim. This is a stored marker, not display text.
    id: "2026-06-13_event_attendees_overlap_index",
    requires,
    up: async () => {
      // In the normal migration order the baseline reconcile has already
      // renamed events->listings before we get here, so the DB on this step
      // has the listing-named tables and syncIndexes() can create the index
      // directly. The "events" guard covers the case where this migration is
      // run on its own (or after a partial baseline) on a still-pre-rename
      // database: "listings" doesn't exist yet so syncIndexes() would fail.
      if (await tableExists("events")) return;
      await syncIndexes();
    },
    verify: async () => {
      // Pre-rename databases build the listing-named index after the rename
      // completes. Nothing to verify here until then.
      if (await tableExists("events")) return;
      await verifyRequirement(requires)();
    },
  };
}
