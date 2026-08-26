import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import renewalTierMigration from "#db/migrations/2026-08-26_built_sites_renewal_tier.ts";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges });

const runMigration = () => renewalTierMigration(context).up();

/** Recreate built_sites without the renewal tier column (its pre-migration
 * shape), so the migration has the same work to do as on a live site. */
const createPreTierTable = () =>
  getDb().batch(
    [
      "DROP TABLE IF EXISTS built_sites",
      "CREATE TABLE built_sites (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
        "site_data TEXT NOT NULL, assignable INTEGER NOT NULL DEFAULT 0, " +
        "assigned_attendee_id INTEGER DEFAULT NULL, " +
        "assigned_listing_id INTEGER DEFAULT NULL, created TEXT NOT NULL, " +
        "renewal_token_index TEXT DEFAULT NULL, " +
        "read_only_from TEXT NOT NULL DEFAULT '', " +
        "site_data_revision INTEGER NOT NULL DEFAULT 0, " +
        "updates TEXT NOT NULL DEFAULT 'release')",
    ],
    "write",
  );

const insertSite = () =>
  getDb().execute(
    "INSERT INTO built_sites (site_data, created) VALUES ('{}', '2026-01-01T00:00:00Z')",
  );

const columnNames = async (): Promise<string[]> => {
  const result = await getDb().execute("PRAGMA table_info(built_sites)");
  return result.rows.map((row) => String(row.name));
};

const storedTiers = async (): Promise<unknown[]> => {
  const { rows } = await getDb().execute(
    "SELECT renewal_tier_listing_id FROM built_sites",
  );
  return rows.map((row) => row.renewal_tier_listing_id);
};

describeWithEnv(
  "db > migrations > 2026-08-26_built_sites_renewal_tier",
  { db: true },
  () => {
    test("adds the column, leaving existing sites on no particular tier", async () => {
      await createPreTierTable();
      await insertSite();
      expect(await columnNames()).not.toContain("renewal_tier_listing_id");

      await runMigration();

      expect(await columnNames()).toContain("renewal_tier_listing_id");
      // NULL is what the app reads as "the customer picks from every tier",
      // which is what a site that predates the column was already doing.
      expect(await storedTiers()).toEqual([null]);
    });

    test("keeps the columns the site already had", async () => {
      await createPreTierTable();
      await insertSite();

      await runMigration();

      const columns = await columnNames();
      for (const kept of [
        "assigned_listing_id",
        "read_only_from",
        "renewal_token_index",
        "site_data_revision",
        "updates",
      ]) {
        expect(columns).toContain(kept);
      }
    });

    test("stores a chosen tier once the column exists", async () => {
      await createPreTierTable();
      await insertSite();
      await runMigration();

      await getDb().execute({
        args: [7],
        sql: "UPDATE built_sites SET renewal_tier_listing_id = ?",
      });

      expect(await storedTiers()).toEqual([7]);
    });

    test("runs again without complaint on a database that already has it", async () => {
      await createPreTierTable();
      await insertSite();
      await runMigration();

      await runMigration();

      expect(await columnNames()).toContain("renewal_tier_listing_id");
      expect(await storedTiers()).toEqual([null]);
    });
  },
);
