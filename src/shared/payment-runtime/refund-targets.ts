import { getPaymentChargesByPaymentIds } from "#shared/db/payments/charges.ts";
import { getPaymentSessionsByAttendeeIds } from "#shared/db/payments/sessions.ts";
import type {
  PaymentCharge,
  PaymentSession,
} from "#shared/db/payments/types.ts";
import type { RefundPaymentReference } from "#shared/payment-refund-reference.ts";
import { currentPaymentCharges } from "#shared/payment-runtime/refund.ts";

export type PaymentRefundTarget = {
  charges: PaymentCharge[];
  payment: PaymentSession;
};

export const getPaymentRefundTargets = async (
  attendeeIds: readonly number[],
): Promise<Map<number, PaymentRefundTarget[]>> => {
  const payments = await getPaymentSessionsByAttendeeIds(attendeeIds);
  const chargesByPaymentId = await getPaymentChargesByPaymentIds(
    payments.map((payment) => payment.id),
  );
  const targets = payments.map((payment): PaymentRefundTarget => {
    const stored = chargesByPaymentId.get(payment.id) ?? [];
    return { charges: currentPaymentCharges(payment, stored), payment };
  });
  const grouped = Map.groupBy(targets, (target) => target.payment.attendeeId);
  return new Map(
    attendeeIds.flatMap((attendeeId): [number, PaymentRefundTarget[]][] => {
      const values = grouped.get(attendeeId);
      return values === undefined ? [] : [[attendeeId, values]];
    }),
  );
};

export const refundReferences = (
  targets: readonly PaymentRefundTarget[],
): RefundPaymentReference[] =>
  targets.flatMap((target) =>
    target.charges.map((charge) => ({
      providerRefunded: charge.refunded.amount === charge.captured.amount,
      reference: charge.providerReference.id,
      sessionIds: [target.payment.id],
    })),
  );

export type AttendeePaymentRefund = {
  references: RefundPaymentReference[];
  targets: PaymentRefundTarget[];
};

export const getAttendeePaymentRefundOrNull = async (
  attendeeId: number,
): Promise<AttendeePaymentRefund | null> => {
  const targets =
    (await getPaymentRefundTargets([attendeeId])).get(attendeeId) ?? [];
  const references = refundReferences(targets);
  return references.length === 0 ? null : { references, targets };
};
