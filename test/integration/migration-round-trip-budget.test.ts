import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { executeBatch, getDb, inPlaceholders } from "#shared/db/client.ts";
import { loadMigrations } from "#shared/db/migrations/context.ts";
import { MigrationInProgressError } from "#shared/db/migrations/errors.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  MIGRATION_LOCK_KEY,
  SCHEMA_MIGRATIONS_TABLE,
} from "#shared/db/migrations/schema/version.ts";
import {
  initDb,
  invalidateInitDbCache,
  LATEST_UPDATE,
  type Migration,
} from "#shared/db/migrations.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { restoreSchemaBeforeMigrations } from "#test/integration/db/migration-restore/helpers.ts";
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

/** Roll the live database back to just before the named migration and forget
 *  its marker, so it is the one outstanding migration on the next boot. */
const makeSoleMigrationPending = async (id: string): Promise<Migration> => {
  const migration = MIGRATIONS.find((entry) => entry.id === id);
  if (!migration) throw new Error(`Missing migration ${id}`);
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
  return migration;
};

describeWithEnv("migration request round-trip budget", { db: true }, () => {
  test("records the free-text migration within one guarded request", async () => {
    const migration = await makeSoleMigrationPending(FREE_TEXT_MIGRATION_ID);

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

  test("a migration too large for one request fails loudly and hands back the lock", async () => {
    const migration = await makeSoleMigrationPending(FREE_TEXT_MIGRATION_ID);

    // Squeeze the request so even this one migration cannot finish. Rather than
    // spin forever making no progress, it must fail with a clear "split it"
    // error — and still hand the lock back so the site is not stuck.
    const tinyBudget = { database: 15, external: 15, total: 15 };
    await expect(
      runWithSubrequestBudget(() =>
        runWithQueryLogContext(() =>
          withSubrequestAllowance(tinyBudget, () => initDb()),
        ),
      ),
    ).rejects.toThrow(
      /needs more database round-trips than a single request allows/,
    );

    const lock = await getDb().execute(
      `SELECT 1 FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
    );
    expect(lock.rows).toHaveLength(0);
    const stillPending = await getDb().execute({
      args: [migration.id],
      sql: `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
    });
    expect(stillPending.rows).toHaveLength(0);
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

    // How many of the pending migrations are recorded so far — the request's
    // forward progress.
    const recordedCount = async (): Promise<number> => {
      const rows = await getDb().execute({
        args: pendingIds,
        sql: `SELECT COUNT(*) AS n FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE id IN (${inPlaceholders(pendingIds)})`,
      });
      return Number(rows.rows[0]?.n);
    };
    const lockHeld = async (): Promise<boolean> => {
      const rows = await getDb().execute(
        `SELECT 1 FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
      );
      return rows.rows.length > 0;
    };

    // Each reload is a full production request: subrequest budget plus query
    // log. A behind schema must advance on every reload and never leave the
    // lock held (which would turn the next reload away until the lock's TTL).
    let continuations = 0;
    let finished = false;
    let progress = 0;
    for (let attempt = 0; attempt < pendingIds.length; attempt += 1) {
      try {
        await runWithSubrequestBudget(() =>
          runWithQueryLogContext(() => initDb()),
        );
        finished = true;
        break;
      } catch (error) {
        expect(error).toBeInstanceOf(MigrationInProgressError);
        continuations += 1;
        // The lock is handed back so the very next reload continues at once.
        expect(await lockHeld()).toBe(false);
        // Real progress each reload — never the same batch re-run forever.
        const recorded = await recordedCount();
        expect(recorded).toBeGreaterThan(progress);
        progress = recorded;
      }
    }
    expect(finished).toBe(true);
    // It genuinely spanned several reloads (the batch does not fit one request)
    // yet converged in far fewer than one-migration-per-reload.
    expect(continuations).toBeGreaterThan(0);
    expect(continuations).toBeLessThan(pendingIds.length);
    expect(await lockHeld()).toBe(false);

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
