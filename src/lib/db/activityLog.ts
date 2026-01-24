/**
 * Activity log operations
 *
 * Simple activity logging for admin visibility.
 * Not encrypted, no personal info - just action descriptions.
 */

import { getDb, queryOne } from "#lib/db/client.ts";
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
 */
export const activityLogTable = defineTable<ActivityLogEntry, ActivityLogInput>(
  {
    name: "activity_log",
    primaryKey: "id",
    schema: {
      id: col.generated<number>(),
      created: col.withDefault(() => new Date().toISOString()),
      event_id: col.simple<number | null>(),
      message: col.simple<string>(),
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

/**
 * Get activity log entries for an event (most recent first)
 */
export const getEventActivityLog = async (
  eventId: number,
  limit = 100,
): Promise<ActivityLogEntry[]> => {
  const result = await getDb().execute({
    sql: `SELECT * FROM activity_log WHERE event_id = ? ORDER BY created DESC LIMIT ?`,
    args: [eventId, limit],
  });
  return result.rows as unknown as ActivityLogEntry[];
};

/**
 * Get all activity log entries (most recent first)
 */
export const getAllActivityLog = async (
  limit = 100,
): Promise<ActivityLogEntry[]> => {
  const result = await getDb().execute({
    sql: `SELECT * FROM activity_log ORDER BY created DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows as unknown as ActivityLogEntry[];
};

/**
 * Get a single activity log entry by ID
 */
export const getActivityLogEntry = (
  id: number,
): Promise<ActivityLogEntry | null> => queryOne<ActivityLogEntry>(
  `SELECT * FROM activity_log WHERE id = ?`,
  [id],
);
