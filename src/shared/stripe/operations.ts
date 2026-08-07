import { ErrorCode } from "#shared/logger.ts";
import type { ClientRunner } from "#shared/payment-helpers.ts";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";
import type { StripeClient } from "./client.ts";
import type {
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "./schemas.ts";

export interface StripePaymentOperations {
  refundPayment: (intentId: string) => Promise<StripeRefund | null>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripeExpandedPaymentIntent | null>;
}

/** Bind payment reads and refunds to one Stripe client runner. */
export const createStripePaymentOperations = (
  run: ClientRunner<StripeClient>,
): StripePaymentOperations => ({
  refundPayment: async (intentId) => {
    const idempotencyKey = await refundIdempotencyKey("stripe", intentId);
    return run(
      (client) =>
        client.refunds.create({ payment_intent: intentId }, idempotencyKey),
      ErrorCode.STRIPE_REFUND,
    );
  },
  retrieveCheckoutSession: (id) =>
    run(
      (client) => client.checkout.sessions.retrieve(id),
      ErrorCode.STRIPE_SESSION,
    ),
  retrievePaymentIntent: (id) =>
    run(
      (client) => client.paymentIntents.retrieveWithLatestCharge(id),
      ErrorCode.STRIPE_SESSION,
    ),
});
