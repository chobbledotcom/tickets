/**
 * Activity log operations
 *
 * Activity logging for admin visibility.
 * Messages are encrypted - only admins can read them.
 */

import { decrypt, encrypt } from "#lib/crypto.ts";
import { getDb } from "#lib/db/client.ts";
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
