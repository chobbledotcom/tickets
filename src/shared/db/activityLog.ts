/**
 * Activity log operations
 *
 * Activity logging for admin visibility.
 * Messages are encrypted - only admins can read them.
 */

import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { queryAll, queryBatch, resultRows } from "#shared/db/client.ts";
import { eventsTable } from "#shared/db/events.ts";
import { col, defineTable } from "#shared/db/table.ts";
import { nowIso } from "#shared/now.ts";
import type { Event, EventWithCount } from "#shared/types.ts";

/** Activity log entry */
export interface ActivityLogEntry {
  created: string;
  event_id: number | null;
  id: number;
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
      created: col.withDefault(() => nowIso()),
      event_id: col.simple<number | null>(),
      id: col.generated<number>(),
      message: col.encrypted<string>(encrypt, decrypt),
    },
  },
);

/** Accept an event ID as a number or an object with `.id` */
type EventRef = number | { id: number };

/** Extract event ID from an EventRef */
const toEventId = (event?: EventRef | null): number | null =>
  event == null ? null : typeof event === "number" ? event : event.id;

/**
 * Log an activity
 */
export const logActivity = (
  message: string,
  event?: EventRef | null,
): Promise<ActivityLogEntry> =>
  activityLogTable.insert({
    eventId: toEventId(event),
    message,
  });

/** Query activity log with optional event filter, decrypts messages */
const queryActivityLog = async (
  eventId: number | null,
  limit: number,
): Promise<ActivityLogEntry[]> => {
  const whereClause = eventId !== null ? "WHERE event_id = ?" : "";
  const args = eventId !== null ? [eventId, limit] : [limit];
  const rows = await queryAll<ActivityLogEntry>(
    `SELECT * FROM activity_log ${whereClause} ORDER BY created DESC, id DESC LIMIT ?`,
    args,
  );
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
      args: [eventId],
      sql: `SELECT e.*, COALESCE(SUM(ea.quantity), 0) as attendee_count
            FROM events e
            LEFT JOIN event_attendees ea ON e.id = ea.event_id
            WHERE e.id = ?
            GROUP BY e.id`,
    },
    {
      args: [eventId, limit],
      sql: "SELECT * FROM activity_log WHERE event_id = ? ORDER BY created DESC, id DESC LIMIT ?",
    },
  ]);

  const eventRows = resultRows<Event & { attendee_count: number }>(results[0]!);
  const eventRow = eventRows[0];
  if (!eventRow) return null;

  // Decrypt event fields
  const decryptedEvent = await eventsTable.fromDb(eventRow);
  const event: EventWithCount = {
    ...decryptedEvent,
    attendee_count: eventRow.attendee_count,
  };

  const logRows = resultRows<ActivityLogEntry>(results[1]!);
  const entries = await Promise.all(
    logRows.map((row) => activityLogTable.fromDb(row)),
  );

  return { entries, event };
};
