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
  type SessionRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSetupResult,
} from "#shared/payments.ts";
import {
  createPaymentLink,
  refundPayment,
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#shared/square.ts";

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
  ): Promise<ValidatedPaymentSession | "skip" | SessionRejection | null> {
    const obj = listing.data.object;

    // Square nests payment fields under data.object.payment
    const payment =
      typeof obj.payment === "object" && obj.payment !== null
        ? (obj.payment as Record<string, unknown>)
        : obj;

    const paymentId = typeof payment.id === "string" ? payment.id : null;
    if (!paymentId && listing.type.startsWith("payment.")) {
      throw new Error("Square payment webhook is missing id");
    }

    // Extract the order ID (Square's session equivalent)
    const orderId =
      typeof payment.order_id === "string" ? payment.order_id : null;

    if (!orderId || !paymentId) return Promise.resolve(null);

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
    const session = await this.retrieveSession(orderId, paymentId);
    return session ?? "skip";
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(
    sessionId: string,
    paidPaymentId?: string,
  ): Promise<ValidatedPaymentSession | SessionRejection | null> {
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

    // A webhook names the payment Square just reported COMPLETED, so it wins:
    // the order's tenders can lag behind it entirely, or still lead with an
    // earlier payment, and either would call this captured charge unpaid.
    const paymentReference =
      paidPaymentId ?? order.tenders?.[0]?.paymentId ?? "";
    const payment = paymentReference
      ? await retrievePayment(paymentReference)
      : null;
    // The webhook already saw this payment complete, so failing to read it
    // back is a provider blip, not an unpaid order. Throwing answers the
    // caller retryably; going quiet would acknowledge a captured charge.
    if (paidPaymentId && !payment) {
      throw new Error(`Square payment ${paidPaymentId} could not be read back`);
    }

    // The payment must be for the order whose signed metadata we are about to
    // book. When Square's two records disagree, one of them is wrong, and
    // guessing spends a stranger's money against our proof.
    if (
      payment &&
      payment.orderId !== undefined &&
      payment.orderId !== order.id
    ) {
      logDebug(
        "Square",
        `Payment ${paymentReference} belongs to order ${payment.orderId}, not ${order.id}`,
      );
      return null;
    }

    // Money we can see was taken. A completed payment names its own amount, and
    // standing the order total in for it would let a short or unreadable charge
    // match the signed price and book as paid in full. Until then the order
    // total is all there is, and nothing has been captured against it.
    const paid = payment?.status === "COMPLETED";
    const charged = paid ? payment.amountMoney : order.totalMoney;
    return validatedPaymentSession({
      // A missing amount stays missing: Number(null) is 0, which the
      // boundary would accept as a real free order.
      amountTotal:
        typeof charged?.amount === "bigint" ? Number(charged.amount) : null,
      createdAt: toCanonicalIso(order.createdAt),
      currency: charged?.currency,
      id: order.id,
      metadata,
      paymentReference,
      paymentStatus: paid ? "paid" : "unpaid",
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
