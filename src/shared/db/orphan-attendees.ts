/**
 * Orphaned-attendee cleanup.
 *
 * An orphaned attendee has no surviving `listing_attendees` link, typically
 * because the only listing they booked was deleted: `deleteListing` removes the
 * bookings but deliberately leaves the attendee. They still hold encrypted
 * personal data, so the Privacy page lets the owner purge those past a chosen
 * age. The purge deletes the same dependent rows `deleteAttendee` does,
 * set-based in one batch. No listing aggregates need restoring, since an orphan
 * contributes to no listing's totals.
 *
 * The `transfers` ledger is append-only and never touched: a servicing event's
 * legs stay as orphaned history, the way a deleted listing's sale legs do, and
 * the ledger UI labels the missing row "Deleted listing".
 */

import { attendeeRemovalStatements } from "#db/attendees/delete.ts";
import { executeBatchWithResults, queryAll, requireOne } from "#db/client.ts";
import { refundAuthorityWorkSql } from "#payment/refund-authority-lifecycle.ts";
import { requireValue } from "#shared/required-value.ts";

/** The shared database fact behind both kinds of orphan: no booking points at
 * the attendee. Keep it separate from age and payment state so cleanup and the
 * recovery queue cannot disagree about whether an attendee is an orphan. */
const HAS_NO_BOOKINGS = `NOT EXISTS (
        SELECT 1 FROM listing_attendees AS booking
         WHERE booking.attendee_id = attendee.id
      )`;

/** A payment row whose plaintext mirrors say work still blocks deletion. */
const HAS_PAYMENT_WORK = `EXISTS (
        SELECT 1 FROM processed_payments AS payment
        LEFT JOIN payment_charges AS charge
          ON charge.reference_index = payment.payment_reference_index
         WHERE payment.attendee_id = attendee.id
           AND (
             payment.protected_state != ''
             OR ${refundAuthorityWorkSql("charge.")}
           )
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
 * Find one page of orphans kept alive by refund or payment-review work. Only
 * ids and the plaintext payment-state mirrors are read; attendee PII is never
 * loaded or decrypted. These records stay visible regardless of age until
 * their work is resolved and ordinary orphan cleanup can take them.
 */
export const ORPHAN_PAYMENT_WORK_PAGE_SIZE = 20;

export type OrphanPaymentWorkCursor =
  | { after: number; before?: never }
  | { after?: never; before: number }
  | Record<string, never>;

export type OrphanPaymentWorkPage = {
  attendeeIds: number[];
  /** Boundary for a working Previous link, including from an empty stale page. */
  previousCursor: number | null;
  /** Boundary for a working Next link, including from an empty stale page. */
  nextCursor: number | null;
};

type PaymentWorkPageDirection =
  | {
      boundary: number;
      comparison: "<";
      kind: "backward";
      order: "DESC";
    }
  | {
      boundary: number | undefined;
      comparison: ">";
      kind: "forward";
      order: "ASC";
    };

const paymentWorkPageDirection = (
  cursor: OrphanPaymentWorkCursor,
): PaymentWorkPageDirection =>
  cursor.before === undefined
    ? {
        boundary: cursor.after,
        comparison: ">",
        kind: "forward",
        order: "ASC",
      }
    : {
        boundary: cursor.before,
        comparison: "<",
        kind: "backward",
        order: "DESC",
      };

type VisiblePaymentWorkPage = {
  hasLookahead: boolean;
  firstId: number | undefined;
  lastId: number | undefined;
};

const paymentWorkPageEdge = (
  id: number | undefined,
  edge: "first" | "last",
): number =>
  requireValue(id, `A payment-work lookahead needs a visible ${edge} row`);

const forwardPreviousCursor = (
  boundary: number | undefined,
  firstId: number | undefined,
): number | null => {
  if (boundary === undefined) return null;
  return firstId ?? Math.min(Number.MAX_SAFE_INTEGER, boundary + 1);
};

const paymentWorkPageCursors = (
  direction: PaymentWorkPageDirection,
  page: VisiblePaymentWorkPage,
): Pick<OrphanPaymentWorkPage, "nextCursor" | "previousCursor"> => {
  switch (direction.kind) {
    case "backward":
      return {
        nextCursor: page.lastId ?? Math.max(0, direction.boundary - 1),
        previousCursor: page.hasLookahead
          ? paymentWorkPageEdge(page.firstId, "first")
          : null,
      };
    case "forward":
      return {
        nextCursor: page.hasLookahead
          ? paymentWorkPageEdge(page.lastId, "last")
          : null,
        previousCursor: forwardPreviousCursor(direction.boundary, page.firstId),
      };
  }
};

/** One keyset page of protected orphans. The query starts at the partial
 * payment-work index and reads only attendee ids; one extra id is the lookahead. */
export const getOrphanPaymentWorkPage = async (
  cursor: OrphanPaymentWorkCursor = {},
): Promise<OrphanPaymentWorkPage> => {
  const direction = paymentWorkPageDirection(cursor);
  const rows = await queryAll<{ id: number }>(
    `SELECT DISTINCT payment.attendee_id AS id
       FROM processed_payments AS payment
       LEFT JOIN payment_charges AS charge
         ON charge.reference_index = payment.payment_reference_index
      WHERE (
          payment.protected_state != ''
          OR ${refundAuthorityWorkSql("charge.")}
        )
        AND payment.attendee_id IS NOT NULL
        ${
          direction.boundary === undefined
            ? ""
            : `AND payment.attendee_id ${direction.comparison} ?`
        }
        AND EXISTS (
          SELECT 1
            FROM attendees AS attendee
           WHERE attendee.id = payment.attendee_id
             AND ${HAS_NO_BOOKINGS}
        )
      ORDER BY payment.attendee_id ${direction.order}
      LIMIT ?`,
    [
      ...(direction.boundary === undefined ? [] : [direction.boundary]),
      ORPHAN_PAYMENT_WORK_PAGE_SIZE + 1,
    ],
  );
  const hasLookahead = rows.length > ORPHAN_PAYMENT_WORK_PAGE_SIZE;
  const visible = rows.slice(0, ORPHAN_PAYMENT_WORK_PAGE_SIZE);
  const ordered = direction.kind === "backward" ? visible.reverse() : visible;
  const attendeeIds = ordered.map(({ id }) => Number(id));
  const firstId = attendeeIds[0];
  const lastId = attendeeIds.at(-1);
  return {
    attendeeIds,
    ...paymentWorkPageCursors(direction, { firstId, hasLookahead, lastId }),
  };
};

/**
 * The same orphans, bounded for one scheduled maintenance batch.
 *
 * Maintenance and the operator's recovery queue both take one bounded page at
 * a time. This separate query adds the age and cleanup rules without duplicating
 * the shared definition of a purgeable orphan.
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
