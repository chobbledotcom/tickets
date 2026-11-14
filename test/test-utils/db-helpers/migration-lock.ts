import { sql } from "#db/sql.ts";
/**
 * Serve requests while a database migration lock is held — the state the
 * migration-in-progress page answers.
 */

/** Run `run` while a migration lock is held. A stale schema hash makes the
 * next initDb run its migration check, and the lock row makes that check
 * report a migration in progress. The reset restores both rows, so the
 * caller's suite keeps a migrated database. */
export const withMigrationLock = async (
  run: () => Promise<void>,
): Promise<void> => {
  // Dynamic imports: test-utils preloads this file into every test file, and
  // the migrations module stays out of that shared module load.
  const { getDb } = await import("#db/client.ts");
  const { invalidateInitDbCache, SCHEMA_HASH } = await import(
    "#db/migrations.ts"
  );
  const db = getDb();
  try {
    await db.execute(
      sql`UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'`,
    );
    await db.execute(
      sql`INSERT INTO settings (key, value) VALUES (${"migration_lock"}, ${new Date().toISOString()})`,
    );
    invalidateInitDbCache();

    await run();
  } finally {
    await db.execute(sql`DELETE FROM settings WHERE key = 'migration_lock'`);
    await db.execute(
      sql`UPDATE settings SET value = ${SCHEMA_HASH} WHERE key = 'db_schema_hash'`,
    );
    invalidateInitDbCache();
  }
};
