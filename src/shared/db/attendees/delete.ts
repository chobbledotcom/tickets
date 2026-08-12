/**
 * Deletion for attendees.
 */

import {
  deleteByFieldStatement,
  queryAll,
  type SqlStatement,
  withTransaction,
} from "#shared/db/client.ts";
import { ticketCountSumExpr } from "#shared/db/migrations/schema/listing-aggregates.ts";
import { noteDeleteStatement } from "#shared/db/notes/queries.ts";
import { assertRowsFreeToMove } from "#shared/db/payment-admit-move.ts";

type DeleteAttendeeOptions = { releaseBookings?: boolean };
type ListingContribution = {
  booked_quantity: number;
  listing_id: number;
  tickets_count: number;
};

type DependentRowTarget = { field: string; table: string };

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
const CHECKOUT_STAGE_ROWS = {
  field: "attendee_id",
  table: "checkout_stages",
} as const;

const DEPENDENT_ROW_TARGETS = [
  CHECKOUT_STAGE_ROWS,
  { field: "attendee_id", table: "refund_confirmations" },
  { field: "attendee_id", table: "processed_payments" },
  { field: "attendee_id", table: "attendee_answers" },
  { field: "attendee_id", table: "listing_attendees" },
  { field: "servicing_attendee_id", table: "service_costs" },
] as const;

const dependentDeleteStatement = (
  { field, table }: DependentRowTarget,
  attendeeIds: SqlStatement,
): SqlStatement => ({
  args: attendeeIds.args,
  sql: `DELETE FROM ${table} WHERE ${field} IN (${attendeeIds.sql})`,
});

const refundConfirmationReferenceDeleteStatement = (
  attendeeIds: SqlStatement,
): SqlStatement => ({
  args: attendeeIds.args,
  sql: `DELETE FROM refund_confirmation_references
         WHERE confirmation_identity IN (
           SELECT confirmation.identity
             FROM refund_confirmations AS confirmation
            WHERE confirmation.attendee_id IN (${attendeeIds.sql})
         )`,
});

/** Delete checkout stages for one or many attendee ids. */
export const checkoutStageDeleteStatement = (
  attendeeIds: SqlStatement,
): SqlStatement => dependentDeleteStatement(CHECKOUT_STAGE_ROWS, attendeeIds);

/** Build the common dependent-row deletes for one or many attendee ids. */
export const attendeeDependentDeleteStatements = (
  attendeeIds: SqlStatement,
): SqlStatement[] => [
  refundConfirmationReferenceDeleteStatement(attendeeIds),
  ...DEPENDENT_ROW_TARGETS.map((target) =>
    dependentDeleteStatement(target, attendeeIds),
  ),
  // Notes are named by the kind of record they are about, so the notes module
  // builds this one rather than the plain "column = id" shape above.
  noteDeleteStatement("attendee", attendeeIds),
];

/**
 * Delete an attendee and all dependent data tied to the attendee record.
 *
 * The payment rows this destroys are read for live work first, inside the same
 * transaction that removes them, so a refund the operator has not finished — or
 * a payment the owner still has to look at — stops the delete instead of
 * disappearing with it. One batch inside the transaction keeps the write lock
 * held for a single round trip however many dependent tables there are.
 */
const purgeAttendee = (
  attendeeId: number,
  contributions: ListingContribution[],
): Promise<void> =>
  withTransaction(async (tx) => {
    await assertRowsFreeToMove(tx, [attendeeId], "delete");
    await tx.batch([
      ...attendeeDependentDeleteStatements({ args: [attendeeId], sql: "?" }),
      ...restoreListingContributions(contributions),
      deleteByFieldStatement({
        field: "id",
        table: "attendees",
        value: attendeeId,
      }),
    ]);
  });

/**
 * Delete an attendee and all its listing links, payments, and answers.
 *
 * Refuses with {@link PaymentRowsBusyError} while one of the attendee's
 * payments is mid-refund or waiting on the owner.
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
