import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import dropLastPrunedMigration from "#db/migrations/2026-07-18_drop_built_sites_last_pruned.ts";
import { recreateTable } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";
import { has } from "#test-utils/says.ts";

const context = buildMigrationContext({ recreateTable });

describeWithEnv(
  "db > migrations > drop built-site prune marker",
  { db: true },
  () => {
    test("declares its id and description", () => {
      const migration = dropLastPrunedMigration(context);
      expect(migration.id).toBe("2026-07-18_drop_built_sites_last_pruned");
      expect(migration.description).toBe(
        "Remove the unused built-site prune marker.",
      );
    });

    test("uses the current schema to remove only last_pruned", async () => {
      await getDb().execute(
        "ALTER TABLE built_sites ADD COLUMN last_pruned TEXT NOT NULL DEFAULT ''",
      );

      await dropLastPrunedMigration(context).up();

      const columns = await getDb().execute("PRAGMA table_info(built_sites)");
      const names = columns.rows.map((row) => String(row.name));
      assert(!names.includes("last_pruned"));
      has(names, "site_data_revision");
    });
  },
);
