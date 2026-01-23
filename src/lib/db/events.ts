/**
 * Events table operations
 */

import type { InValue } from "@libsql/client";
import type { Event, EventWithCount } from "../types.ts";
import { getDb, queryOne } from "./client.ts";

/** Event input fields for create/update */
export type EventInput = {
  name: string;
  description: string;
  maxAttendees: number;
  thankYouUrl: string;
  unitPrice?: number | null;
  maxQuantity?: number;
};

/**
 * Create a new event
 */
export const createEvent = async (e: EventInput): Promise<Event> => {
  const created = new Date().toISOString();
  const maxQuantity = e.maxQuantity ?? 1;
  const args: InValue[] = [
    created,
    e.name,
    e.description,
    e.maxAttendees,
    e.thankYouUrl,
    e.unitPrice ?? null,
    maxQuantity,
  ];
  const result = await getDb().execute({
    sql: `INSERT INTO events (created, name, description, max_attendees, thank_you_url, unit_price, max_quantity)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args,
  });
  return {
    id: Number(result.lastInsertRowid),
    created,
    name: e.name,
    description: e.description,
    max_attendees: e.maxAttendees,
    thank_you_url: e.thankYouUrl,
    unit_price: e.unitPrice ?? null,
    max_quantity: maxQuantity,
  };
};

/**
 * Update an existing event
 */
export const updateEvent = async (
  id: number,
  e: EventInput,
): Promise<Event | null> => {
  const args: InValue[] = [
    e.name,
    e.description,
    e.maxAttendees,
    e.thankYouUrl,
    e.unitPrice ?? null,
    e.maxQuantity ?? 1,
    id,
  ];
  const result = await getDb().execute({
    sql: `UPDATE events SET name = ?, description = ?, max_attendees = ?, thank_you_url = ?, unit_price = ?, max_quantity = ?
          WHERE id = ?`,
    args,
  });
  if (result.rowsAffected === 0) return null;
  return getEvent(id);
};

/**
 * Get all events with attendee counts (sum of quantities)
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
 * Get a single event by ID
 */
export const getEvent = async (id: number): Promise<Event | null> =>
  queryOne<Event>("SELECT * FROM events WHERE id = ?", [id]);

/**
 * Get event with attendee count (sum of quantities)
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
