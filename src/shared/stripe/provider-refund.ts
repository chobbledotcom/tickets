import type { PaymentCharge } from "#shared/db/payments/types.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  completedProviderRefund,
  failedProviderRefund,
  makeProviderRefund,
  makeProviderRefundRequest,
  pendingProviderRefund,
} from "#shared/payment-runtime/provider-refund.ts";
import type { RefundResolution } from "#shared/payment-state/resources.ts";
import type { PaymentProvider } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import type { StripeRefund } from "./schemas.ts";

const stripeResources = PAYMENT_PROVIDER_RESOURCES.stripe;

const validateRefundForCharge = (
  charge: PaymentCharge,
  refund: StripeRefund,
  expectedId?: string,
): void => {
  const remaining = charge.captured.amount - charge.refunded.amount;
  if (
    !refund.id.startsWith("re_") ||
    (expectedId !== undefined && refund.id !== expectedId) ||
    refund.payment_intent !== charge.providerReference.id ||
    refund.amount !== remaining ||
    refund.currency.toUpperCase() !== charge.captured.currency
  ) {
    throw new Error(
      `Stripe refund ${refund.id} does not match charge ${charge.providerReference.id}`,
    );
  }
};

const resolveStripeRefund = (
  charge: PaymentCharge,
  refund: StripeRefund,
): RefundResolution => {
  const resource = stripeResources.refund(
    refund.id,
    charge.providerReference.id,
  );
  if (refund.status === "succeeded") {
    return completedProviderRefund(charge, resource);
  }
  if (refund.status === "pending" || refund.status === "requires_action") {
    return pendingProviderRefund(charge, resource);
  }
  return failedProviderRefund(charge, resource);
};

const checkPendingStripeRefund = async (
  charge: PaymentCharge,
): Promise<RefundResolution> => {
  const persisted = charge.pendingRefund;
  if (persisted === null || !persisted.id.startsWith("re_")) {
    throw new Error(`Stripe charge ${charge.id} has no valid pending refund`);
  }
  const lookup = await stripeApi.retrieveRefund(persisted.id);
  if (lookup.status === "invalid") {
    throw new Error(`Stripe refund ${persisted.id} returned invalid data`);
  }
  if (lookup.status !== "found") {
    return pendingProviderRefund(charge, persisted);
  }
  validateRefundForCharge(charge, lookup.value, persisted.id);
  return resolveStripeRefund(charge, lookup.value);
};

const requestNewStripeRefund: PaymentProvider["refundCharge"] =
  makeProviderRefundRequest(
    (reference, idempotencyKey) =>
      stripeApi.requestRefund(reference, idempotencyKey),
    (charge, result) => {
      validateRefundForCharge(charge, result);
      return resolveStripeRefund(charge, result);
    },
  );

export const refundStripeCharge: PaymentProvider["refundCharge"] =
  makeProviderRefund(checkPendingStripeRefund, requestNewStripeRefund);
