import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getDb } from "#shared/db/client.ts";
import maintenanceMigration from "#shared/db/migrations/2026-07-18_maintenance_tasks.ts";
import {
  applySchemaChanges,
  syncIndexes,
} from "#shared/db/migrations/schema-sync.ts";
import {
  ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
  PRUNE_INTERVAL_MS,
} from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const runMigration = () => maintenanceMigration(context).up();
const LEGACY_MARKERS = [
  "last_pruned_addresses",
  "last_pruned_contacts",
  "last_pruned_invites",
  "last_pruned_logins",
  "last_pruned_orphans",
  "last_pruned_payments",
  "last_pruned_sessions",
  "last_pruned_strings",
  "last_pruned_sumup",
  "last_pruned_tokens",
  "activity_log_backfill_done",
  "last_activity_log_backfill",
] as const;

describeWithEnv(
  "db > migrations > scheduled maintenance tasks",
  { db: true },
  () => {
    test("declares its id, description, and schema requirements", () => {
      const migration = maintenanceMigration(context);
      expect(migration.id).toBe("2026-07-18_maintenance_tasks");
      expect(migration.description).toBe(
        "Add durable scheduled maintenance task claims.",
      );
      expect(migration.requires).toEqual({
        columns: { built_sites: ["site_data_revision"] },
        indexes: ["idx_maintenance_tasks_due"],
        newTables: ["maintenance_tasks"],
      });
    });

    test("moves old due times and removes every old marker", async () => {
      await getDb().batch(
        [
          "DROP TABLE maintenance_tasks",
          ...LEGACY_MARKERS.map((key, index) => ({
            args: [
              key,
              key === "activity_log_backfill_done"
                ? "false"
                : String((index + 1) * 1000),
            ],
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
          })),
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
      expect(Number(tasks.rows[0]?.next_run_at)).toBe(
        12_000 + ACTIVITY_LOG_BACKFILL_INTERVAL_MS,
      );
      expect(Number(tasks.rows[1]?.next_run_at)).toBe(1000 + PRUNE_INTERVAL_MS);
      const markers = await getDb().execute({
        args: [...LEGACY_MARKERS],
        sql: `SELECT key FROM settings WHERE key IN (${LEGACY_MARKERS.map(() => "?").join(", ")})`,
      });
      expect(markers.rows).toEqual([]);
    });

    test("uses database migration time when old markers are invalid", async () => {
      using _time = new FakeTime(1_800_000_000_000);
      await getDb().batch(
        [
          "DROP TABLE maintenance_tasks",
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_pruned_sessions', '0')",
          "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_activity_log_backfill', 'not-a-time')",
        ],
        "write",
      );

      await runMigration();

      const tasks = await getDb().execute(
        "SELECT name, next_run_at FROM maintenance_tasks ORDER BY name",
      );
      expect(tasks.rows).toEqual([
        { name: "activity_log_backfill", next_run_at: 1_800_000_000_000 },
        { name: "database_pruning", next_run_at: 1_800_000_000_000 },
      ]);
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
