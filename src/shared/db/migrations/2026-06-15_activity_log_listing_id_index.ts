import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-06-15_activity_log_listing_id_index",
  "Add idx_activity_log_listing_id so per-listing activity log lookups use an index range scan instead of a full table scan",
  {
    indexes: ["idx_activity_log_listing_id"],
  },
);
