/**
 * Database migrations
 */

import { getDb } from "#lib/db/client.ts";

/**
 * The latest database update identifier - update this when changing schema
 */
export const LATEST_UPDATE = "consolidated schema v1";

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
      thank_you_url TEXT,
      unit_price INTEGER,
      max_quantity INTEGER NOT NULL DEFAULT 1,
      webhook_url TEXT,
      slug TEXT,
      slug_index TEXT,
      active INTEGER NOT NULL DEFAULT 1
    )
  `);

  // Create index on slug_index for fast lookups
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug_index ON events(slug_index)
  `);

  // Create attendees table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created TEXT NOT NULL,
      stripe_payment_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Create sessions table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires INTEGER NOT NULL,
      wrapped_data_key TEXT
    )
  `);

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
