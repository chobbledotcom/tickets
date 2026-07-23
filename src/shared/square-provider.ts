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

import { logDebug } from "#shared/logger.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  validatedPaymentSession,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import { hasTerminalPaymentOutcome } from "#shared/payment-outcome.ts";
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
  createPaymentLink,
  refundPayment,
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#shared/square.ts";
import {
  type CompletedSquarePayment,
  findCompletedSquarePayment,
  type SquareOrder,
  squareTenderPaymentIds,
} from "#shared/square-payments.ts";

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
  { amountTotal, paymentReference }: CompletedSquarePayment,
): ValidatedPaymentSession =>
  squareSession(order, {
    amountTotal,
    paymentReference,
    paymentStatus: "paid",
  });

type SquareSessionPayment =
  | { status: "missing" }
  | { status: "paid"; payment: CompletedSquarePayment }
  | { status: "refunded" };

/** A refund changes provider state only until local state records the outcome. */
const squareSessionPayment = async (
  order: SquareOrder & { id: string },
): Promise<SquareSessionPayment> => {
  const payment = await findCompletedSquarePayment(retrievePayment)(order);
  if (payment === null) return { status: "missing" };
  if (
    payment.refundedAmount > 0 &&
    !(await hasTerminalPaymentOutcome(order.id))
  ) {
    return { status: "refunded" };
  }
  return { payment, status: "paid" };
};

const completeSquareOrder = (
  order: SquareOrder & { id: string },
): CompleteSquareOrder | null => {
  if (!hasRequiredSessionMetadata(order.metadata)) return null;
  return { ...order, id: order.id, metadata: order.metadata };
};

type SquareWebhookPayment = {
  orderId: string;
  paymentId: string;
  status: unknown;
};

/** Read identifiers without mistaking another Square product for our order. */
const squareWebhookPayment = (
  listing: WebhookEvent,
): SquareWebhookPayment | null => {
  const object = listing.data.object;
  const payment =
    typeof object.payment === "object" && object.payment !== null
      ? (object.payment as Record<string, unknown>)
      : object;
  const orderId =
    typeof payment.order_id === "string" ? payment.order_id : null;
  const paymentId = typeof payment.id === "string" ? payment.id : null;
  if (!paymentId && listing.type.startsWith("payment.")) {
    throw new Error("Square payment webhook is missing id");
  }
  return orderId && paymentId
    ? { orderId, paymentId, status: payment.status }
    : null;
};

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "payment.updated",

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withCheckoutError(async () => {
      const link = await createPaymentLink(intent, baseUrl);
      return toCheckoutResult(link?.orderId, link?.url, "Square");
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
    return (
      charged !== undefined &&
      refunded !== undefined &&
      charged > BigInt(0) &&
      refunded >= charged
    );
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return refundPayment(paymentReference);
  },
  requiresWebhookSignature: true,

  async resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<WebhookSessionResolution> {
    const payment = squareWebhookPayment(listing);
    if (payment === null) return null;
    const { orderId, paymentId } = payment;

    // Skip non-completed payments to avoid unnecessary API calls
    if (typeof payment.status === "string" && payment.status !== "COMPLETED") {
      logDebug(
        "Square",
        `Skipping webhook for non-completed payment (status=${payment.status})`,
      );
      return Promise.resolve("skip");
    }

    // If the order has no metadata (e.g. created directly in Square
    // dashboard/POS, not by our system), skip silently instead of treating
    // it as an error — avoids noisy logs and 400 responses that trigger
    // Square webhook retries.
    const order = await retrieveOrder(orderId);
    const providerOrderId = order?.id;
    if (!providerOrderId) return "retry";
    const completeOrder = completeSquareOrder({
      ...order,
      id: providerOrderId,
    });
    if (completeOrder === null) return "skip";
    const resolved = await squareSessionPayment({
      ...completeOrder,
      tenders: [{ paymentId }],
    });
    if (resolved.status === "missing") return "retry";
    if (resolved.status === "refunded") return "skip";
    return paidSquareSession(completeOrder, resolved.payment);
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
    const orderId = order?.id;
    if (!orderId) {
      logDebug("Square", `Order ${sessionId} not found`);
      return null;
    }

    const completeOrder = completeSquareOrder({ ...order, id: orderId });
    if (completeOrder === null) {
      logDebug("Square", `Order ${sessionId} missing required metadata fields`);
      return null;
    }
    const paymentIds = squareTenderPaymentIds(order);
    const paymentReference = paymentIds[0];
    const payment = await squareSessionPayment(completeOrder);
    return payment.status === "paid"
      ? paidSquareSession(completeOrder, payment.payment)
      : squareSession(completeOrder, {
          amountTotal: Number(order.totalMoney.amount),
          paymentReference:
            paymentReference === undefined ? "" : paymentReference,
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
