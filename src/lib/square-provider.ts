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

import { logDebug } from "#lib/logger.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import {
  createMultiPaymentLink,
  createPaymentLink,
  refundPayment,
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#lib/square.ts";
import type { Event } from "#lib/types.ts";
import type {
  CheckoutSessionResult,
  MultiRegistrationIntent,
  PaymentProvider,
  RegistrationIntent,
  ValidatedPaymentSession,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#lib/payments.ts";

/** Wrap a checkout operation, converting PaymentUserError to { error } result */
const withUserError = async <T extends { orderId: string; url: string }>(
  op: () => Promise<T | null>,
): Promise<CheckoutSessionResult> => {
  try {
    const result = await op();
    return toCheckoutResult(result?.orderId, result?.url, "Square");
  } catch (err) {
    if (err instanceof PaymentUserError) return { error: err.message };
    return null;
  }
};

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  type: "square",

  checkoutCompletedEventType: "payment.updated",

  createCheckoutSession(event: Event, intent: RegistrationIntent, baseUrl: string) {
    return withUserError(() => createPaymentLink(event, intent, baseUrl));
  },

  createMultiCheckoutSession(intent: MultiRegistrationIntent, baseUrl: string) {
    return withUserError(() => createMultiPaymentLink(intent, baseUrl));
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

    // Determine payment status from order state and tenders
    const paymentReference = order.tenders?.[0]?.paymentId ?? "";

    // Square order state "COMPLETED" means payment is done
    const paymentStatus: ValidatedPaymentSession["paymentStatus"] =
      order.state === "COMPLETED" ? "paid" : "unpaid";

    return {
      id: order.id,
      paymentStatus,
      paymentReference,
      amountTotal: Number(order.totalMoney.amount),
      metadata: extractSessionMetadata(metadata),
    };
  },

  verifyWebhookSignature(
    payload: string,
    signature: string,
    webhookUrl: string,
  ): Promise<WebhookVerifyResult> {
    return verifyWebhookSignature(payload, signature, webhookUrl);
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return refundPayment(paymentReference);
  },

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const payment = await retrievePayment(paymentReference);
    if (!payment) return false;
    return (payment.refundedMoney?.amount ?? BigInt(0)) > BigInt(0);
  },

  setupWebhookEndpoint(
    _secretKey: string,
    _webhookUrl: string,
    _existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    // Square webhook setup is manual - user creates subscription in dashboard
    // and provides the signature key. This method is a no-op for Square.
    return Promise.resolve({
      success: false,
      error: "Square webhooks must be configured manually in the Square Developer Dashboard",
    });
  },
};
