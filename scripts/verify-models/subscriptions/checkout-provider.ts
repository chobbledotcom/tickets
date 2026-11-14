/** Execute the real Stripe callers with a local client. Replies are assumptions. */
import type { StripeCheckoutSessionCreateParams } from "#shared/stripe/client.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import type {
  StripeCheckoutSession,
  StripeInvoicePayments,
  StripeSubscription,
} from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import {
  type RecurringInterval,
  type SubscriptionStart,
  SubscriptionStatusSchema,
} from "#shared/subscriptions/plan.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";
import { intentOf, item } from "./checkout-admission.ts";
import { type CheckoutFacts, expectedCharge } from "./checkout-facts.ts";
import { providerSubscription } from "./environment.ts";

export type CheckoutBoundary = {
  request?: (
    params: StripeCheckoutSessionCreateParams,
  ) => StripeCheckoutSessionCreateParams;
  session?: (session: StripeCheckoutSession) => StripeCheckoutSession;
  subscription?: (subscription: StripeSubscription) => StripeSubscription;
  invoice?: (invoice: StripeInvoicePayments) => StripeInvoicePayments;
  subscriptionRead?: (id: string) => void;
  stored?: () => Promise<void>;
};
export type CheckoutCase = {
  scenario: string;
  index: number;
  interval: RecurringInterval;
  now: string;
  next: string;
  policy: TaxPolicy;
  start: SubscriptionStart;
  quantity: number;
  price: number;
};

/** Each UTC start has its interval and literal next charge, without Temporal.
 * The order sets each scenario number, so this is a list and not a record. */
/* jscpd:ignore-start -- a list of strings, not code */
const dates: readonly (readonly [
  now: string,
  interval: RecurringInterval,
  next: string,
])[] = [
  ["2026-12-28T10:15:00Z", "week", "2027-01-04T10:15:00Z"],
  ["2026-01-31T10:15:00Z", "month", "2026-02-28T10:15:00Z"],
  ["2024-01-31T10:15:00Z", "month", "2024-02-29T10:15:00Z"],
  ["2024-02-29T10:15:00Z", "year", "2025-02-28T10:15:00Z"],
  ["2026-12-31T10:15:00Z", "month", "2027-01-31T10:15:00Z"],
];
/* jscpd:ignore-end */
const policies: readonly TaxPolicy[] = [
  { mode: "none" },
  { mode: "add_to_total", rateBasisPoints: 2000 },
  { mode: "calculate_from_total", rateBasisPoints: 2000 },
  { mode: "add_to_total", rateBasisPoints: 0 },
  { mode: "calculate_from_total", rateBasisPoints: 10000 },
];
export const checkoutCases = (): CheckoutCase[] => {
  const cases: CheckoutCase[] = [];
  for (const [now, interval, next] of dates)
    for (const status of SubscriptionStatusSchema.options) {
      const policy = policies[cases.length % policies.length];
      if (policy === undefined) throw new Error("Checkout has no tax domain");
      const index = cases.length + 1;
      const quantity = (index % 2) + 1;
      const price = index % 3 === 0 ? 3 : 501;
      const rate = policy.mode === "none" ? 0 : policy.rateBasisPoints;
      cases.push({
        index,
        interval,
        next,
        now,
        policy,
        price,
        quantity,
        scenario: `checkout-${index}`,
        start: {
          amount: expectedCharge(price * quantity, policy.mode, rate),
          id: `sub_model_${index}`,
          interval,
          listingId: index * 10 + 1,
          status,
        },
      });
    }
  return cases;
};

export const observeCheckout = async (
  example: CheckoutCase,
  boundary: CheckoutBoundary,
): Promise<{
  request: CheckoutFacts["requests"][number];
  start: SubscriptionStart;
}> => {
  const {
    scenario,
    index,
    interval,
    now,
    next,
    policy,
    quantity,
    price,
    start,
  } = example;
  const requestId = `request_${index}`;
  const firstInvoice = `in_first_${index}`;
  const reference = `pi_first_${index}`;
  const sessionId = `cs_model_${index}`;
  let params: StripeCheckoutSessionCreateParams | undefined;
  let invoiceRead = "";
  let subscriptionRead = "";
  const session: StripeCheckoutSession = {
    amount_total: 1000 * quantity + 137,
    created: Date.parse(now) / 1000,
    currency: "gbp",
    expires_at: Date.parse(now) / 1000 + 3600,
    id: sessionId,
    invoice: firstInvoice,
    metadata: {
      email: "model@example.invalid",
      items: `[{"e":${start.listingId},"q":${quantity},"p":${1000 * quantity}}]`,
      name: "Synthetic member",
    },
    mode: "subscription",
    payment_intent: null,
    payment_status: "paid",
    status: "complete",
    subscription: start.id,
    url: "https://example.invalid/checkout",
  };
  const client = stripeClientRuntime.create("sk_test_subscription_models");
  client.checkout.sessions.create = async (sent) => {
    params = boundary.request?.(sent) ?? sent;
    return session;
  };
  client.subscriptions.retrieve = async (id) => {
    subscriptionRead = id;
    boundary.subscriptionRead?.(id);
    const resource = providerSubscription(start);
    return boundary.subscription?.(resource) ?? resource;
  };
  client.invoices.retrieveWithPayments = async (id) => {
    invoiceRead = id;
    // A later renewal has a different intent; selecting it must not pass.
    const invoice: StripeInvoicePayments = {
      id,
      payments: {
        data: [
          {
            payment: { payment_intent: "pi_unpaid", type: "payment_intent" },
            status: "open",
          },
          { payment: { payment_intent: null, type: "charge" }, status: "paid" },
          {
            payment: {
              payment_intent:
                id === firstInvoice ? reference : `pi_renewal_${index}`,
              type: "payment_intent",
            },
            status: "paid",
          },
        ],
      },
    };
    return boundary.invoice?.(invoice) ?? invoice;
  };
  client.checkout.sessions.retrieve = async () =>
    boundary.session?.(session) ?? session;
  const originalGet = stripeClientRuntime.get;
  const originalRun = stripeClientRuntime.runCheckout;
  const originalNow = Date.now;
  stripeClientRuntime.get = async () => client;
  stripeClientRuntime.runCheckout = async (run) => await run(client);
  Date.now = () => Date.parse(now);
  try {
    const intent = {
      ...intentOf([
        {
          ...item,
          listingId: start.listingId,
          quantity,
          recurring: { interval, price },
        },
        {
          ...item,
          listingId: start.listingId + 1,
          name: "Model ordinary ticket",
          quantity: 1,
          recurring: undefined,
          slug: "model-ordinary",
          unitPrice: 137,
        },
      ]),
      taxPolicy: policy,
    };
    // This executes the production request composer, not a copy of its params.
    await stripeApi.createCheckoutSession(intent, "https://example.invalid");
    if (params === undefined)
      throw new Error("Stripe checkout issued no request");
    const observed = await stripePaymentProvider.retrieveSession(sessionId);
    if (
      observed === null ||
      !("id" in observed) ||
      observed.subscription === undefined
    )
      throw new Error("Checkout supplied no observed subscription");
    const recurring = params.line_items.filter(
      (line) => line.price_data.recurring !== undefined,
    );
    const once = params.line_items.filter(
      (line) => line.price_data.recurring === undefined,
    );
    const [initial, ordinary] = once;
    if (initial === undefined || ordinary === undefined)
      throw new Error("Checkout supplied incomplete one-time lines");
    const [line] = recurring;
    if (line === undefined || params.subscription_data === undefined)
      throw new Error("Checkout supplied no recurring request");
    const rate = policy.mode === "none" ? 0 : policy.rateBasisPoints;
    return {
      request: {
        attempt: 1,
        expectedAmount: start.amount,
        expectedInitial: expectedCharge(
          1000 * quantity + 137,
          policy.mode,
          rate,
        ),
        expectedInterval: interval,
        expectedOneTimeLines:
          policy.mode === "add_to_total" && rate > 0 ? 3 : 2,
        expectedOrdinaryInitial: 137,
        expectedQuantity: quantity,
        expectedReference: reference,
        expectedSubscribedInitial: 1000 * quantity,
        expectedTrialEnd: Date.parse(next) / 1000,
        firstInvoice,
        initialQuantity: initial.quantity,
        interval: line.price_data.recurring?.interval ?? "",
        invoiceRead,
        listing: start.listingId,
        metadataListing: Number(params.subscription_data.metadata.listing_id),
        mode: params.mode,
        oneTimeAmount: once.reduce(
          (sum, entry) => sum + entry.quantity * entry.price_data.unit_amount,
          0,
        ),
        oneTimeLines: once.length,
        ordinaryInitial: ordinary.quantity * ordinary.price_data.unit_amount,
        paymentReference: observed.paymentReference,
        rate,
        recurringAmount: line.price_data.unit_amount,
        recurringLines: recurring.length,
        recurringQuantity: line.quantity,
        request: requestId,
        scenario,
        session: observed.id,
        status: observed.subscription.status,
        subscribedInitial: initial.quantity * initial.price_data.unit_amount,
        subscription: start.id,
        subscriptionRead,
        taxMode: policy.mode,
        trialEnd: params.subscription_data.trial_end,
      },
      start: observed.subscription,
    };
  } finally {
    Date.now = originalNow;
    stripeClientRuntime.get = originalGet;
    stripeClientRuntime.runCheckout = originalRun;
  }
};
