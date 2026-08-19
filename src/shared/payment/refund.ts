import type { Money } from "#payment/money.ts";
import {
  type ChargeMoney,
  type ProviderRefundResource,
  type RefundObservation,
  type RefundResolution,
  refundMoneyMatchesCapture,
  refundMoneyReturned,
} from "#payment/resources.ts";

/** The provider's own refund, when it has named one. Left out entirely when it
 *  has not, rather than carried as nothing. */
const named = (
  refund: ProviderRefundResource | undefined,
): { refund: ProviderRefundResource } | Record<never, never> =>
  refund === undefined ? {} : { refund };

const observedRefund = (
  refunds: RefundObservation[],
  status: RefundObservation["status"],
): RefundObservation | undefined =>
  refunds.find((refund) => refund.status === status);

/** Money back on this charge, in the currency its own returned total uses. */
const moneyReturned = (charge: ChargeMoney, returned: number): Money => ({
  amount: returned,
  currency: charge.confirmedRefunded.currency,
});

const confirmedRefund = (
  status: "completed" | "partial",
  charge: ChargeMoney,
  observation: RefundObservation | undefined,
  returned: number,
): RefundResolution => ({
  amount: moneyReturned(charge, returned),
  ...named(observation?.refund),
  status,
});

export const resolveRefund = (charge: ChargeMoney): RefundResolution => {
  if (!refundMoneyMatchesCapture(charge)) {
    return {
      amount: charge.confirmedRefunded,
      reason: "invalid_amount",
      status: "failed",
    };
  }
  const pending = charge.refunds.filter(
    (refund) => refund.status === "pending",
  );
  if (pending.length > 1) {
    return {
      amount: charge.confirmedRefunded,
      reason: "multiple_pending_refunds",
      status: "failed",
    };
  }
  const pendingRefund = pending[0];
  if (pendingRefund !== undefined) {
    return {
      amount: pendingRefund.amount,
      ...named(pendingRefund.refund),
      status: "pending",
    };
  }
  const completed = observedRefund(charge.refunds, "completed");
  const returned = refundMoneyReturned(charge);
  if (returned === charge.captured.amount) {
    return confirmedRefund("completed", charge, completed, returned);
  }
  // A refund the provider tried and could not finish is answered before money
  // already back is called a partial refund: the two need different handling,
  // and a failure hidden behind "partly refunded" is a failure nobody retries.
  const failed = observedRefund(charge.refunds, "failed");
  if (failed !== undefined) {
    return {
      amount: moneyReturned(charge, returned),
      ...named(failed.refund),
      reason: "provider_failed",
      status: "failed",
    };
  }
  if (returned > 0) {
    return confirmedRefund("partial", charge, completed, returned);
  }
  return {
    amount: charge.confirmedRefunded,
    reason: "not_observed",
    status: "failed",
  };
};
