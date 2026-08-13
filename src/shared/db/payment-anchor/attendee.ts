/** Durable refund identity materialized when an old attendee is saved. */

import { inPlaceholders, type SqlStatement } from "#shared/db/client.ts";
import { nowIso } from "#shared/now.ts";
import { paymentAnchorReference } from "./reference.ts";
import { anchorSessionId } from "./session.ts";

/**
 * Give one attendee's old PII-only payment a durable indexed row. A current
 * checkout row with any provider spelling of the same reference wins, so a
 * routine attendee save never adds a second representation of current money.
 */
export const attendeePaymentAnchorStatements = async (
  attendeeId: number,
  paymentId: string,
): Promise<SqlStatement[]> => {
  if (paymentId === "") return [];
  const { matchingIndexes, stored } = await paymentAnchorReference(paymentId);
  const matchingIndexSlots = inPlaceholders(matchingIndexes);
  const anchor = {
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
  };
  return [anchor];
};
