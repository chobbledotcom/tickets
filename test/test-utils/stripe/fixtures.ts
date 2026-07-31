import { assertExists } from "@std/assert";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import { STRIPE_API_VERSION } from "#shared/stripe/request.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import type {
  StripeCharge,
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";
import type { Listing } from "#shared/types.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";

/**
 * Stores a Stripe secret key in the database and hands back the ready client.
 * Every Stripe test that needs a live client starts this way, so the "set the
 * key and fetch the client dance lives here once.
 */
export const stripeClient = async (
  key = "sk_test_mock",
): Promise<StripeClient> => {
  await settings.update.stripe.secretKey(key);
  const client = await stripeClientRuntime.get();
  assertExists(client, "Stripe test client was not created");
  return client;
};

/** A complete checkout-session response with per-test fields overridden. */
export const stripeCheckoutSession = (
  overrides: Partial<StripeCheckoutSession> = {},
): StripeCheckoutSession => ({
  amount_total: 1000,
  created: 123,
  currency: "gbp",
  id: "cs_test",
  livemode: false,
  metadata: {},
  payment_intent: "pi_test",
  payment_status: "paid",
  status: "complete",
  url: "https://checkout.stripe.com/c/pay/cs_test",
  ...overrides,
});

/** A complete captured charge with a cumulative partial refund. */
export const stripeCharge = (
  overrides: Partial<StripeCharge> = {},
): StripeCharge => ({
  amount: 1000,
  amount_captured: 1000,
  amount_refunded: 400,
  captured: true,
  created: 125,
  currency: "gbp",
  id: "ch_test",
  livemode: false,
  paid: true,
  payment_intent: "pi_test",
  refunded: false,
  ...overrides,
});

/** A succeeded PaymentIntent with its latest charge expanded. */
export const stripePaymentIntent = (
  overrides: Partial<StripeExpandedPaymentIntent> = {},
): StripeExpandedPaymentIntent => ({
  amount: 1000,
  amount_received: 1000,
  created: 124,
  currency: "gbp",
  id: "pi_test",
  latest_charge: stripeCharge(),
  livemode: false,
  status: "succeeded",
  ...overrides,
});

/** A complete refund response for the latest charge. */
export const stripeRefund = (
  overrides: Partial<StripeRefund> = {},
): StripeRefund => ({
  amount: 1000,
  charge: "ch_test",
  created: 126,
  currency: "gbp",
  id: "re_test_1",
  payment_intent: "pi_test_1",
  status: "succeeded",
  ...overrides,
});

/** A checkout line that mirrors a listing's id, name, slug, and price. */
export const lineFor = (listing: Listing, quantity = 1): CheckoutItem =>
  checkoutItem({
    listingId: listing.id,
    name: listing.name,
    quantity,
    slug: listing.slug,
    unitPrice: listing.unit_price,
  });

/** A Stripe balance response, in test or live mode. */
export const balanceResult = (livemode: boolean) => ({
  available: [],
  livemode,
  object: "balance",
  pending: [],
});

/** A balance.retrieve behaviour that resolves to a healthy balance. */
export const okBalance = (livemode: boolean) => () =>
  Promise.resolve(balanceResult(livemode));

/** A webhookEndpoints.list behaviour that resolves to no endpoints. */
export const noWebhooks = () => Promise.resolve({ data: [] });

/**
 * Stubs both the balance check and the webhook-endpoints list for a connection
 * test, restoring both afterwards. Most testStripeConnection cases drive these
 * two calls together, so they are set up together here.
 */
export const withBalanceAndList = (
  client: StripeClient,
  balance: StripeClient["balance"]["retrieve"],
  list: StripeClient["webhookEndpoints"]["list"],
  body: () => void | Promise<void>,
): Promise<void> =>
  withMocks(
    () => ({
      balanceSpy: stub(client.balance, "retrieve", balance),
      listSpy: stub(client.webhookEndpoints, "list", list),
    }),
    body,
  );

/** Ask stripe-node to build the same webhook signature Stripe sends. */
export const signedHeader = async (
  secret: string,
  payload: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe("sk_test_webhook_oracle", {
    apiVersion: STRIPE_API_VERSION,
  });
  return await stripe.webhooks.generateTestHeaderStringAsync({
    payload,
    secret,
    timestamp,
  });
};

/** Ask stripe-node to serialize and sign a test webhook event. */
export const signedWebhook = async (
  event: unknown,
  secret: string,
): Promise<{ payload: string; signature: string }> => {
  const payload = JSON.stringify(event);
  return { payload, signature: await signedHeader(secret, payload) };
};
