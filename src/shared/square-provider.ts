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
  extractSessionMetadata,
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
  ): Promise<ValidatedPaymentSession | "skip" | null> {
    const obj = listing.data.object;

    // Square nests payment fields under data.object.payment
    const payment =
      typeof obj.payment === "object" && obj.payment !== null
        ? (obj.payment as Record<string, unknown>)
        : obj;

    // Extract the order ID (Square's session equivalent)
    const orderId =
      typeof payment.order_id === "string"
        ? payment.order_id
        : typeof payment.id === "string"
          ? payment.id
          : null;

    if (!orderId) return Promise.resolve(null);

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
    const session = await this.retrieveSession(orderId);
    return session ?? "skip";
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
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

    // Determine payment status from the payment itself (most reliable source)
    const paymentReference = order.tenders?.[0]?.paymentId ?? "";

    let paymentStatus: ValidatedPaymentSession["paymentStatus"] = "unpaid";
    if (paymentReference) {
      const payment = await retrievePayment(paymentReference);
      if (payment?.status === "COMPLETED") {
        paymentStatus = "paid";
      }
    }

    return {
      amountTotal: Number(order.totalMoney.amount),
      createdAt: toCanonicalIso(order.createdAt),
      id: order.id,
      metadata: extractSessionMetadata(metadata),
      paymentReference,
      paymentStatus,
    };
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
