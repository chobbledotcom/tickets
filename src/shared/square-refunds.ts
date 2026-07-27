/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import type { PaymentCharge } from "#shared/db/payments/types.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  completedProviderRefund,
  failedProviderRefund,
  makeProviderRefund,
  pendingProviderRefund,
} from "#shared/payment-runtime/provider-refund.ts";
import {
  ProviderRefundResourceSchema,
  type RefundResolution,
} from "#shared/payment-state/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { squareApi } from "#shared/square.ts";

/* jscpd:ignore-end */

const squareResources = PAYMENT_PROVIDER_RESOURCES.square;

const observedSquareRefund = async (
  charge: PaymentCharge,
): Promise<RefundResolution> => {
  const pending = v.parse(ProviderRefundResourceSchema, charge.pendingRefund);
  const read = await squareApi.readRefund(pending.id);
  if (read.status !== "found") {
    return read.status === "unavailable"
      ? pendingProviderRefund(charge, pending)
      : failedProviderRefund(charge, pending);
  }
  const refund = read.value;
  const remaining = charge.captured.amount - charge.refunded.amount;
  if (
    refund.paymentId !== charge.providerReference.id ||
    refund.amount.amount !== remaining ||
    refund.amount.currency !== charge.captured.currency
  ) {
    return failedProviderRefund(charge, pending);
  }
  if (refund.status === "PENDING")
    return pendingProviderRefund(charge, pending);
  if (refund.status === "FAILED" || refund.status === "REJECTED") {
    return failedProviderRefund(charge, pending);
  }
  return completedProviderRefund(charge, pending);
};

const requestNewSquareRefund: PaymentProvider["refundCharge"] = async (
  charge,
  idempotencyKey,
) => {
  const remaining = {
    amount: charge.captured.amount - charge.refunded.amount,
    currency: charge.captured.currency,
  };
  if (remaining.amount <= 0) return completedProviderRefund(charge, null);
  const result = await squareApi.requestRefund(
    charge.providerReference.id,
    remaining,
    idempotencyKey,
  );
  if (result === null) return failedProviderRefund(charge);
  const refund = squareResources.refund(result.id, charge.providerReference.id);
  if (result.status === "COMPLETED") {
    return completedProviderRefund(charge, refund);
  }
  if (result.status === "PENDING") {
    return pendingProviderRefund(charge, refund);
  }
  return failedProviderRefund(charge, refund);
};

export const refundSquareCharge: PaymentProvider["refundCharge"] =
  makeProviderRefund(observedSquareRefund, requestNewSquareRefund);
