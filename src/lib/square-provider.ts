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

import { getAllowedDomain } from "#lib/config.ts";
import { logDebug } from "#lib/logger.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import {
  createMultiPaymentLink,
  createPaymentLink,
  refundPayment,
  retrieveOrder,
  verifyWebhookSignature,
} from "#lib/square.ts";
import type { Event } from "#lib/types.ts";
import type {
  MultiRegistrationIntent,
  PaymentProvider,
  PaymentProviderType,
  RegistrationIntent,
  ValidatedPaymentSession,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#lib/payments.ts";

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  type: "square" as PaymentProviderType,

  checkoutCompletedEventType: "payment.updated",

  async createCheckoutSession(
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ) {
    const result = await createPaymentLink(event, intent, baseUrl);
    return toCheckoutResult(result?.orderId, result?.url, "Square");
  },

  async createMultiCheckoutSession(
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ) {
    const result = await createMultiPaymentLink(intent, baseUrl);
    return toCheckoutResult(result?.orderId, result?.url, "Square");
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
    const paymentReference = order.tenders?.[0]?.paymentId ?? null;

    // Square order state "COMPLETED" means payment is done
    const paymentStatus: ValidatedPaymentSession["paymentStatus"] =
      order.state === "COMPLETED" ? "paid" : "unpaid";

    return {
      id: order.id,
      paymentStatus,
      paymentReference,
      metadata: extractSessionMetadata(metadata),
    };
  },

  verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<WebhookVerifyResult> {
    const domain = getAllowedDomain();
    const notificationUrl = `https://${domain}/payment/webhook`;
    return verifyWebhookSignature(payload, signature, notificationUrl);
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return refundPayment(paymentReference);
  },

  setupWebhookEndpoint(
    _secretKey: string,
    _webhookUrl: string,
    _existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    // Square webhook setup is manual - user creates subscription in dashboard
    // and provides the signature key. This method is a no-op for Square.
    return Promise.resolve({
      success: false as const,
      error: "Square webhooks must be configured manually in the Square Developer Dashboard",
    });
  },
};
