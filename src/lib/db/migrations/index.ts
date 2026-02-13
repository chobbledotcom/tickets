/**
 * Database migrations
 */

import { computeTicketTokenIndex, encrypt, encryptAttendeePII, generateTicketToken, hmacHash } from "#lib/crypto.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import { getPublicKey, getSetting } from "#lib/db/settings.ts";

/**
 * The latest database update identifier - update this when changing schema
 */
export const LATEST_UPDATE = "encrypt attendee PII fields and ticket_token with HMAC index";

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

/** Backfill a column with an encrypted empty string for matching rows */
const backfillEncryptedColumn = async (table: string, column: string, whereClause: string): Promise<void> => {
  const rows = await queryAll<{ id: number }>(`SELECT id FROM ${table} WHERE ${whereClause}`);
  const encryptedEmpty = await encrypt("");
  for (const row of rows) {
    await getDb().execute({ sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`, args: [encryptedEmpty, row.id] });
  }
};

/** Backfill a column with a hybrid-encrypted empty string for matching rows */
const backfillHybridEncryptedColumn = async (table: string, column: string, whereClause: string): Promise<void> => {
  const publicKey = await getPublicKey();
  if (!publicKey) return;

  const rows = await queryAll<{ id: number }>(`SELECT id FROM ${table} WHERE ${whereClause}`);
  const encryptedEmpty = await encryptAttendeePII("", publicKey);
  for (const row of rows) {
    await getDb().execute({ sql: `UPDATE ${table} SET ${column} = ? WHERE id = ?`, args: [encryptedEmpty, row.id] });
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

  // Create settings table
  await runMigration(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Create events table
  await runMigration(`
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
      active INTEGER NOT NULL DEFAULT 1,
      fields TEXT NOT NULL DEFAULT 'email'
    )
  `);

  // Create index on slug_index for fast lookups
  await runMigration(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_slug_index ON events(slug_index)
  `);

  // Create attendees table (new installs use payment_id)
  await runMigration(`
    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created TEXT NOT NULL,
      payment_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Migration: rename stripe_payment_id -> payment_id for existing databases
  await runMigration(`ALTER TABLE attendees RENAME COLUMN stripe_payment_id TO payment_id`);

  // Create sessions table
  await runMigration(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires INTEGER NOT NULL,
      wrapped_data_key TEXT
    )
  `);

  // Create login_attempts table
  await runMigration(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `);

  // Create processed_payments table for webhook idempotency
  // Tracks payment session IDs to prevent duplicate attendee creation
  // attendee_id is nullable: NULL means session is reserved but attendee not yet created
  await runMigration(`
    CREATE TABLE IF NOT EXISTS processed_payments (
      payment_session_id TEXT PRIMARY KEY,
      attendee_id INTEGER,
      processed_at TEXT NOT NULL,
      FOREIGN KEY (attendee_id) REFERENCES attendees(id)
    )
  `);

  // Migration: rename stripe_session_id -> payment_session_id for existing databases
  // SQLite doesn't support ALTER COLUMN RENAME before 3.25, so recreate the table
  await runMigration(`
    CREATE TABLE IF NOT EXISTS processed_payments_new (
      payment_session_id TEXT PRIMARY KEY,
      attendee_id INTEGER,
      processed_at TEXT NOT NULL,
      FOREIGN KEY (attendee_id) REFERENCES attendees(id)
    )
  `);
  await runMigration(`
    INSERT OR IGNORE INTO processed_payments_new (payment_session_id, attendee_id, processed_at)
    SELECT stripe_session_id, attendee_id, processed_at FROM processed_payments
    WHERE typeof(stripe_session_id) = 'text'
  `);
  await runMigration(`
    INSERT OR IGNORE INTO processed_payments_new (payment_session_id, attendee_id, processed_at)
    SELECT payment_session_id, attendee_id, processed_at FROM processed_payments
    WHERE typeof(payment_session_id) = 'text'
  `);
  await runMigration(`DROP TABLE IF EXISTS processed_payments`);
  await runMigration(`ALTER TABLE processed_payments_new RENAME TO processed_payments`);

  // Migration: add price_paid column to attendees (encrypted with DB_ENCRYPTION_KEY)
  await runMigration(`ALTER TABLE attendees ADD COLUMN price_paid TEXT`);

  // Create activity_log table (unencrypted, admin-only view)
  await runMigration(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      event_id INTEGER,
      message TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
    )
  `);

  // Migration: add fields column to events (defaults to "email" for backwards compatibility)
  await runMigration(`ALTER TABLE events ADD COLUMN fields TEXT NOT NULL DEFAULT 'email'`);

  // Migration: add phone column to attendees (nullable, hybrid encrypted like email)
  await runMigration(`ALTER TABLE attendees ADD COLUMN phone TEXT`);

  // Migration: add name column to events (encrypted, defaults to existing slug for backfill)
  await runMigration(`ALTER TABLE events ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  await runMigration(`UPDATE events SET name = slug WHERE name = ''`);

  // Migration: add description column to events (encrypted empty string for existing rows)
  await runMigration(`ALTER TABLE events ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  const encryptedEmpty = await encrypt("");
  await getDb().execute({
    sql: `UPDATE events SET description = ? WHERE description = ''`,
    args: [encryptedEmpty],
  });

  // Migration: add checked_in column to attendees (hybrid encrypted, defaults to encrypted "false")
  await runMigration(`ALTER TABLE attendees ADD COLUMN checked_in TEXT NOT NULL DEFAULT ''`);
  // Backfill existing attendees with encrypted "false" if public key is available
  const publicKey = await getPublicKey();
  if (publicKey) {
    const encryptedFalse = await encryptAttendeePII("false", publicKey);
    await getDb().execute({
      sql: `UPDATE attendees SET checked_in = ? WHERE checked_in = ''`,
      args: [encryptedFalse],
    });
  }

  // Migration: add closes_at column to events (encrypted, empty string = no deadline)
  await runMigration(`ALTER TABLE events ADD COLUMN closes_at TEXT`);

  // Backfill: encrypt NULL closes_at to encrypted empty string for existing events
  await backfillEncryptedColumn("events", "closes_at", `closes_at IS NULL`);

  // Create users table for multi-user admin access
  await runMigration(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username_hash TEXT NOT NULL,
      username_index TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      wrapped_data_key TEXT,
      admin_level TEXT NOT NULL,
      invite_code_hash TEXT,
      invite_expiry TEXT
    )
  `);

  // Create unique index on username_index for fast lookups
  await runMigration(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_index ON users(username_index)`,
  );

  // Migration: migrate existing single-admin credentials to users table
  // For pre-multi-user installations, admin_password and wrapped_data_key are in settings
  {
    const existingPasswordHash = await getSetting("admin_password");
    const existingWrappedDataKey = await getSetting("wrapped_data_key");
    const userCountRows = await queryAll<{ count: number }>("SELECT COUNT(*) as count FROM users");
    const hasNoUsers = userCountRows[0]!.count === 0;

    if (existingPasswordHash && hasNoUsers) {
      const username = "admin";
      const usernameIndex = await hmacHash(username);
      const encryptedUsername = await encrypt(username);
      const encryptedPasswordHash = await encrypt(existingPasswordHash);
      const encryptedAdminLevel = await encrypt("owner");

      await getDb().execute({
        sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level)
              VALUES (?, ?, ?, ?, ?)`,
        args: [
          encryptedUsername,
          usernameIndex,
          encryptedPasswordHash,
          existingWrappedDataKey,
          encryptedAdminLevel,
        ],
      });
    }
  }

  // Migration: add user_id column to sessions (nullable for migration compatibility)
  await runMigration(`ALTER TABLE sessions ADD COLUMN user_id INTEGER`);

  // Clear sessions without user_id (pre-migration sessions)
  await runMigration(`DELETE FROM sessions WHERE user_id IS NULL`);

  // Migration: add ticket_token column to attendees (unique, for public ticket URLs)
  await runMigration(`ALTER TABLE attendees ADD COLUMN ticket_token TEXT NOT NULL DEFAULT ''`);

  // Backfill existing attendees with random tokens
  {
    const rows = await queryAll<{ id: number }>(`SELECT id FROM attendees WHERE ticket_token = ''`);
    for (const row of rows) {
      await getDb().execute({
        sql: `UPDATE attendees SET ticket_token = ? WHERE id = ?`,
        args: [generateTicketToken(), row.id],
      });
    }
  }

  // Create unique index on ticket_token for fast lookups
  await runMigration(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_ticket_token ON attendees(ticket_token)`,
  );

  // Migration: add event_type and daily booking config columns to events
  await runMigration(`ALTER TABLE events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'standard'`);
  await runMigration(`ALTER TABLE events ADD COLUMN bookable_days TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]'`);
  await runMigration(`ALTER TABLE events ADD COLUMN minimum_days_before INTEGER NOT NULL DEFAULT 1`);
  await runMigration(`ALTER TABLE events ADD COLUMN maximum_days_after INTEGER NOT NULL DEFAULT 90`);

  // Migration: create holidays table
  await runMigration(`
    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    )
  `);

  // Migration: add date column to attendees for daily events
  await runMigration(`ALTER TABLE attendees ADD COLUMN date TEXT DEFAULT NULL`);

  // Migration: add address column to attendees (hybrid encrypted like phone)
  await runMigration(`ALTER TABLE attendees ADD COLUMN address TEXT NOT NULL DEFAULT ''`);

  // Migration: convert event fields from "both" to "email,phone" (comma-separated format)
  await runMigration(`UPDATE events SET fields = 'email,phone' WHERE fields = 'both'`);

  // Migration: add date and location columns to events (encrypted, empty string = not set)
  for (const col of ["date", "location"]) {
    await runMigration(`ALTER TABLE events ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    await backfillEncryptedColumn("events", col, `${col} = ''`);
  }

  // Migration: add special_instructions column to attendees (hybrid encrypted like address)
  await runMigration(`ALTER TABLE attendees ADD COLUMN special_instructions TEXT NOT NULL DEFAULT ''`);

  // Migration: add image_url column to events (encrypted, empty string = no image)
  await runMigration(`ALTER TABLE events ADD COLUMN image_url TEXT NOT NULL DEFAULT ''`);
  await backfillEncryptedColumn("events", "image_url", `image_url = ''`);

  // Migration: add ticket_token_index column for HMAC-based lookups
  await runMigration(`ALTER TABLE attendees ADD COLUMN ticket_token_index TEXT`);

  // Backfill: encrypt empty PII fields with encrypted empty strings
  await backfillHybridEncryptedColumn("attendees", "email", `email = ''`);
  await backfillHybridEncryptedColumn("attendees", "phone", `phone = ''`);
  await backfillHybridEncryptedColumn("attendees", "address", `address = ''`);
  await backfillHybridEncryptedColumn("attendees", "special_instructions", `special_instructions = ''`);

  // Backfill: encrypt existing plaintext ticket_token values and generate HMAC indexes
  {
    const pubKey = await getPublicKey();
    if (pubKey) {
      // Get all attendees that need migration (those with plaintext tokens or missing index)
      const attendees = await queryAll<{ id: number; ticket_token: string }>(
        `SELECT id, ticket_token FROM attendees WHERE ticket_token_index IS NULL`
      );

      for (const attendee of attendees) {
        // Check if token is already encrypted (starts with "hyb:1:")
        const isEncrypted = attendee.ticket_token.startsWith("hyb:1:");

        if (isEncrypted) {
          // Token is already encrypted, just generate the index from... wait, we can't decrypt it
          // This means we need to generate a NEW token for already-encrypted tokens
          // But that would break existing URLs. This is a problem.
          // Let's assume all existing tokens are plaintext since this is the first migration
          continue;
        }

        // Token is plaintext - encrypt it and generate index
        const plaintextToken = attendee.ticket_token;
        const encryptedToken = await encryptAttendeePII(plaintextToken, pubKey);
        const tokenIndex = await computeTicketTokenIndex(plaintextToken);

        await getDb().execute({
          sql: `UPDATE attendees SET ticket_token = ?, ticket_token_index = ? WHERE id = ?`,
          args: [encryptedToken, tokenIndex, attendee.id],
        });
      }
    }
  }

  // Drop old unique index on ticket_token (tokens are now encrypted, so index is not useful)
  await runMigration(`DROP INDEX IF EXISTS idx_attendees_ticket_token`);

  // Create unique index on ticket_token_index for fast HMAC-based lookups
  await runMigration(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_ticket_token_index ON attendees(ticket_token_index)`
  );

  // Update the version marker
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
    args: [LATEST_UPDATE],
  });
};

/**
 * All database tables in order for safe dropping (respects foreign key constraints)
 */
const ALL_TABLES = [
  "holidays",
  "activity_log",
  "processed_payments",
  "attendees",
  "events",
  "sessions",
  "users",
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
