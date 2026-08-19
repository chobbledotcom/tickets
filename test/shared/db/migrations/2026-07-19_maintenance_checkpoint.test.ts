import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import maintenanceCheckpointMigration from "#db/migrations/2026-07-19_maintenance_checkpoint.ts";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });

describeWithEnv(
  "db > migrations > maintenance checkpoint",
  { db: true },
  () => {
    test("declares its identity and checkpoint column", () => {
      const migration = maintenanceCheckpointMigration(context);
      expect({
        description: migration.description,
        id: migration.id,
        requires: migration.requires,
      }).toEqual({
        description:
          "Remember where bounded maintenance scans should continue.",
        id: "2026-07-19_maintenance_checkpoint",
        requires: { columns: { maintenance_tasks: ["checkpoint"] } },
      });
    });

    test("adds the checkpoint column to an existing maintenance table", async () => {
      await getDb().execute(
        "ALTER TABLE maintenance_tasks DROP COLUMN checkpoint",
      );

      await maintenanceCheckpointMigration(context).up();

      const columns = await getDb().execute(
        "PRAGMA table_info(maintenance_tasks)",
      );
      expect(columns.rows.map((row) => row.name)).toContain("checkpoint");
    });
  },
);
