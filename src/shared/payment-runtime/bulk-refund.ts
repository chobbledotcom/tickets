import {
  requireBulkRefundAction,
  resolveQueuedBulkRefundPayments,
} from "#shared/db/payments/bulk-refunds.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { hasRemainingPaymentMoney } from "#shared/payment-runtime/refund.ts";
import {
  getAttendeePaymentRefundOrNull,
  refundReferences,
} from "#shared/payment-runtime/refund-targets.ts";
import { recordAttendeeRefund } from "#shared/refund-ledger.ts";
import { requireValue } from "#shared/required-value.ts";

/** Finish the local side of a queued provider refund. */
export const finishQueuedBulkRefund = async (
  payment: PaymentSession,
): Promise<void> => {
  const attendeeId = payment.attendeeId;
  if (attendeeId === null) {
    throw new Error(`Bulk refund payment ${payment.id} has no attendee`);
  }
  const refund = requireValue(
    await getAttendeePaymentRefundOrNull(attendeeId),
    `Bulk refund attendee ${attendeeId} has no payments`,
  );
  const { targets } = refund;
  if (targets.some((target) => hasRemainingPaymentMoney(target.charges)))
    return;
  const posted = await recordAttendeeRefund(
    attendeeId,
    refundReferences(targets),
  );
  if (!posted.posted) {
    await requireBulkRefundAction(payment);
    return;
  }
  await resolveQueuedBulkRefundPayments(
    targets.map((target) => target.payment),
  );
};
