/* jscpd:ignore-start */
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
} from "#shared/payment-helpers.ts";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";
import type { CheckoutIntent, SetupWebhookEndpoint } from "#shared/payments.ts";
import type {
  StripeCheckoutLineItemParams,
  StripeCheckoutSessionCreateParams,
} from "#shared/stripe/client.ts";
import {
  cleanupOldWebhookEndpoints,
  type StripeConnectionTestResult,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe/endpoints.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import type {
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";

/* jscpd:ignore-end */

export const isoFromUnixSeconds = (seconds: unknown): string | undefined =>
  typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;

export type StripeKeyMode = "test" | "live";

export const detectStripeKeyMode = (key: string): StripeKeyMode | null => {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return null;
};

const createCheckoutSession = async (
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<StripeCheckoutSession | null> => {
  const currency = settings.currency.toLowerCase();
  const order = priceCheckout(intent);
  const lineItems = buildProviderLineItems<StripeCheckoutLineItemParams>(
    order,
    currency,
    {
      extra: (extra, cur) => ({
        price_data: {
          currency: cur,
          product_data: { name: extra.name },
          unit_amount: extra.amount,
        },
        quantity: extra.quantity,
      }),
      line: (line, cur) => ({
        price_data: {
          currency: cur,
          product_data: {
            description:
              line.quantity > 1 ? `${line.quantity} Tickets` : "Ticket",
            name: `Ticket: ${line.item.name}`,
          },
          unit_amount: line.chargedUnitAmount,
        },
        quantity: line.quantity,
      }),
    },
  );
  const params: StripeCheckoutSessionCreateParams = {
    cancel_url: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
    line_items: lineItems,
    mode: "payment",
    payment_method_types: ["card"],
    success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    ...(intent.email ? { customer_email: intent.email } : {}),
    metadata: await assembleCheckoutMetadata("stripe", intent, order.total),
  };
  const session = await stripeClientRuntime.run(
    (client) => client.checkout.sessions.create(params),
    ErrorCode.STRIPE_CHECKOUT,
  );
  return session;
};

export interface StripeApi {
  cleanupOldWebhookEndpoints: typeof cleanupOldWebhookEndpoints;
  createCheckoutSession: typeof createCheckoutSession;
  refundPayment: (intentId: string) => Promise<StripeRefund | null>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripeExpandedPaymentIntent | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
}

export const stripeApi: StripeApi = {
  cleanupOldWebhookEndpoints,
  createCheckoutSession,
  refundPayment: async (intentId) => {
    const idempotencyKey = await refundIdempotencyKey("stripe", intentId);
    return stripeClientRuntime.run(
      (client) =>
        client.refunds.create({ payment_intent: intentId }, idempotencyKey),
      ErrorCode.STRIPE_REFUND,
    );
  },
  retrieveCheckoutSession: (id) =>
    stripeClientRuntime.run(
      (client) => client.checkout.sessions.retrieve(id),
      ErrorCode.STRIPE_SESSION,
    ),
  retrievePaymentIntent: (id) =>
    stripeClientRuntime.run(
      (client) => client.paymentIntents.retrieveWithLatestCharge(id),
      ErrorCode.STRIPE_SESSION,
    ),
  setupWebhookEndpoint,
  testStripeConnection,
};
