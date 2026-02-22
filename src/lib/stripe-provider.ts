/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import type { Event } from "#lib/types.ts";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import {
  isPaymentStatus,
  type MultiRegistrationIntent,
  type PaymentProvider,
  type RegistrationIntent,
  type ValidatedPaymentSession,
  type WebhookSetupResult,
  type WebhookVerifyResult,
} from "#lib/payments.ts";
import {
  createCheckoutSessionWithIntent,
  createMultiCheckoutSession,
  refundPayment as stripeRefund,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  setupWebhookEndpoint,
  verifyWebhookSignature,
} from "#lib/stripe.ts";

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  type: "stripe",

  checkoutCompletedEventType: "checkout.session.completed",

  async createCheckoutSession(
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ) {
    const session = await createCheckoutSessionWithIntent(event, intent, baseUrl);
    return toCheckoutResult(session?.id, session?.url, "Stripe");
  },

  async createMultiCheckoutSession(
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ) {
    const session = await createMultiCheckoutSession(intent, baseUrl);
    return toCheckoutResult(session?.id, session?.url, "Stripe");
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    const session = await retrieveCheckoutSession(sessionId);
    if (!session) return null;

    const { id, payment_status, payment_intent, metadata, amount_total } = session;

    if (!hasRequiredSessionMetadata(metadata)) {
      return null;
    }

    if (amount_total === null) return null;

    return {
      id,
      paymentStatus: isPaymentStatus(payment_status) ? payment_status : "unpaid",
      paymentReference:
        typeof payment_intent === "string" ? payment_intent : "",
      amountTotal: amount_total,
      metadata: extractSessionMetadata(metadata),
    };
  },

  async verifyWebhookSignature(
    payload: string,
    signature: string,
    _webhookUrl: string,
    _payloadBytes: Uint8Array,
  ): Promise<WebhookVerifyResult> {
    const result = await verifyWebhookSignature(payload, signature);
    if (!result.valid) {
      return { valid: false, error: result.error };
    }
    return {
      valid: true,
      event: result.event,
    };
  },

  async refundPayment(paymentReference: string): Promise<boolean> {
    const result = await stripeRefund(paymentReference);
    return result !== null;
  },

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await retrievePaymentIntent(paymentReference);
    if (!intent) return false;
    const charge = intent.latest_charge;
    if (typeof charge === "object" && charge !== null) {
      return (charge as { refunded: boolean }).refunded;
    }
    return false;
  },

  setupWebhookEndpoint(
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    return setupWebhookEndpoint(secretKey, webhookUrl, existingEndpointId);
  },

};
