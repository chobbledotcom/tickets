import type {
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "./types.ts";

const requires: SchemaRequirement = {
  indexes: ["idx_activity_log_listing_id"],
};

export default function activityLogListingIdIndexMigration({
  additive,
  syncIndexes,
}: MigrationContext): Migration {
  return additive({
    description:
      "Add idx_activity_log_listing_id so per-listing activity log lookups use an index range scan instead of a full table scan",
    id: "2026-06-15_activity_log_listing_id_index",
    requires,
    up: syncIndexes,
  });
}
