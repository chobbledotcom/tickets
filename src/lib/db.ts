/**
 * Database module for ticket reservation system
 * Uses libsql for SQLite-compatible storage
 */

import { type Client, createClient } from "@libsql/client";
import type {
  Attendee,
  Event,
  EventWithCount,
  Session,
  Settings,
} from "./types.ts";

let db: Client | null = null;

/**
 * Get or create database client
 */
export const getDb = (): Client => {
  if (!db) {
    const url = process.env.DB_URL;
    if (!url) {
      throw new Error("DB_URL environment variable is required");
    }
    db = createClient({
      url,
      authToken: process.env.DB_TOKEN,
      encryptionKey: process.env.DB_ENCRYPTION_KEY,
    });
  }
  return db;
};

/**
 * Set database client (for testing)
 */
export const setDb = (client: Client | null): void => {
  db = client;
};

/**
 * Generate a random password
 */
export const generatePassword = (): string => {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
};

/**
 * Initialize database tables
 */
export const initDb = async (): Promise<void> => {
  const client = getDb();

  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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
  try {
    await client.execute("ALTER TABLE events ADD COLUMN unit_price INTEGER");
  } catch {
    // Column already exists, ignore error
  }

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
  try {
    await client.execute(
      "ALTER TABLE attendees ADD COLUMN stripe_payment_id TEXT",
    );
  } catch {
    // Column already exists, ignore error
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires INTEGER NOT NULL
    )
  `);

  // Migration: add csrf_token column if it doesn't exist (for existing databases)
  try {
    await client.execute(
      "ALTER TABLE sessions ADD COLUMN csrf_token TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists, ignore error
  }

  await client.execute(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `);
};

/**
 * Get a setting value
 */
export const getSetting = async (key: string): Promise<string | null> => {
  const result = await getDb().execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [key],
  });
  if (result.rows.length === 0) return null;
  return (result.rows[0] as unknown as Settings).value;
};

/**
 * Set a setting value
 */
export const setSetting = async (key: string, value: string): Promise<void> => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    args: [key, value],
  });
};

/**
 * Setting keys for configuration
 */
export const CONFIG_KEYS = {
  ADMIN_PASSWORD: "admin_password",
  STRIPE_KEY: "stripe_key",
  CURRENCY_CODE: "currency_code",
  SETUP_COMPLETE: "setup_complete",
} as const;

/**
 * Check if initial setup has been completed
 */
export const isSetupComplete = async (): Promise<boolean> => {
  const value = await getSetting(CONFIG_KEYS.SETUP_COMPLETE);
  return value === "true";
};

/**
 * Complete initial setup by storing all configuration
 * Passwords are hashed using Argon2id before storage
 */
export const completeSetup = async (
  adminPassword: string,
  stripeSecretKey: string | null,
  currencyCode: string,
): Promise<void> => {
  const hashedPassword = await Bun.password.hash(adminPassword);
  await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, hashedPassword);
  if (stripeSecretKey) {
    await setSetting(CONFIG_KEYS.STRIPE_KEY, stripeSecretKey);
  }
  await setSetting(CONFIG_KEYS.CURRENCY_CODE, currencyCode);
  await setSetting(CONFIG_KEYS.SETUP_COMPLETE, "true");
};

/**
 * Get Stripe secret key from database
 */
export const getStripeSecretKeyFromDb = async (): Promise<string | null> => {
  return getSetting(CONFIG_KEYS.STRIPE_KEY);
};

/**
 * Get currency code from database
 */
export const getCurrencyCodeFromDb = async (): Promise<string> => {
  const value = await getSetting(CONFIG_KEYS.CURRENCY_CODE);
  return value || "GBP";
};

/**
 * Get admin password from database
 * Returns null if setup hasn't been completed
 */
export const getAdminPasswordFromDb = async (): Promise<string | null> => {
  return getSetting(CONFIG_KEYS.ADMIN_PASSWORD);
};

/**
 * Get admin password from database (for backwards compatibility)
 * Falls back to generating a random password if not set (pre-setup mode)
 * Returns the plaintext password only when newly generated (for display)
 */
export const getOrCreateAdminPassword = async (): Promise<string> => {
  const existing = await getSetting(CONFIG_KEYS.ADMIN_PASSWORD);
  if (existing) return existing;

  // Generate and store new password (fallback for tests/dev)
  const password = generatePassword();
  const hashedPassword = await Bun.password.hash(password);
  await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, hashedPassword);
  return password;
};

/**
 * Verify admin password using constant-time comparison
 * Checks the database-stored password hash only
 */
export const verifyAdminPassword = async (
  password: string,
): Promise<boolean> => {
  const stored = await getSetting(CONFIG_KEYS.ADMIN_PASSWORD);
  if (stored === null) return false;
  return Bun.password.verify(password, stored);
};

/**
 * Update admin password and invalidate all existing sessions
 * Passwords are hashed using Argon2id before storage
 */
export const updateAdminPassword = async (
  newPassword: string,
): Promise<void> => {
  const hashedPassword = await Bun.password.hash(newPassword);
  await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, hashedPassword);
  await deleteAllSessions();
};

/**
 * Create a new event
 */
export const createEvent = async (
  name: string,
  description: string,
  maxAttendees: number,
  thankYouUrl: string,
  unitPrice: number | null = null,
): Promise<Event> => {
  const created = new Date().toISOString();
  const result = await getDb().execute({
    sql: `INSERT INTO events (created, name, description, max_attendees, thank_you_url, unit_price)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [created, name, description, maxAttendees, thankYouUrl, unitPrice],
  });
  return {
    id: Number(result.lastInsertRowid),
    created,
    name,
    description,
    max_attendees: maxAttendees,
    thank_you_url: thankYouUrl,
    unit_price: unitPrice,
  };
};

/**
 * Update an existing event
 */
export const updateEvent = async (
  id: number,
  name: string,
  description: string,
  maxAttendees: number,
  thankYouUrl: string,
  unitPrice: number | null = null,
): Promise<Event | null> => {
  const result = await getDb().execute({
    sql: `UPDATE events SET name = ?, description = ?, max_attendees = ?, thank_you_url = ?, unit_price = ?
          WHERE id = ?`,
    args: [name, description, maxAttendees, thankYouUrl, unitPrice, id],
  });
  if (result.rowsAffected === 0) return null;
  return getEvent(id);
};

/**
 * Get all events with attendee counts
 */
export const getAllEvents = async (): Promise<EventWithCount[]> => {
  const result = await getDb().execute(`
    SELECT e.*, COUNT(a.id) as attendee_count
    FROM events e
    LEFT JOIN attendees a ON e.id = a.event_id
    GROUP BY e.id
    ORDER BY e.created DESC
  `);
  return result.rows as unknown as EventWithCount[];
};

/**
 * Get a single event by ID
 */
export const getEvent = async (id: number): Promise<Event | null> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM events WHERE id = ?",
    args: [id],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Event;
};

/**
 * Get event with attendee count
 */
export const getEventWithCount = async (
  id: number,
): Promise<EventWithCount | null> => {
  const result = await getDb().execute({
    sql: `SELECT e.*, COUNT(a.id) as attendee_count
          FROM events e
          LEFT JOIN attendees a ON e.id = a.event_id
          WHERE e.id = ?
          GROUP BY e.id`,
    args: [id],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as EventWithCount;
};

/**
 * Get attendees for an event
 */
export const getAttendees = async (eventId: number): Promise<Attendee[]> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    args: [eventId],
  });
  return result.rows as unknown as Attendee[];
};

/**
 * Create a new attendee (reserve a ticket)
 */
export const createAttendee = async (
  eventId: number,
  name: string,
  email: string,
  stripePaymentId: string | null = null,
): Promise<Attendee> => {
  const created = new Date().toISOString();
  const result = await getDb().execute({
    sql: "INSERT INTO attendees (event_id, name, email, created, stripe_payment_id) VALUES (?, ?, ?, ?, ?)",
    args: [eventId, name, email, created, stripePaymentId],
  });
  return {
    id: Number(result.lastInsertRowid),
    event_id: eventId,
    name,
    email,
    created,
    stripe_payment_id: stripePaymentId,
  };
};

/**
 * Get an attendee by ID
 */
export const getAttendee = async (id: number): Promise<Attendee | null> => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE id = ?",
    args: [id],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Attendee;
};

/**
 * Update attendee's Stripe payment ID
 */
export const updateAttendeePayment = async (
  attendeeId: number,
  stripePaymentId: string,
): Promise<void> => {
  await getDb().execute({
    sql: "UPDATE attendees SET stripe_payment_id = ? WHERE id = ?",
    args: [stripePaymentId, attendeeId],
  });
};

/**
 * Delete an attendee (for cleanup on payment failure)
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM attendees WHERE id = ?",
    args: [attendeeId],
  });
};

/**
 * Check if event has available spots
 */
export const hasAvailableSpots = async (eventId: number): Promise<boolean> => {
  const event = await getEventWithCount(eventId);
  if (!event) return false;
  return event.attendee_count < event.max_attendees;
};

/**
 * Create a new session with CSRF token
 */
export const createSession = async (
  token: string,
  csrfToken: string,
  expires: number,
): Promise<void> => {
  await getDb().execute({
    sql: "INSERT INTO sessions (token, csrf_token, expires) VALUES (?, ?, ?)",
    args: [token, csrfToken, expires],
  });
};

/**
 * Get a session by token
 */
export const getSession = async (token: string): Promise<Session | null> => {
  const result = await getDb().execute({
    sql: "SELECT token, csrf_token, expires FROM sessions WHERE token = ?",
    args: [token],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0] as unknown as Session;
};

/**
 * Delete a session by token
 */
export const deleteSession = async (token: string): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE token = ?",
    args: [token],
  });
};

/**
 * Delete all expired sessions
 */
export const deleteExpiredSessions = async (): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM sessions WHERE expires < ?",
    args: [Date.now()],
  });
};

/**
 * Delete all sessions (used when password is changed)
 */
export const deleteAllSessions = async (): Promise<void> => {
  await getDb().execute("DELETE FROM sessions");
};

/**
 * Rate limiting constants
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Check if IP is rate limited for login
 */
export const isLoginRateLimited = async (ip: string): Promise<boolean> => {
  const result = await getDb().execute({
    sql: "SELECT attempts, locked_until FROM login_attempts WHERE ip = ?",
    args: [ip],
  });

  if (result.rows.length === 0) return false;

  const row = result.rows[0] as unknown as {
    attempts: number;
    locked_until: number | null;
  };

  // Check if currently locked out
  if (row.locked_until && row.locked_until > Date.now()) {
    return true;
  }

  // If lockout expired, reset
  if (row.locked_until && row.locked_until <= Date.now()) {
    await getDb().execute({
      sql: "DELETE FROM login_attempts WHERE ip = ?",
      args: [ip],
    });
    return false;
  }

  return false;
};

/**
 * Record a failed login attempt
 * Returns true if the account is now locked
 */
export const recordFailedLogin = async (ip: string): Promise<boolean> => {
  const result = await getDb().execute({
    sql: "SELECT attempts FROM login_attempts WHERE ip = ?",
    args: [ip],
  });

  const currentAttempts =
    result.rows.length > 0
      ? (result.rows[0] as unknown as { attempts: number }).attempts
      : 0;
  const newAttempts = currentAttempts + 1;

  if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
    const lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    await getDb().execute({
      sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, ?)",
      args: [ip, newAttempts, lockedUntil],
    });
    return true;
  }

  await getDb().execute({
    sql: "INSERT OR REPLACE INTO login_attempts (ip, attempts, locked_until) VALUES (?, ?, NULL)",
    args: [ip, newAttempts],
  });
  return false;
};

/**
 * Clear login attempts for an IP (on successful login)
 */
export const clearLoginAttempts = async (ip: string): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM login_attempts WHERE ip = ?",
    args: [ip],
  });
};
