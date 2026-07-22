import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import { schemaMigration } from "./define.ts";

export default schemaMigration(
  "2026-07-22_maintenance_completion",
  "Keep completed maintenance work dormant.",
  { columns: { maintenance_tasks: ["completed_at"] } },
  async ({ getDb }) => {
    await getDb().execute({
      args: [
        Date.now(),
        "activity_log_backfill",
        ACTIVITY_LOG_BACKFILL_COMPLETE,
      ],
      sql: `UPDATE maintenance_tasks
               SET completed_at = ?
             WHERE name = ?
               AND checkpoint = ?
               AND completed_at IS NULL`,
    });
  },
);
