/**
 * The check every writer runs before it moves or removes an attendee's payment
 * rows. The read happens on the caller's OWN write transaction, so a refund
 * run's claim either lands before it and stops the writer, or waits for the
 * commit and sees the moved world. Checking any earlier leaves a gap where a
 * claim arrives between the check and the write.
 */

import {
  type BatchExecutor,
  queryBatchPrimary,
  resultRows,
  type TxScope,
} from "#db/client.ts";
import { idListStatement } from "#db/id-list-statement.ts";
import { liveBookingOfAttendees } from "#db/subscriptions.ts";
import { t } from "#i18n";
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
import { namedError } from "#shared/named-error.ts";
import { requireValue } from "#shared/required-value.ts";

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

const moveWorkStatement = idListStatement(
  (ids) => `SELECT DISTINCT payment.protected_state, charge.refund_state
          FROM processed_payments AS payment
          LEFT JOIN payment_charges AS charge
            ON charge.reference_index = payment.payment_reference_index
         WHERE payment.attendee_id IN (${ids})`,
);

const admissionFor = (reason: string | null): PaymentMoveAdmission =>
  reason === null ? { kind: "available" } : { kind: "blocked", reason };

const moveSnapshot = (
  rows: readonly StoredMoveWork[],
  holdsLiveSubscription: boolean,
): PaymentMoveSnapshot => {
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
  // A merge copies the plan to the kept attendee. A delete loses it.
  const subscriptionRefusal = holdsLiveSubscription
    ? t("error.subscription_live")
    : null;
  const refusalFor = (move: RowMove): string | null =>
    (move === "delete" ? subscriptionRefusal : null) ??
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

/** The reads a move decision rests on: the payment work of the attendees, and
 * any of their bookings whose subscription still charges. */
/** Read the payment-move decision with `runReads`: the primary for a page,
 * or the transaction of the writer. The rows contain no attendee PII and are
 * bounded by attendee id. */
const snapshotReadBy =
  (runReads: BatchExecutor) =>
  async (attendeeIds: readonly number[]): Promise<PaymentMoveSnapshot> => {
    const [work, live] = await runReads([
      moveWorkStatement(attendeeIds),
      liveBookingOfAttendees(attendeeIds),
    ]);
    return moveSnapshot(
      resultRows<StoredMoveWork>(
        requireValue(work, "Payment work read is missing"),
      ),
      requireValue(live, "Subscription read is missing").rows.length > 0,
    );
  };

export const loadPaymentMoveSnapshot = snapshotReadBy(queryBatchPrimary);

/** Raised when payment rows are in the middle of work the operator has to
 *  settle first. The message is written for whoever asked for the merge or the
 *  delete, so it can be shown as-is. */
export class PaymentRowsBusyError extends namedError("PaymentRowsBusyError") {}

/** Stop the caller's transaction unless every one of these attendees' payment
 *  rows is free to move. Throwing rather than answering means a caller that
 *  forgets to look still fails closed and rolls its transaction back. */
export const assertRowsFreeToMove = async (
  tx: TxScope,
  attendeeIds: readonly number[],
  move: RowMove,
): Promise<void> => {
  const snapshot = await snapshotReadBy(tx.batch)(attendeeIds);
  const admission = snapshot.admission[move];
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
