import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import { bareSchemaMigration } from "./define.ts";

export default bareSchemaMigration(
  "2026-07-21_activity_backfill_complete",
  "Keep completed activity log backfills complete after moving to checkpoints.",
  async ({ getDb }) => {
    await getDb().execute({
      args: ["activity_log_backfill", ACTIVITY_LOG_BACKFILL_COMPLETE],
      sql: `INSERT OR IGNORE INTO maintenance_tasks
              (name, next_run_at, checkpoint)
            VALUES (?, 0, ?)`,
    });
  },
);
