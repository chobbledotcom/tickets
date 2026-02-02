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
import type {
  MultiRegistrationIntent,
  PaymentProvider,
  PaymentProviderType,
  RegistrationIntent,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#lib/payments.ts";
import {
  createCheckoutSessionWithIntent,
  createMultiCheckoutSession,
  refundPayment as stripeRefund,
  retrieveCheckoutSession,
  setupWebhookEndpoint,
  verifyWebhookSignature,
} from "#lib/stripe.ts";

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  type: "stripe" as PaymentProviderType,

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

    const { id, payment_status, payment_intent, metadata } = session;

    if (!hasRequiredSessionMetadata(metadata)) {
      return null;
    }

    return {
      id,
      paymentStatus: payment_status as ValidatedPaymentSession["paymentStatus"],
      paymentReference:
        typeof payment_intent === "string" ? payment_intent : null,
      metadata: extractSessionMetadata(metadata),
    };
  },

  async verifyWebhookSignature(
    payload: string,
    signature: string,
  ): Promise<WebhookVerifyResult> {
    const result = await verifyWebhookSignature(payload, signature);
    if (!result.valid) {
      return { valid: false, error: result.error };
    }
    return {
      valid: true,
      event: result.event as WebhookEvent,
    };
  },

  async refundPayment(paymentReference: string): Promise<boolean> {
    const result = await stripeRefund(paymentReference);
    return result !== null;
  },

  setupWebhookEndpoint(
    secretKey: string,
    webhookUrl: string,
    existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    return setupWebhookEndpoint(secretKey, webhookUrl, existingEndpointId);
  },
};
