/**
 * Database migrations
 */

import { getDb } from "#lib/db/client.ts";

/**
 * The latest database update identifier - update this when adding new migrations
 */
export const LATEST_UPDATE = "drop name and description columns";

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

  // Migration: add slug column to events (unique identifier for public URLs)
  await runMigration("ALTER TABLE events ADD COLUMN slug TEXT");

  // Migration: create index on slug for fast lookups (legacy, slug is now encrypted)
  await runMigration(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug ON events(slug)",
  );

  // Migration: add slug_index column for blind index lookup (slug is now encrypted)
  await runMigration("ALTER TABLE events ADD COLUMN slug_index TEXT");

  // Migration: create index on slug_index for fast lookups
  await runMigration(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug_index ON events(slug_index)",
  );

  // Migration: add active column to events (default true for existing events)
  await runMigration(
    "ALTER TABLE events ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
  );

  // Migration: drop legacy name and description columns (no longer used)
  await runMigration("ALTER TABLE events DROP COLUMN name");
  await runMigration("ALTER TABLE events DROP COLUMN description");

  // Migration: add wrapped_data_key column to sessions (per-session encryption key)
  // Note: token column now stores hashed tokens, old unhashed tokens will be invalid
  await runMigration("ALTER TABLE sessions ADD COLUMN wrapped_data_key TEXT");

  // Create login_attempts table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `);

  // Create processed_payments table for webhook idempotency
  // Tracks Stripe session IDs to prevent duplicate attendee creation
  await client.execute(`
    CREATE TABLE IF NOT EXISTS processed_payments (
      stripe_session_id TEXT PRIMARY KEY,
      attendee_id INTEGER NOT NULL,
      processed_at TEXT NOT NULL,
      FOREIGN KEY (attendee_id) REFERENCES attendees(id)
    )
  `);

  // Create activity_log table (unencrypted, admin-only view)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      event_id INTEGER,
      message TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
    )
  `);

  // Update the version marker
  await client.execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
    args: [LATEST_UPDATE],
  });
};

/**
 * All database tables in order for safe dropping (respects foreign key constraints)
 */
const ALL_TABLES = [
  "activity_log",
  "processed_payments",
  "attendees",
  "events",
  "sessions",
  "login_attempts",
  "settings",
] as const;

/**
 * Reset the database by dropping all tables
 */
export const resetDatabase = async (): Promise<void> => {
  const client = getDb();
  for (const table of ALL_TABLES) {
    await client.execute(`DROP TABLE IF EXISTS ${table}`);
  }
};
