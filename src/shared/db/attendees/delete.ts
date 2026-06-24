/**
 * Deletion for attendees.
 */

import type { InValue } from "@libsql/client";
import { executeBatch, queryAll } from "#shared/db/client.ts";

type DeleteAttendeeOptions = { releaseBookings?: boolean };
type ListingContribution = {
  booked_quantity: number;
  listing_id: number;
  tickets_count: number;
};

const attendeeListingContributions = (
  attendeeId: number,
): Promise<ListingContribution[]> =>
  queryAll<ListingContribution>(
    `SELECT listing_id,
            COALESCE(SUM(quantity), 0) AS booked_quantity,
            COUNT(*) AS tickets_count
       FROM listing_attendees
      WHERE attendee_id = ?
      GROUP BY listing_id`,
    [attendeeId],
  );

const restoreListingContributions = (
  contributions: ListingContribution[],
): Array<{ sql: string; args: InValue[] }> =>
  contributions.map((row) => ({
    args: [row.booked_quantity, row.tickets_count, row.listing_id],
    sql: `UPDATE listings
             SET booked_quantity = booked_quantity + ?,
                 tickets_count = tickets_count + ?
           WHERE id = ?`,
  }));

/** Delete an attendee and all dependent data tied to the attendee record. */
const purgeAttendee = (
  attendeeId: number,
  contributions: ListingContribution[],
): Promise<void> =>
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
    {
      args: [attendeeId],
      sql: "DELETE FROM system_notes WHERE attendee_id = ?",
    },
    ...restoreListingContributions(contributions),
    { args: [attendeeId], sql: "DELETE FROM attendees WHERE id = ?" },
  ]);

/**
 * Delete an attendee and all its listing links, payments, and answers.
 */
export const deleteAttendee = async (
  attendeeId: number,
  { releaseBookings = true }: DeleteAttendeeOptions = {},
): Promise<void> => {
  const contributions = releaseBookings
    ? []
    : await attendeeListingContributions(attendeeId);
  await purgeAttendee(attendeeId, contributions);
};
