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
      "UPDATE settings SET value = 'stale' WHERE key = 'db_schema_hash'",
    );
    await db.execute({
      args: ["migration_lock", new Date().toISOString()],
      sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
    });
    invalidateInitDbCache();

    await run();
  } finally {
    await db.execute("DELETE FROM settings WHERE key = 'migration_lock'");
    await db.execute({
      args: [SCHEMA_HASH],
      sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
    });
    invalidateInitDbCache();
  }
};
