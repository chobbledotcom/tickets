/**
 * Deletion for attendees.
 */

import type { InValue } from "@libsql/client";
import {
  executeBatch,
  executeBatchWithResults,
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
 * Never exported raw — every purge path builds its statements through
 * {@link attendeePurgeStatements}, so a new dependent table added here is
 * cleaned everywhere automatically. */
const DEPENDENT_ROW_TARGETS = [
  { field: "attendee_id", table: "processed_payments" },
  { field: "attendee_id", table: "checkout_stages" },
  { field: "attendee_id", table: "attendee_answers" },
  { field: "attendee_id", table: "listing_attendees" },
  { field: "attendee_id", table: "system_notes" },
  { field: "servicing_attendee_id", table: "service_costs" },
] as const;

/** One dependent-table DELETE scoped to the attendees `idsSelect` names. Table
 * and field are trusted constants from the list above, never input. */
const dependentRowDelete = (
  target: (typeof DEPENDENT_ROW_TARGETS)[number],
  idsSelect: string,
  args: InValue[],
): { sql: string; args: InValue[] } => ({
  args,
  sql: `DELETE FROM ${target.table} WHERE ${target.field} IN (${idsSelect})`,
});

/**
 * The DELETE statements clearing every dependent row for the attendees an
 * id-select names, then the attendees themselves — the ONE purge mechanism.
 * The single-attendee delete, the orphaned-attendee purge, and the
 * pending-checkout discard all build from this, so they can never drift on
 * which tables a purge must clean. `idsSelect` is any SELECT producing
 * attendee ids (a literal `?` works for one id); `args` fill its placeholders
 * and are re-bound per statement. The attendees delete comes LAST, so a
 * caller counting the final statement's affected rows counts attendees.
 *
 * `stagesLast` moves the checkout_stages delete after even the attendees —
 * for the pending discard, whose id-select reads checkout_stages and must
 * keep resolving ids until every other delete has run. Callers outside this
 * module run purges through {@link runAttendeePurge}.
 */
const attendeePurgeStatements = (
  idsSelect: string,
  args: InValue[],
  { stagesLast = false }: { stagesLast?: boolean } = {},
): { sql: string; args: InValue[] }[] => {
  const [stages, others] = [
    DEPENDENT_ROW_TARGETS.filter((t) => t.table === "checkout_stages"),
    DEPENDENT_ROW_TARGETS.filter((t) => t.table !== "checkout_stages"),
  ];
  const early = stagesLast ? others : [...stages, ...others];
  const late = stagesLast ? stages : [];
  return [
    ...early.map((target) => dependentRowDelete(target, idsSelect, args)),
    { args, sql: `DELETE FROM attendees WHERE id IN (${idsSelect})` },
    ...late.map((target) => dependentRowDelete(target, idsSelect, args)),
  ];
};

/** Run a purge for the attendees `idsSelect` names and report the LAST
 * statement's affected rows: the attendees removed normally, or — under
 * `stagesLast` — the checkout stages removed (what the pending discard
 * counts). The one entry every set-based purge path calls. */
export const runAttendeePurge = async (
  idsSelect: string,
  args: InValue[],
  opts?: { stagesLast?: boolean },
): Promise<number> => {
  const results = await executeBatchWithResults(
    attendeePurgeStatements(idsSelect, args, opts),
  );
  return results[results.length - 1]!.rowsAffected;
};

/** Delete an attendee and all dependent data tied to the attendee record. */
const purgeAttendee = (
  attendeeId: number,
  contributions: ListingContribution[],
): Promise<void> =>
  executeBatch([
    ...attendeePurgeStatements("?", [attendeeId]),
    ...restoreListingContributions(contributions),
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
