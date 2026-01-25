/**
 * Events table operations
 */

import { decrypt, encrypt, hmacHash } from "#lib/crypto.ts";
import { executeByField, getDb, queryOne } from "#lib/db/client.ts";
import { col, defineTable } from "#lib/db/table.ts";
import type { Event, EventWithCount } from "#lib/types.ts";

/** Event input fields for create/update (camelCase) */
export type EventInput = {
  slug: string;
  slugIndex: string;
  name: string;
  description: string;
  maxAttendees: number;
  thankYouUrl: string;
  unitPrice?: number | null;
  maxQuantity?: number;
  webhookUrl?: string | null;
  active?: number;
};

/** Compute slug index from slug for blind index lookup */
export const computeSlugIndex = (slug: string): Promise<string> =>
  hmacHash(slug);

/**
 * Events table definition
 * name, description, slug are encrypted; slug_index is HMAC for lookups
 */
export const eventsTable = defineTable<Event, EventInput>({
  name: "events",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    slug: col.encrypted<string>(encrypt, decrypt),
    slug_index: col.simple<string>(),
    created: col.withDefault(() => new Date().toISOString()),
    name: col.encrypted<string>(encrypt, decrypt),
    description: col.encrypted<string>(encrypt, decrypt),
    max_attendees: col.simple<number>(),
    thank_you_url: col.simple<string>(),
    unit_price: col.simple<number | null>(),
    max_quantity: col.withDefault(() => 1),
    webhook_url: col.simple<string | null>(),
    active: col.withDefault(() => 1),
  },
});


/**
 * Get a single event by ID
 */
export const getEvent = (id: number): Promise<Event | null> =>
  eventsTable.findById(id);

/**
 * Check if a slug is already in use (optionally excluding a specific event ID)
 * Uses slug_index for lookup (blind index)
 */
export const isSlugTaken = async (
  slug: string,
  excludeEventId?: number,
): Promise<boolean> => {
  const slugIndex = await computeSlugIndex(slug);
  const sql = excludeEventId
    ? "SELECT 1 FROM events WHERE slug_index = ? AND id != ?"
    : "SELECT 1 FROM events WHERE slug_index = ?";
  const args = excludeEventId ? [slugIndex, excludeEventId] : [slugIndex];
  const result = await getDb().execute({ sql, args });
  return result.rows.length > 0;
};

/**
 * Delete an event and all its attendees
 */
export const deleteEvent = async (eventId: number): Promise<void> => {
  // Delete all attendees for this event first (cascade)
  await executeByField("attendees", "event_id", eventId);
  // Delete the event
  await eventsTable.deleteById(eventId);
};

/** Decrypt event fields after raw query (for JOIN queries) */
const decryptEventWithCount = async (
  row: EventWithCount,
): Promise<EventWithCount> => {
  const event = await eventsTable.fromDb(row as unknown as Event);
  return { ...event, attendee_count: row.attendee_count };
};

/**
 * Get all events with attendee counts (sum of quantities)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getAllEvents = async (): Promise<EventWithCount[]> => {
  const result = await getDb().execute(`
    SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
    FROM events e
    LEFT JOIN attendees a ON e.id = a.event_id
    GROUP BY e.id
    ORDER BY e.created DESC
  `);
  const rows = result.rows as unknown as EventWithCount[];
  return Promise.all(rows.map(decryptEventWithCount));
};

/**
 * Get event with attendee count (sum of quantities)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getEventWithCount = async (
  id: number,
): Promise<EventWithCount | null> => {
  const row = await queryOne<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.id = ?
     GROUP BY e.id`,
    [id],
  );
  return row ? decryptEventWithCount(row) : null;
};

/**
 * Get event with attendee count by slug (uses slug_index for lookup)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getEventWithCountBySlug = async (
  slug: string,
): Promise<EventWithCount | null> => {
  const slugIndex = await computeSlugIndex(slug);
  const row = await queryOne<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.slug_index = ?
     GROUP BY e.id`,
    [slugIndex],
  );
  return row ? decryptEventWithCount(row) : null;
};
