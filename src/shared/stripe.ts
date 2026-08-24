/* jscpd:ignore-start */

import { settings } from "#db/settings.ts";
import type { Money } from "#payment/money.ts";
import {
  type ProviderFailure,
  providerFailureOf,
  requireProviderFailure,
  withExactRefundMoney,
} from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  judgedBy,
  readProviderResource,
  refuseUnless,
} from "#payment/provider-resource-read.ts";
import {
  type RefundAttemptResult,
  type RefundRequest,
  uncertainRefund,
} from "#payment/refund-attempt.ts";
import { REFUND_NETWORK_RETRIES } from "#payment/refund-network.ts";
import type { AuthorizedRefundRequest } from "#payment/refund-provider-authorization.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  buildProviderLineItems,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent, SetupWebhookEndpoint } from "#shared/payments.ts";
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
  refundCharge: (
    request: AuthorizedRefundRequest<"stripe">,
  ) => Promise<RefundAttemptResult>;
  retrieveCheckoutSession: (
    id: string,
  ) => Promise<StripeCheckoutSession | null>;
  setupWebhookEndpoint: SetupWebhookEndpoint;
  testStripeConnection: () => Promise<StripeConnectionTestResult>;
}

const withStripeClient = async <Result>(
  notConfigured: Result,
  useClient: (client: StripeClient) => Promise<Result>,
  useError: (error: unknown, failure: ProviderFailure | undefined) => Result,
): Promise<Result> => {
  const client = await stripeClientRuntime.get();
  if (client === null) return notConfigured;
  try {
    return await useClient(client);
  } catch (error) {
    return useError(error, providerFailureOf(error));
  }
};

const readPaymentIntent = async (
  id: string,
): Promise<ProviderRead<StripeExpandedPaymentIntent>> =>
  readProviderResource({
    account: await stripeClientRuntime.get(),
    ask: (client) =>
      client.paymentIntents.retrieveWithLatestCharge(id, {
        maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe,
      }),
    failure: (error) => providerFailureOf(error)?.read,
    judge: judgedBy([
      refuseUnless(
        "mismatched_id",
        (intent: StripeExpandedPaymentIntent) => intent.id === id,
      ),
    ]),
  });

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
  withStripeClient<RefundAttemptResult>(
    { kind: "not_sent", reason: "not_configured" },
    async (client) => {
      const refund = await client.refunds.create(
        {
          amount: request.charge.captured.amount,
          payment_intent: request.paymentReference,
        },
        request.authorization.idempotencyKey,
        { maxNetworkRetries: REFUND_NETWORK_RETRIES.stripe },
      );
      return stripeRefundResult(request, refund);
    },
    (error) => requireProviderFailure(error).refund,
  );

class StripeCheckoutReadError extends Error {
  constructor(reason: string) {
    super(`Stripe checkout could not be read (${reason})`);
    this.name = "StripeCheckoutReadError";
  }
}

const retrieveCheckoutSession = async (
  id: string,
): Promise<StripeCheckoutSession | null> =>
  withStripeClient<StripeCheckoutSession | null>(
    null,
    (client) => client.checkout.sessions.retrieve(id),
    (error, failure) => {
      if (failure?.read.status === "missing") return null;
      logError({
        code: ErrorCode.STRIPE_SESSION,
        detail: sanitizeStripeError(error),
      });
      if (failure === undefined) {
        throw new StripeCheckoutReadError("unexpected_failure");
      }
      throw new StripeCheckoutReadError(
        `${failure.read.status}:${failure.read.reason}`,
      );
    },
  );

export const stripeApi: StripeApi = {
  cleanupOldWebhookEndpoints,
  createCheckoutSession,
  readPaymentIntent,
  refundCharge,
  retrieveCheckoutSession,
  setupWebhookEndpoint,
  testStripeConnection,
};
