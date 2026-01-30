/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import type { Event } from "#lib/types.ts";
import type {
  CheckoutSessionResult,
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
import type {
  RegistrationIntent as StripeRegistrationIntent,
  MultiRegistrationIntent as StripeMultiRegistrationIntent,
} from "#lib/stripe.ts";

/** Convert provider RegistrationIntent to Stripe's format */
const toStripeIntent = (intent: RegistrationIntent): StripeRegistrationIntent => ({
  eventId: intent.eventId,
  name: intent.name,
  email: intent.email,
  quantity: intent.quantity,
});

/** Convert provider MultiRegistrationIntent to Stripe's format */
const toStripeMultiIntent = (
  intent: MultiRegistrationIntent,
): StripeMultiRegistrationIntent => ({
  name: intent.name,
  email: intent.email,
  items: intent.items.map((item) => ({
    eventId: item.eventId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    slug: item.slug,
  })),
});

/** Convert a Stripe session response to a provider-agnostic CheckoutSessionResult */
const toCheckoutResult = (
  session: { id: string; url?: string | null } | null,
): CheckoutSessionResult =>
  session?.url ? { sessionId: session.id, checkoutUrl: session.url } : null;

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  type: "stripe" as PaymentProviderType,

  checkoutCompletedEventType: "checkout.session.completed",

  async createCheckoutSession(
    event: Event,
    intent: RegistrationIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult> {
    return toCheckoutResult(
      await createCheckoutSessionWithIntent(event, toStripeIntent(intent), baseUrl),
    );
  },

  async createMultiCheckoutSession(
    intent: MultiRegistrationIntent,
    baseUrl: string,
  ): Promise<CheckoutSessionResult> {
    return toCheckoutResult(
      await createMultiCheckoutSession(toStripeMultiIntent(intent), baseUrl),
    );
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    const session = await retrieveCheckoutSession(sessionId);
    if (!session) return null;

    const { id, payment_status, payment_intent, metadata } = session;
    if (typeof id !== "string" || typeof payment_status !== "string") {
      return null;
    }

    if (!metadata?.name || !metadata?.email) {
      return null;
    }

    // Multi-ticket sessions have items instead of event_id
    const isMulti =
      metadata.multi === "1" && typeof metadata.items === "string";
    if (!isMulti && !metadata?.event_id) {
      return null;
    }

    return {
      id,
      paymentStatus: payment_status as ValidatedPaymentSession["paymentStatus"],
      paymentReference:
        typeof payment_intent === "string" ? payment_intent : null,
      metadata: {
        event_id: metadata.event_id,
        name: metadata.name,
        email: metadata.email,
        quantity: metadata.quantity,
        multi: metadata.multi,
        items: metadata.items,
      },
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
