/**
 * Deletion for attendees.
 */

import type { InValue } from "@libsql/client";
import {
  deleteByFieldStatement,
  executeBatch,
  queryAll,
} from "#shared/db/client.ts";
import { ticketCountSumExpr } from "#shared/db/migrations/schema/listing-aggregates.ts";

type DeleteAttendeeOptions = { releaseBookings?: boolean };
type ListingContribution = {
  booked_quantity: number;
  listing_id: number;
  tickets_count: number;
};

/**
 * Per-listing aggregate contributions of an attendee's lines, summed so the
 * hold-delete restore can add them back after deleting. tickets_count counts
 * only quantity > 0 rows (mirroring the delete trigger, which now subtracts 0
 * for a no-quantity line — see {@link ticketCountSumExpr}); booked_quantity
 * sums over all rows. Exported for the shared-predicate guard test.
 */
export const ATTENDEE_LISTING_CONTRIBUTIONS_SQL = `SELECT listing_id,
            COALESCE(SUM(quantity), 0) AS booked_quantity,
            ${ticketCountSumExpr()} AS tickets_count
       FROM listing_attendees
      WHERE attendee_id = ?
      GROUP BY listing_id`;

const attendeeListingContributions = (
  attendeeId: number,
): Promise<ListingContribution[]> =>
  queryAll<ListingContribution>(ATTENDEE_LISTING_CONTRIBUTIONS_SQL, [
    attendeeId,
  ]);

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

/** The tables holding an attendee's dependent rows, each with the column that
 * links it to the attendee. Deleted (in this order) before the attendee row.
 * Exported so the pending-checkout discard (checkout-stages.ts) purges the
 * same set — a new dependent table added here is cleaned there automatically. */
export const DEPENDENT_ROW_TARGETS = [
  { field: "attendee_id", table: "processed_payments" },
  { field: "attendee_id", table: "checkout_stages" },
  { field: "attendee_id", table: "attendee_answers" },
  { field: "attendee_id", table: "listing_attendees" },
  { field: "attendee_id", table: "system_notes" },
  { field: "servicing_attendee_id", table: "service_costs" },
] as const;

/** Delete an attendee and all dependent data tied to the attendee record. */
const purgeAttendee = (
  attendeeId: number,
  contributions: ListingContribution[],
): Promise<void> =>
  executeBatch([
    ...DEPENDENT_ROW_TARGETS.map((target) =>
      deleteByFieldStatement({ ...target, value: attendeeId }),
    ),
    ...restoreListingContributions(contributions),
    deleteByFieldStatement({
      field: "id",
      table: "attendees",
      value: attendeeId,
    }),
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
