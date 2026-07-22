import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb, inPlaceholders } from "#shared/db/client.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#shared/db/migrations/schema/version.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  loadMigrations,
  type Migration,
  MigrationInProgressError,
} from "#shared/db/migrations.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { restoreSchemaBeforeMigrations } from "#test/lib/db/migration-restore/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const LISTINGS_TAG_MIGRATION_ID = "2026-07-03_attendee_listings_tag";
const LISTINGS_TAG_REVISION =
  "Rewrite the {{listing}} attendee column-order tag to {{listings}} for the grouped Listings column.";
const FREE_TEXT_MIGRATION_ID = "2026-06-20_free_text_questions";

const MIGRATIONS = await loadMigrations();

const migrationsAfterListingsTag = (): Migration[] => {
  const appliedIndex = MIGRATIONS.findIndex(
    (migration) => migration.id === LISTINGS_TAG_MIGRATION_ID,
  );
  if (appliedIndex < 0) {
    throw new Error(`Missing migration ${LISTINGS_TAG_MIGRATION_ID}`);
  }
  return MIGRATIONS.slice(appliedIndex + 1);
};

describeWithEnv("migration request round-trip budget", { db: true }, () => {
  test("records the free-text migration within one guarded request", async () => {
    const migration = MIGRATIONS.find(
      ({ id }) => id === FREE_TEXT_MIGRATION_ID,
    );
    if (!migration) {
      throw new Error(`Missing migration ${FREE_TEXT_MIGRATION_ID}`);
    }
    await restoreSchemaBeforeMigrations([migration]);
    await executeBatch([
      {
        args: [migration.id],
        sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      },
      {
        args: [LATEST_DB_UPDATE_KEY, DB_SCHEMA_HASH_KEY],
        sql: "UPDATE settings SET value = 'stale' WHERE key IN (?, ?)",
      },
    ]);
    invalidateInitDbCache();

    const staleMarkers = await getDb().execute({
      args: [LATEST_DB_UPDATE_KEY, DB_SCHEMA_HASH_KEY],
      sql: "SELECT key, value FROM settings WHERE key IN (?, ?) ORDER BY key",
    });
    expect(
      staleMarkers.rows.map(({ key, value }) => ({
        key: String(key),
        value: String(value),
      })),
    ).toEqual([
      { key: DB_SCHEMA_HASH_KEY, value: "stale" },
      { key: LATEST_DB_UPDATE_KEY, value: "stale" },
    ]);

    await runWithQueryLogContext(() => initDb());

    const marker = await getDb().execute({
      args: [migration.id],
      sql: `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
    });
    expect(marker.rows.map((row) => String(row.id))).toEqual([migration.id]);
  });

  test("upgrades the listings-tag revision within guarded edge requests", async () => {
    const pending = migrationsAfterListingsTag();
    const pendingIds = pending.map((migration) => migration.id);
    await restoreSchemaBeforeMigrations(pending);
    await executeBatch([
      {
        args: [LISTINGS_TAG_REVISION],
        sql: `UPDATE settings SET value = ? WHERE key = '${LATEST_DB_UPDATE_KEY}'`,
      },
      {
        args: pendingIds,
        sql: `DELETE FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id IN (${inPlaceholders(pendingIds)})`,
      },
    ]);
    invalidateInitDbCache();

    const oldListingColumns = await getDb().execute(
      "SELECT name FROM pragma_table_info('listings')",
    );
    expect(oldListingColumns.rows.map((row) => String(row.name))).toContain(
      "image_url",
    );
    const oldImagesTable = await getDb().execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'images'",
    );
    expect(oldImagesTable.rows).toHaveLength(0);

    let continuations = 0;
    let finished = false;
    for (let attempt = 0; attempt < pendingIds.length; attempt += 1) {
      try {
        await runWithQueryLogContext(() => initDb());
        finished = true;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationInProgressError);
        continuations += 1;
      }
    }
    expect(finished).toBe(true);
    expect(continuations).toBe(5);

    const result = await getDb().execute({
      args: pendingIds,
      sql: `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id IN (${inPlaceholders(pendingIds)}) ORDER BY id`,
    });
    expect(result.rows.map((row) => String(row.id))).toEqual(
      [...pendingIds].sort(),
    );
    const marker = await getDb().execute(
      `SELECT value FROM settings WHERE key = '${LATEST_DB_UPDATE_KEY}'`,
    );
    expect(marker.rows[0]?.value).toBe(LATEST_UPDATE);
  });
});
