/** Durable refund identity attached to an attendee. */

import { inPlaceholders, type SqlStatement } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { paymentAnchorReference } from "./reference.ts";
import { anchorSessionId } from "./session.ts";

type PreparedAttendeePaymentAnchor = (attendeeId: number) => SqlStatement;

/** Prepare one payment reference before its attendee-creation transaction. */
export const prepareAttendeePaymentAnchor = async (
  payment: TaggedPaymentReference,
): Promise<PreparedAttendeePaymentAnchor> => {
  const { matchingIndexes, stored } = await paymentAnchorReference(payment);
  const matchingIndexSlots = inPlaceholders(matchingIndexes);
  return (attendeeId) => ({
    args: [
      anchorSessionId(attendeeId, stored.index),
      attendeeId,
      nowIso(),
      stored.encrypted,
      stored.index,
      attendeeId,
      attendeeId,
      ...matchingIndexes,
    ],
    sql: `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, payment_reference,
             payment_reference_index)
          SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM attendees AS attendee WHERE attendee.id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM processed_payments AS payment
                WHERE payment.attendee_id = ?
                  AND payment.payment_reference_index IN (${matchingIndexSlots})
             )`,
  });
};
