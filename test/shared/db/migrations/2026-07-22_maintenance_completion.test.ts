import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#db/activity-log-backfill.ts";
import { getDb } from "#db/client.ts";
import maintenanceCompletionMigration from "#db/migrations/2026-07-22_maintenance_completion.ts";
import { sql } from "#db/sql.ts";
import { describeMigrationSuite } from "#test-utils/migration-suite.ts";

const activityTask = () =>
  getDb().execute(
    sql`SELECT checkpoint, completed_at FROM maintenance_tasks WHERE name = 'activity_log_backfill'`,
  );
const replaceActivityTask = (checkpoint: string | null) =>
  getDb().execute(sql`INSERT OR REPLACE INTO maintenance_tasks
            (name, checkpoint, completed_at, next_run_at)
          VALUES (${"activity_log_backfill"}, ${checkpoint}, NULL, 0)`);

describeMigrationSuite(
  {
    identityTest: "declares its identity and completion column",
    title: "maintenance completion",
  },
  maintenanceCompletionMigration,
  {
    description: "Keep completed maintenance work dormant.",
    id: "2026-07-22_maintenance_completion",
    requires: { columns: { maintenance_tasks: ["completed_at"] } },
  },
  (run) => {
    test("marks an existing completed activity backfill as dormant", async () => {
      await replaceActivityTask(ACTIVITY_LOG_BACKFILL_COMPLETE);

      await run();

      const row = (await activityTask()).rows[0];
      expect(row?.checkpoint).toBe(ACTIVITY_LOG_BACKFILL_COMPLETE);
      expect(Number(row?.completed_at)).toBeGreaterThan(0);
    });

    test("keeps an unfinished activity backfill active", async () => {
      await replaceActivityTask(null);

      await run();

      expect((await activityTask()).rows).toEqual([
        { checkpoint: null, completed_at: null },
      ]);
    });
  },
);
