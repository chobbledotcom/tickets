/**
 * Events table operations
 */

import { executeByField, getDb, queryOne } from "#lib/db/client.ts";
import { col, defineTable } from "#lib/db/table.ts";
import type { Event, EventWithCount } from "#lib/types.ts";

/** Event input fields for create/update (camelCase) */
export type EventInput = {
  name: string;
  description: string;
  maxAttendees: number;
  thankYouUrl: string;
  unitPrice?: number | null;
  maxQuantity?: number;
  webhookUrl?: string | null;
  active?: number;
};

/**
 * Events table definition
 */
export const eventsTable = defineTable<Event, EventInput>({
  name: "events",
  primaryKey: "id",
  schema: {
    id: col.generated<number>(),
    created: col.withDefault(() => new Date().toISOString()),
    name: col.simple<string>(),
    description: col.simple<string>(),
    max_attendees: col.simple<number>(),
    thank_you_url: col.simple<string>(),
    unit_price: col.simple<number | null>(),
    max_quantity: col.withDefault(() => 1),
    webhook_url: col.simple<string | null>(),
    active: col.withDefault(() => 1),
  },
});

/**
 * Create a new event
 */
export const createEvent = (e: EventInput): Promise<Event> =>
  eventsTable.insert(e);

/**
 * Update an existing event
 */
export const updateEvent = (id: number, e: EventInput): Promise<Event | null> =>
  eventsTable.update(id, e);

/**
 * Get a single event by ID
 */
export const getEvent = (id: number): Promise<Event | null> =>
  eventsTable.findById(id);

/**
 * Delete an event and all its attendees
 */
export const deleteEvent = async (eventId: number): Promise<void> => {
  // Delete all attendees for this event first (cascade)
  await executeByField("attendees", "event_id", eventId);
  // Delete the event
  await eventsTable.deleteById(eventId);
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
  return result.rows as unknown as EventWithCount[];
};

/**
 * Get event with attendee count (sum of quantities)
 * Uses custom JOIN query - not covered by table abstraction
 */
export const getEventWithCount = async (
  id: number,
): Promise<EventWithCount | null> =>
  queryOne<EventWithCount>(
    `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
     FROM events e
     LEFT JOIN attendees a ON e.id = a.event_id
     WHERE e.id = ?
     GROUP BY e.id`,
    [id],
  );
