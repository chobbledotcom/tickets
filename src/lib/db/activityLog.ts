/**
 * Activity log operations
 *
 * Activity logging for admin visibility.
 * Messages are encrypted - only admins can read them.
 */

import { decrypt, encrypt } from "#lib/crypto.ts";
import { getDb, queryBatch } from "#lib/db/client.ts";
import { eventsTable } from "#lib/db/events.ts";
import type { Event, EventWithCount } from "#lib/types.ts";
import { col, defineTable } from "#lib/db/table.ts";

/** Activity log entry */
export interface ActivityLogEntry {
  id: number;
  created: string;
  event_id: number | null;
  message: string;
}

/** Activity log input for create */
export type ActivityLogInput = {
  eventId?: number | null;
  message: string;
};

/**
 * Activity log table definition
 * message is encrypted - decrypted only for admin view
 */
export const activityLogTable = defineTable<ActivityLogEntry, ActivityLogInput>(
  {
    name: "activity_log",
    primaryKey: "id",
    schema: {
      id: col.generated<number>(),
      created: col.withDefault(() => new Date().toISOString()),
      event_id: col.simple<number | null>(),
      message: col.encrypted<string>(encrypt, decrypt),
    },
  },
);

/**
 * Log an activity
 */
export const logActivity = (
  message: string,
  eventId?: number | null,
): Promise<ActivityLogEntry> =>
  activityLogTable.insert({ message, eventId: eventId ?? null });

/** Query activity log with optional event filter, decrypts messages */
const queryActivityLog = async (
  eventId: number | null,
  limit: number,
): Promise<ActivityLogEntry[]> => {
  const whereClause = eventId !== null ? "WHERE event_id = ?" : "";
  const args = eventId !== null ? [eventId, limit] : [limit];
  const result = await getDb().execute({
    sql: `SELECT * FROM activity_log ${whereClause} ORDER BY created DESC, id DESC LIMIT ?`,
    args,
  });
  const rows = result.rows as unknown as ActivityLogEntry[];
  return Promise.all(rows.map((row) => activityLogTable.fromDb(row)));
};

/**
 * Get activity log entries for an event (most recent first)
 */
export const getEventActivityLog = (
  eventId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> => queryActivityLog(eventId, limit);

/**
 * Get all activity log entries (most recent first)
 */
export const getAllActivityLog = (limit = 100): Promise<ActivityLogEntry[]> =>
  queryActivityLog(null, limit);

/** Result type for event + activity log batch query */
export type EventWithActivityLog = {
  event: EventWithCount;
  entries: ActivityLogEntry[];
};

/**
 * Get event and its activity log in a single database round-trip.
 * Uses batch API to reduce latency for remote databases.
 */
export const getEventWithActivityLog = async (
  eventId: number,
  limit = 100,
): Promise<EventWithActivityLog | null> => {
  const results = await queryBatch([
    {
      sql: `SELECT e.*, COALESCE(SUM(a.quantity), 0) as attendee_count
            FROM events e
            LEFT JOIN attendees a ON e.id = a.event_id
            WHERE e.id = ?
            GROUP BY e.id`,
      args: [eventId],
    },
    {
      sql: `SELECT * FROM activity_log WHERE event_id = ? ORDER BY created DESC, id DESC LIMIT ?`,
      args: [eventId, limit],
    },
  ]);

  const eventRow = results[0]?.rows[0] as unknown as
    | (Event & { attendee_count: number })
    | undefined;
  if (!eventRow) return null;

  // Decrypt event fields
  const decryptedEvent = await eventsTable.fromDb(eventRow as unknown as Event);
  const event: EventWithCount = {
    ...decryptedEvent,
    attendee_count: eventRow.attendee_count,
  };

  const logRows = results[1]?.rows as unknown as ActivityLogEntry[];
  const entries = await Promise.all(
    logRows.map((row) => activityLogTable.fromDb(row)),
  );

  return { event, entries };
};
