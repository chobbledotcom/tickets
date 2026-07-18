import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import maintenanceMigration from "#shared/db/migrations/2026-07-18_maintenance_tasks.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const runMigration = () => maintenanceMigration(context).up();

describeWithEnv(
  "db > migrations > scheduled maintenance tasks",
  { db: true },
  () => {
    test("moves old due times and removes every old marker", async () => {
      await getDb().batch(
        [
          "DROP TABLE maintenance_tasks",
          {
            args: ["last_pruned_sessions", "1000"],
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          },
          {
            args: ["last_activity_log_backfill", "2000"],
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          },
        ],
        "write",
      );

      await runMigration();

      const tasks = await getDb().execute(
        "SELECT name, next_run_at FROM maintenance_tasks ORDER BY name",
      );
      expect(tasks.rows.map((row) => String(row.name))).toEqual([
        "activity_log_backfill",
        "database_pruning",
      ]);
      expect(Number(tasks.rows[0]?.next_run_at)).toBeGreaterThan(2000);
      expect(Number(tasks.rows[1]?.next_run_at)).toBeGreaterThan(1000);
      const markers = await getDb().execute(
        "SELECT key FROM settings WHERE key LIKE 'last_pruned_%' OR key IN ('last_activity_log_backfill', 'activity_log_backfill_done')",
      );
      expect(markers.rows).toEqual([]);
    });

    test("adds a revision fence to existing built sites", async () => {
      await getDb().execute("DROP TABLE maintenance_tasks");
      await runMigration();

      const columns = await getDb().execute("PRAGMA table_info(built_sites)");
      expect(columns.rows.map((row) => String(row.name))).toContain(
        "site_data_revision",
      );
    });

    test("does not reschedule a backfill that was already complete", async () => {
      await getDb().batch(
        [
          "DROP TABLE maintenance_tasks",
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_log_backfill_done', 'true')",
        ],
        "write",
      );

      await runMigration();

      const task = await getDb().execute(
        "SELECT name FROM maintenance_tasks WHERE name = 'activity_log_backfill'",
      );
      expect(task.rows).toEqual([]);
    });
  },
);
