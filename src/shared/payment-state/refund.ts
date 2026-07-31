import type {
  ChargeLeg,
  RefundObservation,
  RefundResolution,
} from "#shared/payment-state/resources.ts";
import { refundMoneyMatchesCapture } from "#shared/payment-state/resources.ts";

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
  ...(observation?.refund === undefined ? {} : { refund: observation.refund }),
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
      ...(pendingRefund.refund === undefined
        ? {}
        : { refund: pendingRefund.refund }),
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
    ...(failed?.refund === undefined ? {} : { refund: failed.refund }),
    reason: failed === undefined ? "not_observed" : "provider_failed",
    status: "failed",
  };
};
