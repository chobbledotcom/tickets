/**
 * Deletion for attendees.
 */

import {
  deleteByFieldStatement,
  queryAll,
  type SqlStatement,
  withTransaction,
} from "#db/client.ts";
import { ticketCountSumExpr } from "#db/migrations/schema/listing-aggregates.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { assertRowsFreeToMove } from "#db/payment-admit-move.ts";
import {
  ATTENDEE_DATA_RULES,
  type AttendeeDataRule,
} from "./dependent-data.ts";

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

const dependentDeleteStatement = (
  rule: Extract<AttendeeDataRule, { action: "delete" }>,
  attendeeIds: SqlStatement,
): SqlStatement => {
  if (rule.kind === "notes") {
    return noteDeleteStatement("attendee", attendeeIds);
  }
  if (rule.kind === "through") {
    return {
      args: attendeeIds.args,
      sql: `DELETE FROM ${rule.table}
         WHERE ${rule.tableField} IN (
           SELECT joined.${rule.joinedField}
             FROM ${rule.joinedTable} AS joined
            WHERE joined.${rule.attendeeField} IN (${attendeeIds.sql})
         )`,
    };
  }
  return {
    args: attendeeIds.args,
    sql: `DELETE FROM ${rule.table} WHERE ${rule.field} IN (${attendeeIds.sql})`,
  };
};

type DeleteRule = Extract<AttendeeDataRule, { action: "delete" }>;
type RepointRule = Extract<AttendeeDataRule, { action: "repoint" }>;

const deleteRules = (): DeleteRule[] =>
  ATTENDEE_DATA_RULES.filter(
    (rule): rule is DeleteRule => rule.action === "delete",
  );

const clearAssignmentStatement = (
  rule: RepointRule,
  attendeeIds: SqlStatement,
): SqlStatement => ({
  args: attendeeIds.args,
  sql: `UPDATE ${rule.table} SET ${rule.field} = NULL WHERE ${rule.field} IN (${attendeeIds.sql})`,
});

/** Remove or detach every dependent row for one or many attendee ids. */
export const attendeeRemovalStatements = (
  attendeeIds: SqlStatement,
): SqlStatement[] =>
  ATTENDEE_DATA_RULES.flatMap((rule) => {
    if (rule.action === "delete") {
      return [dependentDeleteStatement(rule, attendeeIds)];
    }
    return rule.action === "repoint"
      ? [clearAssignmentStatement(rule, attendeeIds)]
      : [];
  });

/** Clear the one booking-stage relationship a merge must replace early. */
export const checkoutStageDeleteStatements = (
  attendeeIds: SqlStatement,
): SqlStatement[] =>
  deleteRules()
    .filter((rule) => rule.table === "checkout_stages")
    .map((rule) => dependentDeleteStatement(rule, attendeeIds));

/** Move live attendee assignments while keeping their records. */
export const repointAttendeeDependents = (
  sourceId: number,
  targetId: number,
): SqlStatement[] =>
  ATTENDEE_DATA_RULES.flatMap((rule) =>
    rule.action === "repoint"
      ? [
          {
            args: [targetId, sourceId],
            sql: `UPDATE ${rule.table} SET ${rule.field} = ? WHERE ${rule.field} = ?`,
          },
        ]
      : [],
  );

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
      ...attendeeRemovalStatements({ args: [attendeeId], sql: "?" }),
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
