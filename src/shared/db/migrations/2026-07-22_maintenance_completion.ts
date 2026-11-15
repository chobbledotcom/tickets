import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import { sql } from "#db/sql.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-22_maintenance_completion",
  "Keep completed maintenance work dormant.",
  { columns: { maintenance_tasks: ["completed_at"] } },
  async ({ getDb }) => {
    await getDb().execute(sql`UPDATE maintenance_tasks
               SET completed_at = ${Date.now()}
             WHERE name = ${"activity_log_backfill"}
               AND checkpoint = ${ACTIVITY_LOG_BACKFILL_COMPLETE}
               AND completed_at IS NULL`);
  },
);
