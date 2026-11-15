import { assertArrayIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import maintenanceCheckpointMigration from "#db/migrations/2026-07-19_maintenance_checkpoint.ts";
import { sql } from "#db/sql.ts";
import { describeMigrationSuite } from "#test-utils/migration-suite.ts";

describeMigrationSuite(
  {
    identityTest: "declares its identity and checkpoint column",
    title: "maintenance checkpoint",
  },
  maintenanceCheckpointMigration,
  {
    description: "Remember where bounded maintenance scans should continue.",
    id: "2026-07-19_maintenance_checkpoint",
    requires: { columns: { maintenance_tasks: ["checkpoint"] } },
  },
  (run) => {
    test("adds the checkpoint column to an existing maintenance table", async () => {
      await getDb().execute(
        sql`ALTER TABLE maintenance_tasks DROP COLUMN checkpoint`,
      );

      await run();

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
