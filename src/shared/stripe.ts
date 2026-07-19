/* jscpd:ignore-start */
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  SetupWebhookEndpoint,
  WebhookSetupResult,
} from "#shared/payments.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import {
  cleanupOldWebhookEndpointsImpl,
  type StripeConnectionTestResult,
  setupWebhookEndpointImpl,
  testStripeConnectionImpl,
} from "#shared/stripe/endpoints.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import type {
  StripeCheckoutSession,
  StripePaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";

/* jscpd:ignore-end */

type CheckoutResult = StripeCheckoutSession | null;

export type StripeCheckoutFields = {
  id: string;
  payment_status: string;
  payment_intent: string | null;
  metadata: Record<string, string> | null;
  amount_total: number | null;
  created: number;
};

const narrowCheckoutSession = (
  session: StripeCheckoutSession,
): StripeCheckoutFields => ({
  amount_total: session.amount_total,
  created: session.created,
  id: session.id,
  metadata: session.metadata,
  payment_intent: session.payment_intent,
  payment_status: session.payment_status,
});

export const isoFromUnixSeconds = (seconds: unknown): string | undefined =>
  typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;

export type StripePaymentIntentFields = {
  id: string;
  latest_charge: { refunded: boolean } | null;
};

const narrowPaymentIntent = (
  intent: StripePaymentIntent,
): StripePaymentIntentFields => ({
  id: intent.id,
  latest_charge:
    intent.latest_charge &&
    typeof intent.latest_charge === "object" &&
    "refunded" in intent.latest_charge
      ? { refunded: intent.latest_charge.refunded }
      : null,
});

export type StripeKeyMode = "test" | "live";

export const detectStripeKeyMode = (key: string): StripeKeyMode | null => {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return null;
};

type StripeCheckoutLineItem = {
  price_data: {
    currency: string;
    product_data: { description?: string; name: string };
    unit_amount: number;
  };
  quantity: number;
};

const createCheckoutSessionImpl = async (
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<CheckoutResult> => {
  const currency = settings.currency.toLowerCase();
  const order = priceCheckout(intent);
  const lineItems = buildProviderLineItems<StripeCheckoutLineItem>(
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
  const params = {
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

export const stripeApi: {
  cleanupOldWebhookEndpoints: typeof cleanupOldWebhookEndpointsImpl;
  createCheckoutSession: typeof createCheckoutSessionImpl;
  getStripeClient: () => Promise<StripeClient | null>;
  refundPayment: (intentId: string) => Promise<StripeRefund | null>;
  resetStripeClient: () => void;
  retrieveCheckoutSession: (id: string) => Promise<StripeCheckoutFields | null>;
  retrievePaymentIntent: (
    id: string,
  ) => Promise<StripePaymentIntentFields | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
} = {
  cleanupOldWebhookEndpoints: cleanupOldWebhookEndpointsImpl,
  createCheckoutSession: createCheckoutSessionImpl,
  getStripeClient: stripeClientRuntime.get,
  refundPayment: (intentId) =>
    stripeClientRuntime.run(
      (client) => client.refunds.create({ payment_intent: intentId }),
      ErrorCode.STRIPE_REFUND,
    ),
  resetStripeClient: stripeClientRuntime.reset,
  retrieveCheckoutSession: async (id) => {
    const session = await stripeClientRuntime.run(
      (client) => client.checkout.sessions.retrieve(id),
      ErrorCode.STRIPE_SESSION,
    );
    return session ? narrowCheckoutSession(session) : null;
  },
  retrievePaymentIntent: async (id) => {
    const intent = await stripeClientRuntime.run(
      (client) =>
        client.paymentIntents.retrieve(id, { expand: ["latest_charge"] }),
      ErrorCode.STRIPE_SESSION,
    );
    return intent ? narrowPaymentIntent(intent) : null;
  },
  setupWebhookEndpoint: setupWebhookEndpointImpl,
  testStripeConnection: testStripeConnectionImpl,
};

export const setupWebhookEndpoint = (
  ...args: Parameters<typeof setupWebhookEndpointImpl>
): Promise<WebhookSetupResult> => stripeApi.setupWebhookEndpoint(...args);

export const cleanupOldWebhookEndpoints = (
  ...args: Parameters<typeof cleanupOldWebhookEndpointsImpl>
): Promise<void> => stripeApi.cleanupOldWebhookEndpoints(...args);

export const getStripeClient = (): Promise<StripeClient | null> =>
  stripeApi.getStripeClient();
export const resetStripeClient = (): void => stripeApi.resetStripeClient();
export const retrieveCheckoutSession = (
  id: string,
): Promise<StripeCheckoutFields | null> =>
  stripeApi.retrieveCheckoutSession(id);
export const retrievePaymentIntent = (
  id: string,
): Promise<StripePaymentIntentFields | null> =>
  stripeApi.retrievePaymentIntent(id);
export const refundPayment = (id: string): Promise<StripeRefund | null> =>
  stripeApi.refundPayment(id);
export const createCheckoutSession = (
  intent: CheckoutIntent,
  baseUrl: string,
): Promise<CheckoutResult> => stripeApi.createCheckoutSession(intent, baseUrl);
export const testStripeConnection = (): Promise<StripeConnectionTestResult> =>
  stripeApi.testStripeConnection();
