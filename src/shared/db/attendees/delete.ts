/**
 * Deletion for attendees.
 */

import { executeBatch } from "#shared/db/client.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";

/** Delete an attendee and all dependent data (payments, answers, listing links) */
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
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    },
    { args: [attendeeId], sql: "DELETE FROM attendees WHERE id = ?" },
  ]);

/**
 * Delete an attendee and all its listing links, payments, and answers.
 */
export const deleteAttendee = async (attendeeId: number): Promise<void> => {
  await purgeAttendee(attendeeId);
  invalidateListingsCache();
};
