/**
 * Database migrations
 */

import { getDb } from "../client.ts";

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
 * Initialize database tables
 */
export const initDb = async (): Promise<void> => {
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

  // Create login_attempts table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `);
};
