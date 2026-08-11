/**
 * Giving a legacy charge a row of its own, so a refund can hold it.
 *
 * An old booking can carry its charge in the attendee's `payment_id` column
 * with no payment row anywhere. A claim holds rows, so such a charge could be
 * refunded under a claim that held nothing: two runs would each be told they
 * had the money, and each would pay out against the same charge. So every
 * charge a run is about to touch is given a row first, carrying the same
 * reference and blind index as a checkout row.
 */

import type { SqlStatement } from "#shared/db/client.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import { storePaymentReference } from "#shared/db/payment-reference-store.ts";
import type { RefundPaymentReference } from "#shared/db/payment-references.ts";
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
): Promise<SqlStatement> => {
  const stored = await storePaymentReference(reference);
  if (stored.index !== reference.index) {
    throw new Error(
      `Payment reference index changed for attendee ${attendeeId}`,
    );
  }
  return {
    args: [
      anchorSessionId(attendeeId, reference.index),
      attendeeId,
      nowIso(),
      stored.encrypted,
      stored.index,
      attendeeId,
    ],
    // Passing over a clash is right only because the session id names the
    // attendee AND the charge, so a row already under it is this person's row
    // for this money. Naming the column keeps that to the clash: a NOT NULL or
    // future constraint failure still raises.
    //
    // The EXISTS stops this minting a row for somebody no longer there. A delete
    // can land between loading candidates and anchoring — it refuses on payment
    // rows, and a `payment_id`-only charge has none for it to see — and the
    // table holds no foreign key, so the claim would then succeed and the run
    // would send money with no booking or ledger left to record it against.
    sql: `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference,
           payment_reference_index)
          SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM attendees AS attendee
                          WHERE attendee.id = ?)
              ON CONFLICT (payment_session_id) DO NOTHING`,
  };
};

/** The writes that give every row-less charge a deterministic row. The claim
 *  runs them inside its own transaction, so the new row and its hold become
 *  visible together. The normal case returns no writes. */
export const legacyAnchorStatements = async (
  attendees: readonly AnchoredAttendee[],
): Promise<SqlStatement[]> =>
  await Promise.all(
    attendees.flatMap((attendee) =>
      attendee.references
        .filter(needsAnchor)
        .map((reference) => anchorStatement(attendee.attendeeId, reference))
    ),
  );
