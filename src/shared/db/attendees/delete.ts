/**
 * Deletion for attendees.
 */

import {
  deleteByFieldStatement,
  executeBatch,
  queryAll,
  type SqlStatement,
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
): SqlStatement[] =>
  contributions.map((row) => ({
    args: [row.booked_quantity, row.tickets_count, row.listing_id],
    sql: `UPDATE listings
             SET booked_quantity = booked_quantity + ?,
                 tickets_count = tickets_count + ?
           WHERE id = ?`,
  }));

/** The tables holding an attendee's dependent rows, each with the column that
 * links it to the attendee. Deleted (in this order) before the attendee row. */
const DEPENDENT_ROW_TARGETS = [
  { field: "attendee_id", table: "processed_payments" },
  { field: "attendee_id", table: "attendee_answers" },
  { field: "attendee_id", table: "listing_attendees" },
  { field: "attendee_id", table: "system_notes" },
  { field: "servicing_attendee_id", table: "service_costs" },
  { field: "attendee_id", table: "checkout_stages" },
] as const;

/** Build the common dependent-row deletes for one or many attendee ids.
 * Checkout stages are always last, so a caller whose id query reads that table
 * can place related statements immediately before its guaranteed final delete. */
export const attendeeDependentDeleteStatements = (
  attendeeIds: SqlStatement,
  beforeCheckoutStage: SqlStatement[] = [],
): SqlStatement[] => {
  const deletes = DEPENDENT_ROW_TARGETS.map(({ field, table }) => ({
    args: attendeeIds.args,
    sql: `DELETE FROM ${table} WHERE ${field} IN (${attendeeIds.sql})`,
  }));
  return [
    ...deletes.slice(0, -1),
    ...beforeCheckoutStage,
    ...deletes.slice(-1),
  ];
};

/** Delete an attendee and all dependent data tied to the attendee record. */
const purgeAttendee = (
  attendeeId: number,
  contributions: ListingContribution[],
): Promise<void> =>
  executeBatch([
    ...attendeeDependentDeleteStatements({ args: [attendeeId], sql: "?" }),
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
