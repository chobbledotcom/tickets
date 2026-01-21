/**
 * Database module for ticket reservation system
 * Uses libsql for SQLite-compatible storage
 */

import { type Client, createClient } from "@libsql/client";
import type { Attendee, Event, EventWithCount, Settings } from "./types.ts";

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
 * Get admin password from database (always randomly generated)
 * The ADMIN_PASSWORD env var is an additional valid password, not a replacement
 */
export const getOrCreateAdminPassword = async (): Promise<string> => {
  // Check database
  const existing = await getSetting("admin_password");
  if (existing) return existing;

  // Generate and store new password
  const password = generatePassword();
  await setSetting("admin_password", password);
  return password;
};

/**
 * Verify admin password
 * Accepts either the ADMIN_PASSWORD env var or the database password
 */
export const verifyAdminPassword = async (
  password: string,
): Promise<boolean> => {
  // Check env var password first
  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword && envPassword.trim() !== "" && password === envPassword) {
    return true;
  }

  // Check database password
  const stored = await getSetting("admin_password");
  return stored === password;
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
