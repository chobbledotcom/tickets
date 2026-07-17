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

import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
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
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#shared/square.ts";

type SquareOrder = NonNullable<Awaited<ReturnType<typeof retrieveOrder>>>;
type SquarePayment = NonNullable<Awaited<ReturnType<typeof retrievePayment>>>;
type CompleteSquareOrder = SquareOrder & {
  id: string;
  metadata: SessionMetadata;
};

const MAX_TENDERS_TO_CHECK = 10;

/** Validate the completed payment fields that authorize booking and refunds. */
const completedPaymentForOrder = (
  payment: SquarePayment,
  paymentId: string,
  order: SquareOrder,
): { amountTotal: number; paymentReference: string } | null => {
  const amount = payment.amountMoney?.amount;
  const currency = payment.amountMoney?.currency;
  if (
    payment.id !== paymentId ||
    payment.status !== "COMPLETED" ||
    payment.orderId !== order.id ||
    typeof amount !== "bigint" ||
    !currency ||
    currency !== order.totalMoney.currency ||
    amount < BigInt(0) ||
    amount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Square payment ${paymentId} is not a valid completed payment for order ${order.id}`,
    });
    return null;
  }
  return { amountTotal: Number(amount), paymentReference: paymentId };
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
  payment: SquarePayment,
  paymentId: string,
): ValidatedPaymentSession | null => {
  const completed = completedPaymentForOrder(payment, paymentId, order);
  return completed
    ? squareSession(order, { ...completed, paymentStatus: "paid" })
    : null;
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
    const charged = payment.amountMoney?.amount ?? BigInt(0);
    const refunded = payment.refundedMoney?.amount ?? BigInt(0);
    return charged > BigInt(0) && refunded >= charged;
  },

  refundPayment(paymentReference: string): Promise<boolean> {
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

    if (!orderId || !paymentId) return Promise.resolve(null);

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

    const authoritativePayment = await retrievePayment(paymentId);
    if (!authoritativePayment) return "retry";
    return (
      paidSquareSession(completeOrder, authoritativePayment, paymentId) ??
      "retry"
    );
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    /* jscpd:ignore-end */
    // sessionId is the Square order ID
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

    const paymentIds = (order.tenders ?? [])
      .slice(-MAX_TENDERS_TO_CHECK)
      .reverse()
      .flatMap((tender) => (tender.paymentId ? [tender.paymentId] : []));
    for (const paymentId of paymentIds) {
      const payment = await retrievePayment(paymentId);
      if (payment?.status !== "COMPLETED") continue;
      return paidSquareSession(completeOrder, payment, paymentId);
    }

    return squareSession(completeOrder, {
      amountTotal: Number(order.totalMoney.amount),
      paymentReference: paymentIds[0] ?? "",
      paymentStatus: "unpaid",
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
  type: "square",

  verifyWebhookSignature(
    ...args: Parameters<PaymentProvider["verifyWebhookSignature"]>
  ) {
    return verifyWebhookSignature(...args);
  },
};
