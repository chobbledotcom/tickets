/**
 * The check every writer runs before it moves or removes an attendee's payment
 * rows. The read happens on the caller's OWN write transaction, so a refund
 * run's claim either lands before it and stops the writer, or waits for the
 * commit and sees the moved world. Checking any earlier leaves a gap where a
 * claim arrives between the check and the write.
 */

import {
  inPlaceholders,
  queryAllPrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import {
  mirroredMoveRefusalOrNull,
  type PaymentWork,
  paymentWorkForMirrors,
  type RowMove,
} from "#payment/admit-move.ts";
import {
  refundLifecycleFor,
  refundMoveRefusalOrNull,
} from "#payment/refund-authority-lifecycle.ts";
import {
  type RefundAuthorityState,
  readRefundAuthorityState,
} from "#payment/refund-authority-state.ts";

interface StoredMoveWork {
  readonly protected_state: string;
  readonly refund_state: string | null;
}

export type PaymentMoveAdmission =
  | { readonly kind: "available" }
  | { readonly kind: "blocked"; readonly reason: string };

export interface PaymentMoveSnapshot {
  readonly admission: Record<RowMove, PaymentMoveAdmission>;
  readonly work: PaymentWork;
}

const moveWorkStatement = (attendeeIds: readonly number[]): SqlStatement => ({
  args: [...attendeeIds],
  sql: `SELECT DISTINCT payment.protected_state, charge.refund_state
          FROM processed_payments AS payment
          LEFT JOIN payment_charges AS charge
            ON charge.reference_index = payment.payment_reference_index
         WHERE payment.attendee_id IN (${inPlaceholders(attendeeIds)})`,
});

const admissionFor = (reason: string | null): PaymentMoveAdmission =>
  reason === null ? { kind: "available" } : { kind: "blocked", reason };

const moveSnapshot = (rows: readonly StoredMoveWork[]): PaymentMoveSnapshot => {
  const mirrors = rows.map((row) => row.protected_state);
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
  const refusalFor = (move: RowMove): string | null =>
    mirroredMoveRefusalOrNull(mirrors, move) ??
    refundMoveRefusalOrNull(authorityStates, move);
  return {
    admission: {
      delete: admissionFor(refusalFor("delete")),
      merge: admissionFor(refusalFor("merge")),
    },
    work: paymentWorkForMirrors(
      mirrors,
      authorityStates.some((state) => !refundLifecycleFor(state).prunable),
    ),
  };
};

const snapshotFrom = async (
  read: ReturnType<TxScope["execute"]>,
): Promise<PaymentMoveSnapshot> =>
  moveSnapshot(resultRows<StoredMoveWork>(await read));

const readPaymentMoveSnapshot = (
  tx: TxScope,
  attendeeIds: readonly number[],
): Promise<PaymentMoveSnapshot> =>
  snapshotFrom(tx.execute(moveWorkStatement(attendeeIds)));

/** Read the same payment-move decision as the transactional writer from the
 * primary. The rows contain no attendee PII and are bounded by attendee id. */
export const loadPaymentMoveSnapshot = async (
  attendeeIds: readonly number[],
): Promise<PaymentMoveSnapshot> =>
  moveSnapshot(
    await queryAllPrimary<StoredMoveWork>(moveWorkStatement(attendeeIds)),
  );

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
  const admission = (await readPaymentMoveSnapshot(tx, attendeeIds)).admission[
    move
  ];
  if (admission.kind === "blocked") {
    throw new PaymentRowsBusyError(admission.reason);
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
