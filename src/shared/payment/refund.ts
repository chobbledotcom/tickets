import type {
  ChargeLeg,
  ProviderRefundResource,
  RefundObservation,
  RefundResolution,
} from "#shared/payment/resources.ts";
import { refundMoneyMatchesCapture } from "#shared/payment/resources.ts";

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
): RefundResolution => ({
  amount: charge.confirmedRefunded,
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
  if (charge.confirmedRefunded.amount === charge.captured.amount) {
    return confirmedRefund("completed", charge, completed);
  }
  if (charge.confirmedRefunded.amount > 0) {
    return confirmedRefund("partial", charge, completed);
  }
  const failed = observedRefund(charge.refunds, "failed");
  return {
    amount: charge.confirmedRefunded,
    ...named(failed?.refund),
    reason: failed === undefined ? "not_observed" : "provider_failed",
    status: "failed",
  };
};
