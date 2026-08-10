import type {
  ChargeLeg,
  ProviderRefundResource,
  RefundObservation,
  RefundResolution,
} from "#shared/payment/resources.ts";
import {
  refundMoneyMatchesCapture,
  refundMoneyReturned,
} from "#shared/payment/resources.ts";

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

const confirmedRefund = (
  status: "completed" | "partial",
  charge: ChargeLeg,
  observation: RefundObservation | undefined,
  returned: number,
): RefundResolution => ({
  amount: { amount: returned, currency: charge.confirmedRefunded.currency },
  ...named(observation?.refund),
  status,
});

export const resolveRefund = (charge: ChargeLeg): RefundResolution => {
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
      amount: { amount: returned, currency: charge.confirmedRefunded.currency },
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
