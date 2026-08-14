/**
 * The check every writer runs before it moves or removes an attendee's payment
 * rows. The read happens on the caller's OWN write transaction, so a refund
 * run's claim either lands before it and stops the writer, or waits for the
 * commit and sees the moved world. Checking any earlier leaves a gap where a
 * claim arrives between the check and the write.
 */

import { inPlaceholders, resultRows, type TxScope } from "#shared/db/client.ts";
import {
  mirroredMoveRefusalOrNull,
  type RowMove,
} from "#shared/payment/admit-move.ts";
import { refundMoveRefusalOrNull } from "#shared/payment/refund-authority-lifecycle.ts";
import {
  type RefundAuthorityState,
  readRefundAuthorityState,
} from "#shared/payment/refund-authority-state.ts";

interface StoredMoveWork {
  readonly protected_state: string;
  readonly refund_state: string | null;
}

/** Raised when payment rows are in the middle of work the operator has to
 *  settle first. The message is written for whoever asked for the merge or the
 *  delete, so it can be shown as-is. */
export class PaymentRowsBusyError extends Error {
  constructor(refusal: string) {
    super(refusal);
    this.name = "PaymentRowsBusyError";
  }
}

/** Stop the caller's transaction unless every one of these attendees' payment
 *  rows is free to move. Throwing rather than answering means a caller that
 *  forgets to look still fails closed and rolls its transaction back. */
export const assertRowsFreeToMove = async (
  tx: TxScope,
  attendeeIds: readonly number[],
  move: RowMove,
): Promise<void> => {
  const rows = resultRows<StoredMoveWork>(
    await tx.execute({
      args: [...attendeeIds],
      sql: `SELECT DISTINCT payment.protected_state, charge.refund_state
              FROM processed_payments AS payment
              LEFT JOIN payment_charges AS charge
                ON charge.reference_index = payment.payment_reference_index
             WHERE payment.attendee_id IN (${inPlaceholders(attendeeIds)})`,
    }),
  );
  const rowRefusal = mirroredMoveRefusalOrNull(
    rows.map((row) => row.protected_state),
    move,
  );
  if (rowRefusal !== null) throw new PaymentRowsBusyError(rowRefusal);
  const storedAuthorityStates = new Set(
    rows.flatMap((row) =>
      row.refund_state === null ? [] : [row.refund_state],
    ),
  );
  const authorityStates: RefundAuthorityState[] = [
    ...storedAuthorityStates,
  ].map((state) =>
    readRefundAuthorityState(state, "payment_charges.refund_state"),
  );
  const authorityRefusal = refundMoveRefusalOrNull(authorityStates, move);
  if (authorityRefusal !== null) {
    throw new PaymentRowsBusyError(authorityRefusal);
  }
};

/** Run work that may be refused, handing the refusal's words to `refused`
 *  rather than letting them escape. Being turned away is an ordinary answer
 *  for an operator; anything else thrown is a real fault and is left alone. */
export const orRefusal = async <T>(
  work: () => Promise<T>,
  refused: (message: string) => T,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof PaymentRowsBusyError)) throw error;
    return refused(error.message);
  }
};
