/**
 * Orphaned-attendee cleanup.
 *
 * An "orphaned" attendee is a row in `attendees` with no surviving
 * `listing_attendees` link — typically left behind when the only listing they
 * were booked onto is deleted (deleteListing removes the bookings but
 * deliberately leaves the attendee, see db/listings/delete.ts). These rows still hold
 * encrypted personal data but no longer belong to any listing, so the Privacy
 * page lets the owner purge those older than a chosen age.
 *
 * The purge deletes the same dependent rows the canonical single-attendee
 * `deleteAttendee` does, so "purge orphans" is exactly "deleteAttendee applied
 * to every orphan", just set-based in one batch. No listing aggregates need
 * restoring: an orphan has no bookings contributing to any listing's totals.
 *
 * The `transfers` ledger is append-only history and is never touched by the
 * purge — a cost-bearing servicing event's `service_cost` legs remain in the
 * table as orphaned history, the same way sale legs for a deleted listing
 * remain. The ledger UI resolves the listing/account labels to "Deleted
 * listing" when the underlying row is gone.
 */

import { attendeeDependentDeleteStatements } from "#shared/db/attendees/delete.ts";
import { executeBatchWithResults, requireOne } from "#shared/db/client.ts";

/**
 * Selects the ids of orphaned attendees older than the bound cut-off. Defined
 * once and reused by every statement below so the "what counts as a purgeable
 * orphan" rule lives in a single place. The single `?` binds the ISO cut-off.
 *
 * An orphan whose payment is mid-refund, or waiting on the owner, is left where
 * it is: this purge destroys the same payment rows the single-attendee delete
 * does, and those rows are the only sign that money may still be moving. It
 * reads the plaintext `protected_state` mirror rather than the record itself,
 * because a set-based purge can no more decrypt every orphan than the prune can
 * — and the count and the delete share this one clause, so the page can never
 * promise to remove an orphan the delete then keeps.
 */
const ORPHAN_IDS = `SELECT attendee.id
     FROM attendees AS attendee
    WHERE attendee.created < ?
      AND NOT EXISTS (
        SELECT 1 FROM listing_attendees AS booking
         WHERE booking.attendee_id = attendee.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM processed_payments AS payment
         WHERE payment.attendee_id = attendee.id
           AND payment.protected_state != ''
      )`;

/** Count orphaned attendees whose `created` is before `cutoffIso`. */
export const countOrphanedAttendees = async (
  cutoffIso: string,
): Promise<number> => {
  // COUNT(*) always returns exactly one row, so the result is never null.
  const row = await requireOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (${ORPHAN_IDS})`,
    [cutoffIso],
  );
  return row!.count;
};

/**
 * Delete orphaned attendees whose `created` is before `cutoffIso`, along with
 * their dependent rows, in a single atomic batch. Dependents go first (they
 * reference the attendee), then the attendees themselves. Returns how many
 * attendee rows were removed.
 */
export const purgeOrphanedAttendees = async (
  cutoffIso: string,
): Promise<number> => {
  const statements = [
    ...attendeeDependentDeleteStatements({
      args: [cutoffIso],
      sql: ORPHAN_IDS,
    }),
    {
      args: [cutoffIso],
      sql: `DELETE FROM attendees WHERE id IN (${ORPHAN_IDS})`,
    },
  ];
  // The final statement (the attendees delete) reports how many orphans went;
  // executeBatchWithResults always returns one result per statement.
  const results = await executeBatchWithResults(statements);
  return results[results.length - 1]!.rowsAffected;
};
