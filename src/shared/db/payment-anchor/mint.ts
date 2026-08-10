/**
 * Giving a legacy charge a row of its own, so a refund can hold it.
 *
 * Most charges arrive with a `processed_payments` row already — checkout wrote
 * one. An old booking can instead carry its charge in the `payment_id` column
 * on the attendee itself, with no payment row anywhere. A refund claim holds
 * rows, so such a charge could be refunded under a claim that held nothing at
 * all: two runs would each be told they had the money to themselves, and each
 * would send a payout against the same charge.
 *
 * So before a run claims anything, every charge it is about to touch is given a
 * row if it has none. The row carries the same reference and the same blind
 * index as a checkout row, so from then on it is claimed, marked, and read
 * exactly like any other charge.
 */

import { executeBatch, type SqlStatement } from "#shared/db/client.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  encryptPaymentReference,
  type RefundPaymentReference,
} from "#shared/db/payment-references.ts";
import { nowIso } from "#shared/now.ts";

/** An attendee and the charges a run is about to act on for them. */
export type AnchoredAttendee = {
  readonly attendeeId: number;
  readonly references: readonly RefundPaymentReference[];
};

/**
 * A charge with no row of its own. Every row a reference was built from
 * contributes a session id, so a reference naming none exists only in the
 * attendee's `payment_id` column.
 */
const needsAnchor = (reference: RefundPaymentReference): boolean =>
  reference.rowSessionIds.length === 0 && reference.index !== "";

const anchorStatement = async (
  attendeeId: number,
  reference: RefundPaymentReference,
): Promise<SqlStatement> => ({
  args: [
    anchorSessionId(attendeeId, reference.index),
    attendeeId,
    nowIso(),
    await encryptPaymentReference(reference.reference),
    reference.index,
  ],
  // Ignoring a clash is right here, and only because the session id names the
  // attendee AND the charge: a row already under that id is this same person's
  // row for this same money, so there is nothing to write.
  sql: `INSERT OR IGNORE INTO processed_payments
        (payment_session_id, attendee_id, processed_at, payment_reference,
         payment_reference_index)
        VALUES (?, ?, ?, ?, ?)`,
});

/**
 * Make sure every charge these attendees carry has a row to be held by.
 *
 * Runs before the claim rather than inside it, so the claim finds these rows
 * the way it finds any others. Two runs arriving together both write, and the
 * second write is ignored; the claim that follows is what decides which of them
 * may actually move the money.
 *
 * Costs nothing when every charge already has a row, which is the normal case.
 */
export const anchorLegacyCharges = async (
  attendees: readonly AnchoredAttendee[],
): Promise<void> => {
  const statements = await Promise.all(
    attendees.flatMap((attendee) =>
      attendee.references
        .filter(needsAnchor)
        .map((reference) => anchorStatement(attendee.attendeeId, reference)),
    ),
  );
  if (statements.length > 0) await executeBatch(statements);
};
