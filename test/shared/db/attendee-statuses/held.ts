import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";

/** Adds one attendee that holds the given status, and returns its id. */
export const createAttendeeWithStatus = async (
  statusId: number,
): Promise<number> => {
  const attendee = await getDb().execute(
    sql`INSERT INTO attendees (created, pii_blob, status_id) VALUES (${new Date().toISOString()}, '', ${statusId})`,
  );
  return Number(attendee.lastInsertRowid);
};
