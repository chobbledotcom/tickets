import { settings } from "#db/settings.ts";
import { checkoutMetadata } from "#payment/checkout-session.ts";
import type { Money } from "#payment/money.ts";
import { askProvider, type ProviderCall } from "#payment/provider-call.ts";
import {
  providerFailureOf,
  requireProviderFailure,
  withExactRefundMoney,
} from "#payment/provider-failures.ts";
import { providerLineCopy } from "#payment/provider-line-copy.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  judgedBy,
  providerResourceReader,
  refuseUnless,
} from "#payment/provider-resource-read.ts";
import {
  REFUND_NOT_SENT,
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#payment/refund-attempt.ts";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { CHECKOUT_WINDOW_MINUTES } from "#shared/limits.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowSeconds } from "#shared/now.ts";
import type { CheckoutIntent, SetupWebhookEndpoint } from "#shared/payments.ts";
import { buildProviderLineItems } from "#shared/provider-line-items.ts";
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
  sanitizeStripeError,
  stripeClientRuntime,
} from "#shared/stripe/runtime.ts";
import type {
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeInvoicePayments,
  StripeRefund,
  StripeSubscription,
} from "#shared/stripe/schemas.ts";
import {
  type SubscriptionItem,
  subscriptionItemOrNull,
} from "#shared/subscriptions/checkout-rules.ts";
import {
  firstRecurringChargeAt,
  recurringCharge,
} from "#shared/subscriptions/plan.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

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

/** Seconds of headroom added to a Stripe session's expiry, so the configured
 *  window still clears Stripe's 30-minute floor once the request's own
 *  latency is counted. */
export const CHECKOUT_EXPIRY_MARGIN_S = 60;

/** Stripe's own ceiling for a checkout session's expiry: 24 hours. */
const STRIPE_MAX_EXPIRY_S = 24 * 60 * 60;

/** A session's expiry: the configured window plus the latency margin, capped
 *  at Stripe's own 24-hour ceiling. */
export const checkoutExpiry = (now: number, windowMinutes: number): number =>
  Math.min(
    now + windowMinutes * 60 + CHECKOUT_EXPIRY_MARGIN_S,
    now + STRIPE_MAX_EXPIRY_S,
  );

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
          product_data: providerLineCopy(line.item, line.quantity),
          unit_amount: line.chargedUnitAmount,
        },
        quantity: line.quantity,
      }),
    },
  );
  // Build the signed metadata before the expiry, so the window is measured
  // from just before the request reaches Stripe.
  const metadata = await checkoutMetadata("stripe", intent, order, order.total);
  const subscription = subscriptionItemOrNull(intent);
  const params: StripeCheckoutSessionCreateParams = {
    cancel_url: `${baseUrl}/payment/cancel?session_id={CHECKOUT_SESSION_ID}`,
    // Stripe ends its own page at this time, so no stored handle and no
    // task are needed: the checkout window is the whole fact. A short margin
    // keeps the window above Stripe's 30-minute floor once the request's own
    // latency is counted. The ceiling keeps a full-day window inside it.
    expires_at: checkoutExpiry(nowSeconds(), CHECKOUT_WINDOW_MINUTES),
    line_items: lineItems,
    mode: "payment",
    payment_method_types: ["card"],
    success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
    ...(intent.email ? { customer_email: intent.email } : {}),
    metadata,
    ...(subscription === null
      ? {}
      : subscriptionParams(
          subscription,
          currency,
          order.tax.policy,
          lineItems,
        )),
  };
  const session = await stripeClientRuntime.runCheckout(
    (client) => client.checkout.sessions.create(params),
    ErrorCode.STRIPE_CHECKOUT,
  );
  return session;
};

/**
 * The changes a subscription line makes to a checkout. The recurring line
 * charges the whole quantity as one unit, so VAT rounds once on the whole
 * amount. The trial holds it back for one period, and the one-time lines
 * still charge at once. The metadata names the listing whose booking row
 * keeps the plan.
 */
const subscriptionParams = (
  item: SubscriptionItem,
  currency: string,
  policy: TaxPolicy,
  lineItems: readonly StripeCheckoutLineItemParams[],
): Pick<
  StripeCheckoutSessionCreateParams,
  "line_items" | "mode" | "subscription_data"
> => ({
  line_items: [
    ...lineItems,
    {
      price_data: {
        currency,
        product_data: providerLineCopy(item, item.quantity),
        recurring: { interval: item.recurring.interval },
        unit_amount: recurringCharge(
          { id: item.listingId, recurringPrice: item.recurring.price },
          item.quantity,
          policy,
        ),
      },
      quantity: 1,
    },
  ],
  mode: "subscription",
  subscription_data: {
    metadata: { listing_id: String(item.listingId) },
    trial_end: firstRecurringChargeAt(nowSeconds(), item.recurring.interval),
  },
});

export interface StripeApi {
  cancelSubscription: (id: string) => Promise<ProviderRead<StripeSubscription>>;
  cleanupOldWebhookEndpoints: typeof cleanupOldWebhookEndpoints;
  createCheckoutSession: typeof createCheckoutSession;
  readInvoicePayments: (
    id: string,
  ) => Promise<ProviderRead<StripeInvoicePayments>>;
  readPaymentIntent: (
    id: string,
  ) => Promise<ProviderRead<StripeExpandedPaymentIntent>>;
  readSubscription: (id: string) => Promise<ProviderRead<StripeSubscription>>;
  refundCharge: (
    request: AuthorizedRefundRequest<"stripe">,
  ) => Promise<RefundAttemptResult>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
}

/** Read one Stripe resource on the configured client. */
const readStripeResource = providerResourceReader(
  () => stripeClientRuntime.get(),
  (error) => providerFailureOf(error)?.read,
);

/** Ask Stripe one thing on the configured client, answering as the caller says
 *  an unconfigured Stripe must be answered. */
const askStripe = async <Answer, Result>(
  call: Omit<ProviderCall<StripeClient, Answer, Result>, "account">,
): Promise<Result> =>
  askProvider({ ...call, account: await stripeClientRuntime.get() });

/** One Stripe call that answers with the resource `id` names. An answer about
 * another resource is a refused read. */
const oneResource =
  <Resource extends { id: string }>(
    ask: (client: StripeClient, id: string) => Promise<Resource>,
  ) =>
  (id: string): Promise<ProviderRead<Resource>> =>
    readStripeResource(
      (client) => ask(client, id),
      judgedBy([
        refuseUnless(
          "mismatched_id",
          (resource: Resource) => resource.id === id,
        ),
      ]),
    );

const readPaymentIntent = oneResource((client, id) =>
  client.paymentIntents.retrieveWithLatestCharge(id, {
    maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe,
  }),
);

const readSubscription = oneResource((client, id) =>
  client.subscriptions.retrieve(id),
);

/** Stripe refuses to cancel a subscription that has already ended. */
const cancelSubscription = oneResource((client, id) =>
  client.subscriptions.cancel(id),
);

const readInvoicePayments = oneResource((client, id) =>
  client.invoices.retrieveWithPayments(id),
);

type StripeRefundStatus = Exclude<StripeRefund["status"], null>;
type StripeRefundAnswer = (
  amount: Money,
  refund: StripeRefund,
) => RefundAttemptResult;

const movedStripeRefund =
  (kind: "accepted" | "completed"): StripeRefundAnswer =>
  (amount, refund) => ({
    amount,
    kind,
    proof: {
      kind: "named_refund",
      refund: {
        id: refund.id,
        kind: "stripe_refund",
        parentId: refund.payment_intent,
        provider: "stripe",
      },
    },
  });

const rejectedStripeRefund =
  (reason: "canceled" | "failed"): StripeRefundAnswer =>
  () => ({
    kind: "rejected",
    reason,
  });

const STRIPE_REFUND_ANSWERS = {
  canceled: rejectedStripeRefund("canceled"),
  failed: rejectedStripeRefund("failed"),
  pending: movedStripeRefund("accepted"),
  requires_action: movedStripeRefund("accepted"),
  succeeded: movedStripeRefund("completed"),
} as const satisfies Record<StripeRefundStatus, StripeRefundAnswer>;

const stripeRefundResult = (
  request: RefundRequest,
  refund: StripeRefund,
): RefundAttemptResult =>
  withExactRefundMoney(
    request,
    refund.payment_intent,
    refund.amount,
    refund.currency,
    (amount) => {
      if (refund.status === null) {
        return uncertainRefund("unsupported_status");
      }
      return STRIPE_REFUND_ANSWERS[refund.status](amount, refund);
    },
  );

const refundCharge = (
  request: AuthorizedRefundRequest<"stripe">,
): Promise<RefundAttemptResult> =>
  askStripe({
    ask: (client) =>
      client.refunds.create(
        {
          amount: request.charge.captured.amount,
          payment_intent: request.paymentReference,
        },
        request.authorization.idempotencyKey,
        { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
      ),
    failure: (error) => requireProviderFailure(error).refund,
    judge: (refund) => stripeRefundResult(request, refund),
    unconfigured: REFUND_NOT_SENT,
  });

class StripeCheckoutReadError extends Error {
  constructor(reason: string) {
    super(`Stripe checkout could not be read (${reason})`);
    this.name = "StripeCheckoutReadError";
  }
}

/** A checkout Stripe says is gone is a genuine absence. Anything else stops
 *  the read loudly, after one logged line naming what Stripe answered. */
const checkoutReadFailure = (error: unknown): StripeCheckoutSession | null => {
  const failure = providerFailureOf(error);
  if (failure?.read.status === "missing") return null;
  logError({
    code: ErrorCode.STRIPE_SESSION,
    detail: sanitizeStripeError(error),
  });
  throw new StripeCheckoutReadError(
    failure === undefined
      ? "unexpected_failure"
      : `${failure.read.status}:${failure.read.reason}`,
  );
};

const retrieveCheckoutSession = (
  id: string,
): Promise<StripeCheckoutSession | null> =>
  askStripe({
    ask: (client) => client.checkout.sessions.retrieve(id),
    failure: checkoutReadFailure,
    judge: (session) => session,
    unconfigured: null,
  });

export const stripeApi: StripeApi = {
  cancelSubscription,
  cleanupOldWebhookEndpoints,
  createCheckoutSession,
  readInvoicePayments,
  readPaymentIntent,
  readSubscription,
  refundCharge,
  retrieveCheckoutSession,
  setupWebhookEndpoint,
  testStripeConnection,
};
