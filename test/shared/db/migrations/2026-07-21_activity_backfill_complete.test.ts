import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ACTIVITY_LOG_BACKFILL_COMPLETE } from "#shared/db/activity-log-backfill.ts";
import { getDb } from "#shared/db/client.ts";
import activityBackfillCompleteMigration from "#shared/db/migrations/2026-07-21_activity_backfill_complete.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({});
const runMigration = () => activityBackfillCompleteMigration(context).up();
const activityTask = () =>
  getDb().execute(
    "SELECT checkpoint, next_run_at FROM maintenance_tasks WHERE name = 'activity_log_backfill'",
  );
const replaceActivityTask = (checkpoint: string | null, nextRunAt: number) =>
  getDb().execute({
    args: ["activity_log_backfill", nextRunAt, checkpoint],
    sql: `INSERT OR REPLACE INTO maintenance_tasks
            (name, next_run_at, checkpoint)
          VALUES (?, ?, ?)`,
  });

describeWithEnv(
  "db > migrations > completed activity backfill",
  { db: true },
  () => {
    test("declares its identity", () => {
      const migration = activityBackfillCompleteMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description:
          "Keep completed activity log backfills complete after moving to checkpoints.",
        id: "2026-07-21_activity_backfill_complete",
        requires: {},
      });
    });

    test("restores the completed checkpoint for an absent old task", async () => {
      await getDb().execute(
        "DELETE FROM maintenance_tasks WHERE name = 'activity_log_backfill'",
      );

      await runMigration();

      expect((await activityTask()).rows).toEqual([
        {
          checkpoint: ACTIVITY_LOG_BACKFILL_COMPLETE,
          next_run_at: 0,
        },
      ]);
    });

    test("keeps an existing unfinished task", async () => {
      await replaceActivityTask(null, 123);

      await runMigration();

      expect((await activityTask()).rows).toEqual([
        { checkpoint: null, next_run_at: 123 },
      ]);
    });

    test("keeps one completed task unchanged when run again", async () => {
      await replaceActivityTask(ACTIVITY_LOG_BACKFILL_COMPLETE, 456);

      await runMigration();

      expect((await activityTask()).rows).toEqual([
        {
          checkpoint: ACTIVITY_LOG_BACKFILL_COMPLETE,
          next_run_at: 456,
        },
      ]);
    });
  },
);
