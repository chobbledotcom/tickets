/**
 * Deletion for attendees.
 */

import {
  deleteByFieldStatement,
  queryAll,
  withTransaction,
} from "#db/client.ts";
import {
  clearExternalLinksForIdsStatement,
  repointExternalLinksStatement,
} from "#db/external-sources/target.ts";
import { ticketCountSumExpr } from "#db/migrations/schema/listing-aggregates.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { assertRowsFreeToMove } from "#db/payment-admit-move.ts";
import { sql, sqlName, type SqlStatement } from "#db/sql.ts";
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
 * hold-delete restore can add them back after deleting. `tickets_count` counts
 * only quantity > 0 rows (mirroring the delete trigger, which now subtracts 0
 * for a no-quantity line — see {@link ticketCountSumExpr}). `booked_quantity`
 * sums over all rows. Exported for the shared-predicate guard test.
 */
export const attendeeListingContributionsSql = (
  attendeeId: number,
): SqlStatement => sql`SELECT listing_id,
            COALESCE(SUM(quantity), 0) AS booked_quantity,
            ${ticketCountSumExpr()} AS tickets_count
       FROM listing_attendees
      WHERE attendee_id = ${attendeeId}
      GROUP BY listing_id`;

const attendeeListingContributions = (
  attendeeId: number,
): Promise<ListingContribution[]> =>
  queryAll<ListingContribution>(attendeeListingContributionsSql(attendeeId));

const restoreListingContributions = (
  contributions: ListingContribution[],
): SqlStatement[] =>
  contributions.map(
    (row) => sql`UPDATE listings
             SET booked_quantity = booked_quantity + ${row.booked_quantity},
                 tickets_count = tickets_count + ${row.tickets_count}
           WHERE id = ${row.listing_id}`,
  );

const dependentDeleteStatement = (
  rule: Extract<AttendeeDataRule, { action: "delete" }>,
  attendeeIds: SqlStatement,
): SqlStatement => {
  if (rule.kind === "notes") {
    return noteDeleteStatement("attendee", attendeeIds);
  }
  if (rule.kind === "through") {
    return sql`DELETE FROM ${sqlName(rule.table)}
         WHERE ${sqlName(rule.tableField)} IN (
           SELECT ${sqlName(`joined.${rule.joinedField}`)}
             FROM ${sqlName(rule.joinedTable)} AS joined
            WHERE ${sqlName(`joined.${rule.attendeeField}`)} IN (${attendeeIds})
         )`;
  }
  return sql`DELETE FROM ${sqlName(rule.table)} WHERE ${sqlName(rule.field)} IN (${attendeeIds})`;
};

type DeleteRule = Extract<AttendeeDataRule, { action: "delete" }>;
type RepointRule = Extract<AttendeeDataRule, { action: "repoint" }>;

const deleteRules = (): DeleteRule[] =>
  ATTENDEE_DATA_RULES.filter(
    (rule): rule is DeleteRule => rule.action === "delete",
  );

/** What one repoint rule leaves behind when the attendee is deleted: a cleared
 *  assignment for a single-column rule, and no row for a record-target rule. */
const repointRuleStatement = (
  rule: RepointRule,
  attendeeIds: SqlStatement,
): SqlStatement =>
  rule.kind === "external-links"
    ? clearExternalLinksForIdsStatement(rule.target, attendeeIds)
    : sql`UPDATE ${sqlName(rule.table)} SET ${sqlName(rule.field)} = NULL WHERE ${sqlName(rule.field)} IN (${attendeeIds})`;

/** Remove or detach every dependent row for one or many attendee ids. */
export const attendeeRemovalStatements = (
  attendeeIds: SqlStatement,
): SqlStatement[] =>
  ATTENDEE_DATA_RULES.flatMap((rule) => {
    if (rule.action === "delete") {
      return [dependentDeleteStatement(rule, attendeeIds)];
    }
    return rule.action === "repoint"
      ? [repointRuleStatement(rule, attendeeIds)]
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
          rule.kind === "external-links"
            ? repointExternalLinksStatement(rule.target, sourceId, targetId)
            : sql`UPDATE ${sqlName(rule.table)} SET ${sqlName(rule.field)} = ${targetId} WHERE ${sqlName(rule.field)} = ${sourceId}`,
        ]
      : [],
  );

/**
 * Delete an attendee and all dependent data tied to the attendee record.
 *
 * The payment rows this destroys are read for live work first, inside the same
 * transaction that removes them. A refund the operator has not finished — or
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
      ...attendeeRemovalStatements(sql`${attendeeId}`),
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
