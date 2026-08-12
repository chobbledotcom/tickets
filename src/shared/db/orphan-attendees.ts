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

import { attendeeRemovalStatements } from "#shared/db/attendees/delete.ts";
import {
  executeBatchWithResults,
  queryIdColumn,
  requireOne,
} from "#shared/db/client.ts";

/** The shared database fact behind both kinds of orphan: no booking points at
 * the attendee. Keep it separate from age and payment state so cleanup and the
 * recovery queue cannot disagree about whether an attendee is an orphan. */
const HAS_NO_BOOKINGS = `NOT EXISTS (
        SELECT 1 FROM listing_attendees AS booking
         WHERE booking.attendee_id = attendee.id
      )`;

/** A payment row whose plaintext mirror says work still blocks deletion. */
const HAS_PAYMENT_WORK = `EXISTS (
        SELECT 1 FROM processed_payments AS payment
         WHERE payment.attendee_id = attendee.id
           AND payment.protected_state != ''
      )`;

/**
 * Selects the ids of orphaned attendees older than the bound cut-off. Defined
 * once and reused by every statement below so the "what counts as a purgeable
 * orphan" rule lives in a single place. The single `?` binds the ISO cut-off.
 *
 * An orphan whose payment is mid-refund, or waiting on the owner, is left
 * where it is: those rows are the only sign money may still be moving. It
 * reads the plaintext `protected_state` mirror because a set-based purge can
 * no more decrypt every orphan than the prune can — and the count and the
 * delete share this clause, so the page cannot promise a removal it keeps.
 */
export const ORPHAN_IDS = `SELECT attendee.id
     FROM attendees AS attendee
    WHERE attendee.created < ?
      AND ${HAS_NO_BOOKINGS}
      AND NOT ${HAS_PAYMENT_WORK}`;

/**
 * Find every orphan kept alive by refund or payment-review work. Only ids and
 * the plaintext payment-state mirror are read; attendee PII is never loaded or
 * decrypted. These records stay visible regardless of age until their work is
 * resolved and ordinary orphan cleanup can take them.
 */
export const getOrphanAttendeeIdsWithPaymentWork = (): Promise<number[]> =>
  queryIdColumn(
    `SELECT attendee.id
       FROM attendees AS attendee
      WHERE ${HAS_NO_BOOKINGS}
        AND ${HAS_PAYMENT_WORK}
      ORDER BY attendee.id`,
  );

/**
 * The same orphans, bounded for one scheduled maintenance batch.
 *
 * Maintenance takes them a page at a time where the operator's page takes them
 * all, and that bound is the only difference — so it is added here rather than
 * by writing the rule out a second time, and both purges keep answering the
 * same question about which rows are safe to take.
 */
export const orphanIdsBatch = (): string =>
  `${ORPHAN_IDS}\n ORDER BY attendee.id LIMIT ?`;

/** Count purgeable orphans whose `created` is before `cutoffIso`. */
export const countPurgeableOrphanedAttendees = async (
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
    ...attendeeRemovalStatements({
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
