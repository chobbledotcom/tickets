import type {
  ProviderRefundResource,
  RefundObservation,
} from "#shared/payment-state/resources.ts";

export const pendingRefundObservation = (
  refund: ProviderRefundResource,
): Extract<RefundObservation, { status: "pending" }> => ({
  amount: { amount: 1_000, currency: "GBP" },
  refund,
  status: "pending",
});
