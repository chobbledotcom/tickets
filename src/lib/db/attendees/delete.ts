/**
 * Deletion and event-link unlinking for attendees.
 */

import { executeBatch, getDb, queryOne } from "#lib/db/client.ts";
import { invalidateEventsCache } from "#lib/db/events.ts";

/** Delete an attendee and all dependent data (payments, answers, event links) */
const purgeAttendee = (attendeeId: number): Promise<void> =>
  executeBatch([
    {
      args: [attendeeId],
      sql: "DELETE FROM processed_payments WHERE attendee_id = ?",
    },
    {
      args: [attendeeId],
      sql: "DELETE FROM attendee_answers WHERE attendee_id = ?",
    },
    {
      args: [attendeeId],
      sql: "DELETE FROM event_attendees WHERE attendee_id = ?",
    },
    { args: [attendeeId], sql: "DELETE FROM attendees WHERE id = ?" },
  ]);

/**
 * Delete an attendee and all its event links, payments, and answers.
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await purgeAttendee(attendeeId);
  invalidateEventsCache();
};

/**
 * Remove a single event link for an attendee.
 * If the attendee has no remaining event links, deletes the attendee entirely.
 * Returns whether the attendee was fully deleted.
 */
export const unlinkAttendeeFromEvent = async (
  attendeeId: number,
  eventId: number,
): Promise<{ attendeeDeleted: boolean }> => {
  await getDb().execute({
    args: [attendeeId, eventId],
    sql: "DELETE FROM event_attendees WHERE attendee_id = ? AND event_id = ?",
  });

  const remaining = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM event_attendees WHERE attendee_id = ?",
    [attendeeId],
  );

  if (remaining && remaining.count === 0) {
    await purgeAttendee(attendeeId);
    invalidateEventsCache();
    return { attendeeDeleted: true };
  }

  invalidateEventsCache();
  return { attendeeDeleted: false };
};
