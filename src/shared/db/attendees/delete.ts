/**
 * Deletion and listing-link unlinking for attendees.
 */

import { executeBatch, getDb, queryOne } from "#shared/db/client.ts";
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

/**
 * Remove a single listing link for an attendee.
 * If the attendee has no remaining listing links, deletes the attendee entirely.
 * Returns whether the attendee was fully deleted.
 */
export const unlinkAttendeeFromListing = async (
  attendeeId: number,
  listingId: number,
): Promise<{ attendeeDeleted: boolean }> => {
  await getDb().execute({
    args: [attendeeId, listingId],
    sql: "DELETE FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
  });

  const remaining = await queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM listing_attendees WHERE attendee_id = ?",
    [attendeeId],
  );

  if (remaining && remaining.count === 0) {
    await purgeAttendee(attendeeId);
    invalidateListingsCache();
    return { attendeeDeleted: true };
  }

  invalidateListingsCache();
  return { attendeeDeleted: false };
};
