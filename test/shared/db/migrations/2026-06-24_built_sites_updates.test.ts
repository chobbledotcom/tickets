import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import builtSitesUpdatesMigration from "#db/migrations/2026-06-24_built_sites_updates.ts";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });

const runMigration = () => builtSitesUpdatesMigration(context).up();

/** Recreate built_sites without the updates column (its pre-migration shape). */
const createPreUpdatesTable = () =>
  getDb().batch(
    [
      sql`DROP TABLE IF EXISTS built_sites`,
      sql`CREATE TABLE built_sites (id INTEGER PRIMARY KEY AUTOINCREMENT, site_data TEXT NOT NULL, assignable INTEGER NOT NULL DEFAULT 0, assigned_attendee_id INTEGER DEFAULT NULL, assigned_listing_id INTEGER DEFAULT NULL, created TEXT NOT NULL, renewal_token_index TEXT DEFAULT NULL, read_only_from TEXT NOT NULL DEFAULT '', last_pruned TEXT NOT NULL DEFAULT '')`,
    ],
    "write",
  );

const insertSite = (updates?: string) =>
  getDb().execute(
    updates === undefined
      ? sql`INSERT INTO built_sites (site_data, created) VALUES ('{}', '2026-01-01T00:00:00Z')`
      : sql`INSERT INTO built_sites (site_data, created, updates) VALUES ('{}', '2026-01-01T00:00:00Z', ${updates})`,
  );

const columnNames = async (): Promise<string[]> => {
  const result = await getDb().execute(sql`PRAGMA table_info(built_sites)`);
  return result.rows.map((row) => String(row.name));
};

describeWithEnv(
  "db > migrations > 2026-06-24_built_sites_updates",
  { db: true },
  () => {
    test("adds the updates column, defaulting existing rows to release", async () => {
      await createPreUpdatesTable();
      await insertSite();
      assert(!(await columnNames()).includes("updates"));

      await runMigration();

      assertArrayIncludes(await columnNames(), ["updates"]);
      const { rows } = await getDb().execute(
        sql`SELECT updates FROM built_sites`,
      );
      // A site that predates the channel feature lands on the safe default.
      expect(rows[0]?.updates).toBe("release");
    });

    test("the CHECK constraint rejects an unknown channel", async () => {
      await createPreUpdatesTable();
      await runMigration();
      await expect(insertSite("stable")).rejects.toThrow();
    });

    test("accepts every valid channel after the migration", async () => {
      await createPreUpdatesTable();
      await runMigration();
      for (const tier of ["alpha", "beta", "release"]) {
        await insertSite(tier);
      }
      const { rows } = await getDb().execute(
        sql`SELECT updates FROM built_sites ORDER BY updates`,
      );
      expect(rows.map((row) => String(row.updates))).toEqual([
        "alpha",
        "beta",
        "release",
      ]);
    });
  },
);
