import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import { getDb } from "#shared/db/client.ts";
import maintenanceCompletionMigration from "#shared/db/migrations/2026-07-22_maintenance_completion.ts";
import { applySchemaChanges } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });
const runMigration = (): Promise<void> =>
  maintenanceCompletionMigration(context).up();
const activityTask = () =>
  getDb().execute(
    "SELECT checkpoint, completed_at FROM maintenance_tasks WHERE name = 'activity_log_backfill'",
  );
const replaceActivityTask = (checkpoint: string | null) =>
  getDb().execute({
    args: ["activity_log_backfill", checkpoint],
    sql: `INSERT OR REPLACE INTO maintenance_tasks
            (name, checkpoint, completed_at, next_run_at)
          VALUES (?, ?, NULL, 0)`,
  });

describeWithEnv(
  "db > migrations > maintenance completion",
  { db: true },
  () => {
    test("declares its identity and completion column", () => {
      const migration = maintenanceCompletionMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description: "Keep completed maintenance work dormant.",
        id: "2026-07-22_maintenance_completion",
        requires: { columns: { maintenance_tasks: ["completed_at"] } },
      });
    });

    test("marks an existing completed activity backfill as dormant", async () => {
      await replaceActivityTask(ACTIVITY_LOG_BACKFILL_COMPLETE);

      await runMigration();

      const row = (await activityTask()).rows[0];
      expect(row?.checkpoint).toBe(ACTIVITY_LOG_BACKFILL_COMPLETE);
      expect(Number(row?.completed_at)).toBeGreaterThan(0);
    });

    test("keeps an unfinished activity backfill active", async () => {
      await replaceActivityTask(null);

      await runMigration();

      expect((await activityTask()).rows).toEqual([
        { checkpoint: null, completed_at: null },
      ]);
    });
  },
);
