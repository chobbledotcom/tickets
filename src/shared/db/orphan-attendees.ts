/**
 * Orphaned-attendee cleanup.
 *
 * An orphaned attendee has no surviving `listing_attendees` link, typically
 * because the only listing they booked was deleted — `deleteListing` removes
 * the bookings but deliberately leaves the attendee. They still hold encrypted
 * personal data, so the Privacy page lets the owner purge those past a chosen
 * age.
 *
 * The purge deletes the same dependent rows `deleteAttendee` does, set-based in
 * one batch. No listing aggregates need restoring, since an orphan contributes
 * to no listing's totals.
 *
 * The `transfers` ledger is append-only and never touched: a servicing event's
 * legs stay as orphaned history, the way a deleted listing's sale legs do, and
 * the ledger UI labels the missing row "Deleted listing".
 */

import { attendeeDependentDeleteStatements } from "#shared/db/attendees/delete.ts";
import { executeBatchWithResults, requireOne } from "#shared/db/client.ts";

/**
 * Selects the ids of orphaned attendees older than the bound cut-off. Defined
 * once and reused by every statement below so the "what counts as a purgeable
 * orphan" rule lives in a single place. The single `?` binds the ISO cut-off.
 */
const ORPHAN_IDS = `SELECT attendee.id
     FROM attendees AS attendee
    WHERE attendee.created < ?
      AND NOT EXISTS (
        SELECT 1 FROM listing_attendees AS booking
         WHERE booking.attendee_id = attendee.id
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
