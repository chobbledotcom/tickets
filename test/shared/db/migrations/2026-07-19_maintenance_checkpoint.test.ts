import { assertArrayIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import maintenanceCheckpointMigration from "#db/migrations/2026-07-19_maintenance_checkpoint.ts";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectMigrationIdentity } from "#test-utils/migration-identity.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });

describeWithEnv(
  "db > migrations > maintenance checkpoint",
  { db: true },
  () => {
    test("declares its identity and checkpoint column", () => {
      expectMigrationIdentity(maintenanceCheckpointMigration(context), {
        description:
          "Remember where bounded maintenance scans should continue.",
        id: "2026-07-19_maintenance_checkpoint",
        requires: { columns: { maintenance_tasks: ["checkpoint"] } },
      });
    });

    test("adds the checkpoint column to an existing maintenance table", async () => {
      await getDb().execute(
        sql`ALTER TABLE maintenance_tasks DROP COLUMN checkpoint`,
      );

      await maintenanceCheckpointMigration(context).up();

      const columns = await getDb().execute(
        sql`PRAGMA table_info(maintenance_tasks)`,
      );
      assertArrayIncludes(
        columns.rows.map((row) => row.name),
        ["checkpoint"],
      );
    });
  },
);
