import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { settings } from "#db/settings.ts";
import type { Currency } from "#payment/money.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  authorizeDurableRefundSend,
} from "#payment/refund-provider-authorization.ts";
import type { ChargeMoney } from "#payment/resources.ts";
import type { CheckoutItem, WebhookEvent } from "#shared/payments.ts";
import type { StripeClient } from "#shared/stripe/client.ts";
import { STRIPE_API_VERSION, StripeApiError } from "#shared/stripe/request.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import type {
  StripeCheckoutSession,
  StripeRefund,
} from "#shared/stripe/schemas.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { withMocks } from "#test-utils/mocks.ts";
import type { Listing } from "#types";

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
  metadata: {},
  payment_intent: "pi_test",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_test",
  ...overrides,
});

/** A complete Stripe refund answer with per-test fields overridden. */
export const stripeRefund = (
  overrides: Partial<StripeRefund> = {},
): StripeRefund => ({
  amount: 1000,
  currency: "gbp",
  id: "re_1",
  payment_intent: "pi_1",
  status: "succeeded",
  ...overrides,
});

/** Stripe charge money after the provider boundary has normalised it. */
export const stripeChargeMoney = (
  amount = 1000,
  returned = 0,
  currency: Currency = "GBP",
): ChargeMoney => ({
  captured: { amount, currency },
  confirmedRefunded: { amount: returned, currency },
  refunds: [],
});

/** The independently read charge facts passed into a Stripe refund. */
export const stripeRefundRequest = (
  paymentReference = "pi_1",
  amount = 1000,
  currency: Currency = "GBP",
  idempotencyKey = `test-refund:${paymentReference}:1`,
): AuthorizedRefundRequest<"stripe"> =>
  authorizeDurableRefundSend(
    {
      charge: stripeChargeMoney(amount, 0, currency),
      paymentReference,
    },
    {
      capability: "keyed",
      generation: 1,
      idempotencyKey,
      identityIndex: `test-refund-index:${paymentReference}:1`,
      provider: "stripe",
    },
  );

/** The stable provider-call facts for a refund minted by the durable engine. */
export const stripeRefundRequestShape = (
  paymentReference = "pi_1",
  amount = 1000,
  currency: Currency = "GBP",
): ReturnType<typeof expect.objectContaining> =>
  expect.objectContaining({
    authorization: expect.objectContaining({
      capability: "keyed",
      generation: 1,
      idempotencyKey: expect.any(String),
      identityIndex: expect.any(String),
      provider: "stripe",
    }),
    charge: stripeChargeMoney(amount, 0, currency),
    paymentReference,
  });

/** A completed Stripe refund answer for route tests that stub the adapter. */
export const completedStripeRefund = (
  paymentReference = "pi_1",
  refundId = "re_1",
  amount = 1000,
  currency: Currency = "GBP",
): Extract<RefundAttemptResult, { kind: "completed" }> => ({
  amount: { amount, currency },
  kind: "completed",
  proof: {
    kind: "named_refund",
    refund: {
      id: refundId,
      kind: "stripe_refund",
      parentId: paymentReference,
      provider: "stripe",
    },
  },
});

/** Stub behaviour that completes exactly the Stripe refund it was asked for. */
export const answerCompletedStripeRefund =
  (refundId = "re_1") =>
  (request: AuthorizedRefundRequest): Promise<RefundAttemptResult> =>
    Promise.resolve(
      completedStripeRefund(
        request.paymentReference,
        refundId,
        request.charge.captured.amount,
        request.charge.captured.currency,
      ),
    );

/** A typed Stripe API refusal with no private provider details. */
export const stripeApiError = (statusCode: number): StripeApiError =>
  new StripeApiError("Stripe refused the request", {
    code: undefined,
    requestId: undefined,
    statusCode,
    type: undefined,
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
export const noWebhooks = () => Promise.resolve({ data: [], has_more: false });

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
  event: WebhookEvent,
  secret: string,
): Promise<{ payload: string; signature: string }> => {
  const payload = JSON.stringify(event);
  return { payload, signature: await signedHeader(secret, payload) };
};
