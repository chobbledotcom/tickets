import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import { sql } from "#db/sql.ts";
import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-07-21_activity_backfill_complete",
  "Keep completed activity log backfills complete after moving to checkpoints.",
  async ({ getDb }) => {
    await getDb().execute(sql`INSERT OR IGNORE INTO maintenance_tasks
              (name, next_run_at, checkpoint)
            VALUES (${"activity_log_backfill"}, 0, ${ACTIVITY_LOG_BACKFILL_COMPLETE})`);
  },
);
