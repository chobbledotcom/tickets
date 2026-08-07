/**
 * Square implementation of the PaymentProvider interface
 *
 * Wraps the square.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 *
 * Key differences from Stripe:
 * - Uses Payment Links instead of checkout sessions
 * - Order ID is the session equivalent
 * - Webhook event is payment.updated (not checkout.session.completed)
 * - Retrieving session requires fetching Order + checking payment status
 * - Webhook setup is manual (user provides signature key from dashboard)
 */

/* jscpd:ignore-start */
import { settings } from "#shared/db/settings.ts";
import { logDebug } from "#shared/logger.ts";
import { validatedPaymentSession } from "#shared/payment/validated-session.ts";
import type {
  PaymentAttempt,
  PaymentAttemptConfig,
} from "#shared/payment-attempt.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  WebhookEvent,
  WebhookSetupResult,
} from "#shared/payments.ts";
import { createSquareClient } from "#shared/square/client.ts";
import {
  createSquareOperations,
  type SquareOperations,
} from "#shared/square/operations.ts";
import { verifySquareWebhookSignature } from "#shared/square/webhook.ts";
import { squareApi } from "#shared/square.ts";

/* jscpd:ignore-end */

type SquareAttemptConfig = Extract<PaymentAttemptConfig, { type: "square" }>;

type SquareProviderOperations = Omit<PaymentAttempt, "currency">;

interface SquareBinding extends SquareOperations {
  verifyWebhookSignature: PaymentProvider["verifyWebhookSignature"];
}

const readSquarePayment = async (
  binding: SquareBinding,
  orderId: string,
  tenderPaymentId: string | undefined,
  paidPaymentId: string | undefined,
) => {
  const paymentReference = paidPaymentId ?? tenderPaymentId ?? "";
  const payment = paymentReference
    ? await binding.retrievePayment(paymentReference)
    : null;
  if (paidPaymentId && payment?.status !== "COMPLETED") {
    throw new Error(
      `Square payment ${paidPaymentId} did not read back as completed (status=${payment?.status ?? "unreadable"})`,
    );
  }
  if (payment?.orderId !== undefined && payment.orderId !== orderId) {
    throw new Error(
      `Square payment ${paymentReference} reports order ${payment.orderId}, not ${orderId}`,
    );
  }
  return { payment, paymentReference };
};

const squareWebhookPayment = (listing: WebhookEvent) => {
  const object = listing.data.object;
  const payment =
    typeof object.payment === "object" && object.payment !== null
      ? (object.payment as Record<string, unknown>)
      : object;
  const paymentId = typeof payment.id === "string" ? payment.id : null;
  if (!paymentId && listing.type.startsWith("payment.")) {
    throw new Error("Square payment webhook is missing id");
  }
  return {
    orderId: typeof payment.order_id === "string" ? payment.order_id : null,
    paymentId,
    status: typeof payment.status === "string" ? payment.status : null,
  };
};

const createSquareProviderOperations = (
  binding: SquareBinding,
): SquareProviderOperations => {
  const retrieveSession: SquareProviderOperations["retrieveSession"] = async (
    sessionId,
    paidPaymentId,
  ) => {
    const order = await binding.retrieveOrder(sessionId);
    if (!order?.id) {
      logDebug("Square", `Order ${sessionId} not found`);
      return null;
    }

    const { metadata } = order;
    if (!hasRequiredSessionMetadata(metadata)) {
      logDebug("Square", `Order ${sessionId} missing required metadata fields`);
      return null;
    }

    const { payment, paymentReference } = await readSquarePayment(
      binding,
      order.id,
      order.tenders?.[0]?.paymentId,
      paidPaymentId,
    );

    const paid = payment?.status === "COMPLETED";
    const charged = paid ? payment.amountMoney : order.totalMoney;
    return validatedPaymentSession({
      amountTotal:
        typeof charged?.amount === "bigint" ? Number(charged.amount) : null,
      createdAt: toCanonicalIso(order.createdAt),
      currency: charged?.currency,
      id: order.id,
      metadata,
      paymentReference,
      paymentStatus: paid ? "paid" : "unpaid",
    });
  };

  return {
    checkoutCompletedEventType: "payment.updated",
    async isPaymentRefunded(paymentReference): Promise<boolean> {
      const payment = await binding.retrievePayment(paymentReference);
      if (!payment) return false;
      const charged = payment.amountMoney?.amount ?? BigInt(0);
      const refunded = payment.refundedMoney?.amount ?? BigInt(0);
      return charged > BigInt(0) && refunded >= charged;
    },
    refundPayment: (paymentReference) =>
      binding.refundPayment(paymentReference),
    requiresWebhookSignature: true,
    async resolveWebhookSession(listing) {
      const { orderId, paymentId, status } = squareWebhookPayment(listing);
      if (!orderId || !paymentId) return null;
      if (status && status !== "COMPLETED") {
        logDebug(
          "Square",
          `Skipping webhook for non-completed payment (status=${status})`,
        );
        return "skip";
      }
      return (await retrieveSession(orderId, paymentId)) ?? "skip";
    },
    retrieveSession,
    type: "square",
    verifyWebhookSignature: (...args) =>
      binding.verifyWebhookSignature(...args),
  };
};

const globalSquareOperations = createSquareProviderOperations({
  refundPayment: (paymentId) => squareApi.refundPayment(paymentId),
  retrieveOrder: (orderId) => squareApi.retrieveOrder(orderId),
  retrievePayment: (paymentId) => squareApi.retrievePayment(paymentId),
  verifyWebhookSignature: (...args) =>
    verifySquareWebhookSignature(settings.square.webhookSignatureKey, ...args),
});

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  ...globalSquareOperations,

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withCheckoutError(async () => {
      const link = await squareApi.createPaymentLink(intent, baseUrl);
      return toCheckoutResult(link?.orderId, link?.url, "Square");
    });
  },

  setupWebhookEndpoint(
    _secretKey: string,
    _webhookUrl: string,
    _existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    // Square webhook setup is manual - user creates subscription in dashboard
    // and provides the signature key. This method is a no-op for Square.
    return Promise.resolve({
      error:
        "Square webhooks must be configured manually in the Square Developer Dashboard",
      success: false,
    });
  },
};

export const createSquarePaymentAttempt = (
  config: SquareAttemptConfig,
): PaymentAttempt => {
  const binding = {
    client: createSquareClient(config.accessToken, config.sandbox),
    locationId: config.locationId,
    webhookSignatureKey: config.webhookSignatureKey,
  };
  const operations = createSquareOperations(() =>
    Promise.resolve(binding.client),
  );
  return {
    ...createSquareProviderOperations({
      ...operations,
      verifyWebhookSignature: (...args) =>
        verifySquareWebhookSignature(binding.webhookSignatureKey, ...args),
    }),
    currency: config.currency,
  };
};
