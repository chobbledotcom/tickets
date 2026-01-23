/**
 * Database migrations
 */

import { getDb } from "#lib/db/client.ts";

/**
 * The latest database update identifier - update this when adding new migrations
 */
export const LATEST_UPDATE = "added active column to events";

/**
 * Run a migration that may fail if already applied (e.g., adding a column that exists)
 */
const runMigration = async (sql: string): Promise<void> => {
  try {
    await getDb().execute(sql);
  } catch {
    // Migration already applied, ignore error
  }
};

/**
 * Check if database is already up to date by reading from settings table
 */
const isDbUpToDate = async (): Promise<boolean> => {
  try {
    const result = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'latest_db_update'",
    );
    return result.rows[0]?.value === LATEST_UPDATE;
  } catch {
    // Table doesn't exist or other error, need to run migrations
    return false;
  }
};

/**
 * Initialize database tables
 */
export const initDb = async (): Promise<void> => {
  // Check if database is already up to date - bail early if so
  if (await isDbUpToDate()) {
    return;
  }

  const client = getDb();

  // Create settings table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Create events table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      max_attendees INTEGER NOT NULL,
      thank_you_url TEXT NOT NULL,
      unit_price INTEGER
    )
  `);

  // Migration: add unit_price column if it doesn't exist (for existing databases)
  await runMigration("ALTER TABLE events ADD COLUMN unit_price INTEGER");

  // Create attendees table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created TEXT NOT NULL,
      stripe_payment_id TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Migration: add stripe_payment_id column if it doesn't exist (for existing databases)
  await runMigration("ALTER TABLE attendees ADD COLUMN stripe_payment_id TEXT");

  // Migration: add quantity column to attendees (default 1 for existing records)
  await runMigration(
    "ALTER TABLE attendees ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1",
  );

  // Migration: add max_quantity column to events (default 1 for existing records)
  await runMigration(
    "ALTER TABLE events ADD COLUMN max_quantity INTEGER NOT NULL DEFAULT 1",
  );

  // Migration: add webhook_url column to events (optional webhook for registration notifications)
  await runMigration("ALTER TABLE events ADD COLUMN webhook_url TEXT");

  // Create sessions table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires INTEGER NOT NULL
    )
  `);

  // Migration: add csrf_token column if it doesn't exist (for existing databases)
  await runMigration(
    "ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''",
  );

  // Migration: add active column to events (default true for existing events)
  await runMigration(
    "ALTER TABLE events ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
  );

  // Create login_attempts table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `);

  // Update the version marker
  await client.execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
    args: [LATEST_UPDATE],
  });
};
