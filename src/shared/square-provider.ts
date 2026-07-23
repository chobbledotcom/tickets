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

import { identity } from "#fp";
import { logDebug } from "#shared/logger.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  validatedPaymentSession,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  PaymentRefundResult,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSessionResolution,
  WebhookSetupResult,
} from "#shared/payments.ts";
import {
  closePaymentLink,
  createPaymentLink,
  refundPayment,
  retrieveCompletedPaymentForOrder,
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#shared/square.ts";
import {
  type CompletedSquarePayment,
  squareCloseTenderPaymentId,
  squareTenderPaymentIds,
} from "#shared/square-payments.ts";

type SquareOrder = NonNullable<Awaited<ReturnType<typeof retrieveOrder>>>;
type CompleteSquareOrder = SquareOrder & {
  id: string;
  metadata: SessionMetadata;
};

const squareSession = (
  order: CompleteSquareOrder,
  payment: {
    amountTotal: number;
    paymentReference: string;
    paymentStatus: ValidatedPaymentSession["paymentStatus"];
  },
): ValidatedPaymentSession =>
  validatedPaymentSession({
    ...payment,
    createdAt: toCanonicalIso(order.createdAt),
    id: order.id,
    metadata: order.metadata,
  });

const paidSquareSession = (
  order: CompleteSquareOrder,
  payment: CompletedSquarePayment,
): ValidatedPaymentSession =>
  squareSession(order, { ...payment, paymentStatus: "paid" });

type PaymentOrderFor = (order: SquareOrder) => SquareOrder;

const closePaymentOrder = (order: SquareOrder): SquareOrder => {
  const paymentId = squareCloseTenderPaymentId(order);
  return {
    ...order,
    tenders: paymentId === null ? [] : [{ paymentId }],
  };
};

const retrieveSquareSession = async (
  sessionId: string,
  paymentOrderFor: PaymentOrderFor,
): Promise<ValidatedPaymentSession | null> => {
  const order = await retrieveOrder(sessionId);
  if (!order?.id) {
    logDebug("Square", `Order ${sessionId} not found`);
    return null;
  }

  const { metadata } = order;
  if (!hasRequiredSessionMetadata(metadata)) {
    logDebug("Square", `Order ${sessionId} missing required metadata fields`);
    return null;
  }
  const completeOrder: CompleteSquareOrder = {
    ...order,
    id: order.id,
    metadata,
  };
  const paymentOrder = paymentOrderFor(order);
  const paymentIds = squareTenderPaymentIds(paymentOrder);
  const completed = await retrieveCompletedPaymentForOrder(paymentOrder);
  return completed
    ? paidSquareSession(completeOrder, completed)
    : squareSession(completeOrder, {
        amountTotal: Number(order.totalMoney.amount),
        paymentReference: paymentIds[0] ?? "",
        paymentStatus: "unpaid",
      });
};

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  checkoutWebhookEvents: { completed: "payment.updated", expired: null },

  closeCheckout: ({ providerCheckoutId, sessionId }) =>
    closePaymentLink(providerCheckoutId, sessionId),

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withCheckoutError(async () => {
      const link = await createPaymentLink(intent, baseUrl);
      return toCheckoutResult(link?.orderId, link?.url, "Square", link?.id);
    });
  },

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const payment = await retrievePayment(paymentReference);
    if (!payment) return false;
    // Fully refunded only: a partial refund leaves the customer still charged,
    // so it must not count as refunded (matches Stripe's charge.refunded and
    // SumUp's REFUNDED status, and keeps the refund-idempotency fallback honest).
    const charged = payment.amountMoney?.amount;
    const refunded = payment.refundedMoney?.amount;
    if (charged === undefined || refunded === undefined) return false;
    return charged > BigInt(0) && refunded >= charged;
  },

  refundPayment(paymentReference: string): Promise<PaymentRefundResult> {
    return refundPayment(paymentReference);
  },
  requiresWebhookSignature: true,

  async resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<WebhookSessionResolution> {
    const obj = listing.data.object;

    // Square nests payment fields under data.object.payment
    const payment =
      typeof obj.payment === "object" && obj.payment !== null
        ? (obj.payment as Record<string, unknown>)
        : obj;

    const orderId =
      typeof payment.order_id === "string" ? payment.order_id : null;
    const paymentId = typeof payment.id === "string" ? payment.id : null;

    if (!orderId || !paymentId) {
      if (listing.type.startsWith("payment.")) {
        throw new Error("Square payment webhook is missing order_id or id");
      }
      return null;
    }

    // Skip non-completed payments to avoid unnecessary API calls
    if (typeof payment.status === "string" && payment.status !== "COMPLETED") {
      logDebug(
        "Square",
        `Skipping webhook for non-completed payment (status=${payment.status})`,
      );
      return Promise.resolve("skip");
    }

    const order = await retrieveOrder(orderId);
    if (!order?.id) return "retry";
    if (!hasRequiredSessionMetadata(order.metadata)) return "skip";
    const completeOrder: CompleteSquareOrder = {
      ...order,
      id: order.id,
      metadata: order.metadata,
    };

    const completed = await retrieveCompletedPaymentForOrder({
      ...completeOrder,
      tenders: [{ paymentId }],
    });
    return completed ? paidSquareSession(completeOrder, completed) : "retry";
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(
    sessionId: string,
    mode = "callback",
  ): Promise<ValidatedPaymentSession | null> {
    /* jscpd:ignore-end */
    return retrieveSquareSession(
      sessionId,
      mode === "recovery" ? closePaymentOrder : identity,
    );
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
  type: "square",

  verifyWebhookSignature(
    ...args: Parameters<PaymentProvider["verifyWebhookSignature"]>
  ) {
    return verifyWebhookSignature(...args);
  },
};
