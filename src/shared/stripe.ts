/* jscpd:ignore-start */
import { ErrorCode, type ErrorCodeType } from "#shared/logger.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { buildProviderLineItems } from "#shared/payment-helpers.ts";
import type { SetupWebhookEndpoint } from "#shared/payments.ts";
import {
  makeProviderResourceTransport,
  type ProviderResourceTransport,
} from "#shared/provider-transport.ts";
import type {
  StripeCheckoutLineItemParams,
  StripeCheckoutSessionCreateParams,
  StripeClient,
} from "#shared/stripe/client.ts";
import {
  cleanupOldWebhookEndpoints,
  type StripeConnectionTestResult,
  setupWebhookEndpoint,
  testStripeConnection,
} from "#shared/stripe/endpoints.ts";
import {
  type StripeLookupResult,
  stripeClientRuntime,
} from "#shared/stripe/runtime.ts";
import type {
  StripeAccount,
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";

/* jscpd:ignore-end */

export const isoFromUnixSeconds = (seconds: number): string =>
  new Date(seconds * 1000).toISOString();

export type StripeKeyMode = "test" | "live";

export const detectStripeKeyMode = (key: string): StripeKeyMode | null => {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return null;
};

const createCheckout = async (
  checkout: PaymentCheckoutCreateSnapshot,
): Promise<StripeCheckoutSession | null> => {
  const lineItems = buildProviderLineItems<StripeCheckoutLineItemParams>(
    checkout,
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
            name: `Ticket: ${line.name}`,
          },
          unit_amount: line.amount,
        },
        quantity: line.quantity,
      }),
    },
    (currency) => currency.toLowerCase(),
  );
  const localPaymentId = encodeURIComponent(checkout.localPaymentId);
  const params: StripeCheckoutSessionCreateParams = {
    cancel_url: `${checkout.baseUrl}/payment/cancel?payment_id=${localPaymentId}&session_id={CHECKOUT_SESSION_ID}`,
    line_items: lineItems,
    mode: "payment",
    payment_method_types: ["card"],
    success_url: `${checkout.baseUrl}/payment/success?payment_id=${localPaymentId}&session_id={CHECKOUT_SESSION_ID}`,
    ...(checkout.bookingIntent.email
      ? { customer_email: checkout.bookingIntent.email }
      : {}),
    metadata: checkout.metadata,
  };
  const session = await stripeClientRuntime.run(
    (client) =>
      client.checkout.sessions.create(params, checkout.localPaymentId),
    ErrorCode.STRIPE_CHECKOUT,
  );
  return session;
};

const stripeResourceTransport = <Value>(
  load: (client: StripeClient, id: string) => Promise<Value>,
  errorCode: ErrorCodeType,
): ProviderResourceTransport<Value, StripeLookupResult<Value>> =>
  makeProviderResourceTransport(
    load,
    stripeClientRuntime.lookup,
    stripeClientRuntime.run,
    errorCode,
  );

const checkoutSessions = stripeResourceTransport(
  (client, id) => client.checkout.sessions.retrieve(id),
  ErrorCode.STRIPE_SESSION,
);
const paymentIntents = stripeResourceTransport(
  (client, id) => client.paymentIntents.retrieveWithLatestCharge(id),
  ErrorCode.STRIPE_SESSION,
);

export interface StripeApi {
  cleanupOldWebhookEndpoints: typeof cleanupOldWebhookEndpoints;
  createCheckout: typeof createCheckout;
  lookupCheckoutSession: (
    id: string,
  ) => Promise<StripeLookupResult<StripeCheckoutSession>>;
  lookupPaymentIntent: (
    id: string,
  ) => Promise<StripeLookupResult<StripeExpandedPaymentIntent>>;
  requestRefund: (
    intentId: string,
    idempotencyKey: string,
  ) => Promise<StripeRefund | null>;
  retrieveAccount: () => Promise<StripeAccount | null>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripeExpandedPaymentIntent | null>;
  retrieveRefund: (id: string) => Promise<StripeLookupResult<StripeRefund>>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
}

export const stripeApi: StripeApi = {
  cleanupOldWebhookEndpoints,
  createCheckout,
  lookupCheckoutSession: checkoutSessions.lookup,
  lookupPaymentIntent: paymentIntents.lookup,
  requestRefund: async (intentId, idempotencyKey) =>
    stripeClientRuntime.run(
      (client) =>
        client.refunds.create({ payment_intent: intentId }, idempotencyKey),
      ErrorCode.STRIPE_REFUND,
    ),
  retrieveAccount: () =>
    stripeClientRuntime.run(
      (client) => client.accounts.retrieve(),
      ErrorCode.STRIPE_SESSION,
    ),
  retrieveCheckoutSession: checkoutSessions.retrieve,
  retrievePaymentIntent: paymentIntents.retrieve,
  retrieveRefund: (id) =>
    stripeClientRuntime.lookup(
      (client) => client.refunds.retrieve(id),
      ErrorCode.STRIPE_REFUND,
    ),
  setupWebhookEndpoint,
  testStripeConnection,
};
