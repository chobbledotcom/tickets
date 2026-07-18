import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import dropLastPrunedMigration from "#shared/db/migrations/2026-07-18_drop_built_sites_last_pruned.ts";
import { recreateTable } from "#shared/db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ recreateTable });

describeWithEnv(
  "db > migrations > drop built-site prune marker",
  { db: true },
  () => {
    test("uses the current schema to remove only last_pruned", async () => {
      await getDb().execute(
        "ALTER TABLE built_sites ADD COLUMN last_pruned TEXT NOT NULL DEFAULT ''",
      );

      await dropLastPrunedMigration(context).up();

      const columns = await getDb().execute("PRAGMA table_info(built_sites)");
      const names = columns.rows.map((row) => String(row.name));
      expect(names).not.toContain("last_pruned");
      expect(names).toContain("site_data_revision");
    });
  },
);
