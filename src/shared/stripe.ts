/* jscpd:ignore-start */
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { Money } from "#shared/payment/money.ts";
import {
  type ProviderFailure,
  providerFailure,
  withExactRefundMoney,
} from "#shared/payment/provider-failures.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#shared/payment/refund-attempt.ts";
import { REFUND_NETWORK_RETRIES } from "#shared/payment/refund-network.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
} from "#shared/payment-helpers.ts";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";
import type { CheckoutIntent, SetupWebhookEndpoint } from "#shared/payments.ts";
import type {
  StripeCheckoutLineItemParams,
  StripeCheckoutSessionCreateParams,
  StripeClient,
} from "#shared/stripe/client.ts";
import {
  cleanupOldWebhookEndpoints,
  setupWebhookEndpoint,
  type StripeConnectionTestResult,
  testStripeConnection,
} from "#shared/stripe/endpoints.ts";
import {
  StripeApiError,
  StripeConnectionError,
  StripeProtocolError,
} from "#shared/stripe/request.ts";
import {
  sanitizeStripeError,
  stripeClientRuntime,
} from "#shared/stripe/runtime.ts";
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
            description: line.quantity > 1
              ? `${line.quantity} Tickets`
              : "Ticket",
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
  const session = await stripeClientRuntime.runCheckout(
    (client) => client.checkout.sessions.create(params),
    ErrorCode.STRIPE_CHECKOUT,
  );
  return session;
};

export interface StripeApi {
  cleanupOldWebhookEndpoints: typeof cleanupOldWebhookEndpoints;
  createCheckoutSession: typeof createCheckoutSession;
  readPaymentIntent: (
    id: string,
  ) => Promise<ProviderRead<StripeExpandedPaymentIntent>>;
  refundCharge: (request: RefundRequest) => Promise<RefundAttemptResult>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
}

const stripeFailure = (error: unknown): ProviderFailure | undefined =>
  providerFailure({
    connectionReason: error instanceof StripeConnectionError
      ? error.reason
      : undefined,
    malformed: error instanceof StripeProtocolError &&
      error.statusCode === undefined,
    statusCode:
      error instanceof StripeApiError || error instanceof StripeProtocolError
        ? error.statusCode
        : undefined,
  });

const withStripeClient = async <Result>(
  notConfigured: Result,
  useClient: (client: StripeClient) => Promise<Result>,
  useFailure: (failure: ProviderFailure) => Result,
): Promise<Result> => {
  const client = await stripeClientRuntime.get();
  if (client === null) return notConfigured;
  try {
    return await useClient(client);
  } catch (error) {
    const failure = stripeFailure(error);
    if (failure !== undefined) return useFailure(failure);
    throw error;
  }
};

const readPaymentIntent = (
  id: string,
): Promise<ProviderRead<StripeExpandedPaymentIntent>> =>
  withStripeClient<ProviderRead<StripeExpandedPaymentIntent>>(
    { reason: "not_configured", status: "unavailable" },
    async (client) => {
      const resource = await client.paymentIntents.retrieveWithLatestCharge(
        id,
        { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
      );
      return resource.id === id
        ? { resource, status: "found" }
        : { reason: "mismatched_id", status: "invalid" };
    },
    (failure) => failure.read,
  );

type StripeRefundStatus = Exclude<StripeRefund["status"], null>;
type StripeRefundAnswer = (
  amount: Money,
  refund: StripeRefund,
) => RefundAttemptResult;

const movedStripeRefund =
  (kind: "accepted" | "completed"): StripeRefundAnswer => (amount, refund) => ({
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
  (reason: "canceled" | "failed"): StripeRefundAnswer => () => ({
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
  request: RefundRequest,
): Promise<RefundAttemptResult> =>
  withStripeClient<RefundAttemptResult>(
    { kind: "not_sent", reason: "not_configured" },
    async (client) => {
      const idempotencyKey = await refundIdempotencyKey(
        "stripe",
        request.paymentReference,
      );
      const refund = await client.refunds.create(
        {
          amount: request.charge.captured.amount,
          payment_intent: request.paymentReference,
        },
        idempotencyKey,
        { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
      );
      return stripeRefundResult(request, refund);
    },
    (failure) => failure.refund,
  );

class StripeCheckoutReadError extends Error {
  constructor(reason: string) {
    super(`Stripe checkout could not be read (${reason})`);
    this.name = "StripeCheckoutReadError";
  }
}

/** A documented 404 is the only configured-provider failure that means the
 * checkout is absent. Every other known read failure remains loud and carries
 * only the closed provider outcome, never Stripe's response text. */
const checkoutReadFailure = (
  failure: ProviderFailure,
): StripeCheckoutSession | null => {
  const read = failure.read;
  if (read.status === "missing") return null;
  if (read.status === "unavailable" || read.status === "invalid") {
    throw new StripeCheckoutReadError(`${read.status}:${read.reason}`);
  }
  throw new StripeCheckoutReadError("invalid_failure_state");
};

const retrieveCheckoutSession = async (
  id: string,
): Promise<StripeCheckoutSession | null> => {
  const client = await stripeClientRuntime.get();
  if (client === null) return null;
  try {
    return await client.checkout.sessions.retrieve(id);
  } catch (error) {
    const failure = stripeFailure(error);
    if (failure?.read.status === "missing") return null;
    logError({
      code: ErrorCode.STRIPE_SESSION,
      detail: sanitizeStripeError(error),
    });
    if (failure === undefined) {
      throw new StripeCheckoutReadError("unexpected_failure");
    }
    return checkoutReadFailure(failure);
  }
};

export const stripeApi: StripeApi = {
  cleanupOldWebhookEndpoints,
  createCheckoutSession,
  readPaymentIntent,
  refundCharge,
  retrieveCheckoutSession,
  setupWebhookEndpoint,
  testStripeConnection,
};
