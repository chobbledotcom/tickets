import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb, insert } from "#shared/db/client.ts";
import {
  MIGRATIONS,
  type Migration,
  type SchemaRequirement,
} from "#shared/db/migrations.ts";
import { describeWithEnv } from "#test-utils";

/**
 * "Restore from each migration" — for every additive migration, start from a
 * fully-migrated database, drop exactly the objects that migration owns, prove
 * its verify() now fails, then re-run its up() and prove verify() passes again
 * and that pre-existing data survived. This exercises the real production up()
 * and verify() for each migration in isolation, and keeps each migration's
 * declared `requires` honest against what up() actually creates.
 */
describeWithEnv("db > migration restore", { db: true }, () => {
  const migrationById = (id: string): Migration =>
    MIGRATIONS.find((m) => m.id === id)!;

  const tableColumns = async (table: string): Promise<Set<string>> => {
    const result = await getDb().execute(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    return new Set(result.rows.map((row) => String(row.name)));
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const result = await getDb().execute({
      args: [name],
      sql: "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
    });
    return result.rows.length > 0;
  };

  // Drop a migration's owned objects in an order SQLite accepts: indexes first
  // (a column can't be dropped while an index references it), then the columns
  // added to existing tables, then the tables the migration created.
  const dropOwnedObjects = async (req: SchemaRequirement): Promise<void> => {
    for (const index of req.indexes ?? []) {
      await getDb().execute(`DROP INDEX IF EXISTS ${index}`);
    }
    for (const [table, cols] of Object.entries(req.columns ?? {})) {
      for (const col of cols) {
        await getDb().execute(`ALTER TABLE ${table} DROP COLUMN ${col}`);
      }
    }
    for (const table of req.newTables ?? []) {
      await getDb().execute(`DROP TABLE IF EXISTS ${table}`);
    }
  };

  const seedSentinelListing = (): Promise<unknown> =>
    getDb().execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        max_attendees: 10,
        name: "sentinel-listing",
      }),
    );

  const sentinelListingExists = async (): Promise<boolean> => {
    const result = await getDb().execute(
      "SELECT 1 FROM listings WHERE name = 'sentinel-listing'",
    );
    return result.rows.length > 0;
  };

  // Additive migrations own concrete objects and can be reconstructed by
  // re-running up(). The baseline reconcile (no `requires`) and the rename
  // (which removes legacy tables rather than adding objects) are covered
  // separately below.
  const additiveMigrations = MIGRATIONS.filter(
    (m) => m.requires && !m.requires.absentTables,
  );

  test("every additive migration is covered by a restore case", () => {
    // Guards against a future migration slipping through with no restore test.
    expect(additiveMigrations.length).toBe(MIGRATIONS.length - 2);
  });

  for (const migration of additiveMigrations) {
    const req = migration.requires!;

    test(`restores ${migration.id} after its objects are dropped`, async () => {
      await seedSentinelListing();

      // Precondition: a freshly-migrated DB satisfies the migration.
      await migration.verify();

      await dropOwnedObjects(req);

      // With its objects gone, the migration's verify() must fail.
      await expect(migration.verify()).rejects.toThrow(
        "Migration verification failed",
      );

      // Re-running up() restores exactly those objects...
      await migration.up();
      await migration.verify();

      // ...and the row that existed before the drop/restore is untouched.
      expect(await sentinelListingExists()).toBe(true);

      // Spot-check that each declared object is actually present again.
      for (const table of req.newTables ?? []) {
        expect((await tableColumns(table)).size).toBeGreaterThan(0);
      }
      for (const [table, cols] of Object.entries(req.columns ?? {})) {
        const present = await tableColumns(table);
        for (const col of cols) expect(present.has(col)).toBe(true);
      }
      for (const index of req.indexes ?? []) {
        expect(await indexExists(index)).toBe(true);
      }
    });
  }

  test("a fully-migrated database satisfies every migration's verify()", async () => {
    for (const migration of MIGRATIONS) {
      await migration.verify();
    }
  });

  test("narrowed verify fails only for the owning migration", async () => {
    // Drop an index owned solely by the activity-log-index migration.
    await getDb().execute("DROP INDEX IF EXISTS idx_activity_log_listing_id");

    await expect(
      migrationById("2026-06-15_activity_log_listing_id_index").verify(),
    ).rejects.toThrow("idx_activity_log_listing_id");

    // A migration that does not own that index is unaffected — the old
    // full-schema verify would have failed here too.
    await migrationById("2026-06-12_sumup_checkouts").verify();
  });

  test("verify names the missing object", async () => {
    await getDb().execute("DROP TABLE IF EXISTS attendee_statuses");
    await expect(
      migrationById("2026-06-14_attendee_statuses").verify(),
    ).rejects.toThrow("missing table attendee_statuses");
  });

  describe("rename migration verify", () => {
    const rename = () => migrationById("2026-06-14_rename_events_to_listings");

    // Rename the current listing-named tables/columns back to their historical
    // "event" names, reproducing the pre-rename shape on disk.
    const downgradeToLegacyNames = () =>
      getDb().batch(
        [
          "ALTER TABLE listings RENAME COLUMN listing_type TO event_type",
          "ALTER TABLE listings RENAME TO events",
          "ALTER TABLE listing_attendees RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE listing_attendees RENAME TO event_attendees",
          "ALTER TABLE listing_questions RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE listing_questions RENAME TO event_questions",
          "ALTER TABLE activity_log RENAME COLUMN listing_id TO event_id",
          "ALTER TABLE built_sites RENAME COLUMN assigned_listing_id TO assigned_event_id",
        ],
        "write",
      );

    test("rejects while legacy event tables are still present", async () => {
      await downgradeToLegacyNames();
      await expect(rename().verify()).rejects.toThrow(
        "Migration verification failed",
      );
    });

    test("resolves after up() renames everything to listing", async () => {
      await downgradeToLegacyNames();
      await rename().up();
      await rename().verify();
    });
  });
});
