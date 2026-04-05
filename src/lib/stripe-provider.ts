/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import { asString } from "#fp";
import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import {
  type CheckoutIntent,
  isPaymentStatus,
  type PaymentProvider,
  type ValidatedPaymentSession,
  type WebhookEvent,
  type WebhookVerifyResult,
} from "#lib/payments.ts";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  setupWebhookEndpoint,
  refundPayment as stripeRefund,
  verifyWebhookSignature,
} from "#lib/stripe.ts";

/** Convert a Stripe checkout session to a CheckoutResult */
const stripeCheckoutResult = (
  session: { id?: string; url?: string | null } | null,
) => toCheckoutResult(session?.id, session?.url, "Stripe");

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  type: "stripe",

  checkoutCompletedEventType: "checkout.session.completed",

  async createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    const session = await createCheckoutSession(intent, baseUrl);
    return stripeCheckoutResult(session);
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    const session = await retrieveCheckoutSession(sessionId);
    if (!session) return null;

    const { id, payment_status, payment_intent, metadata, amount_total } =
      session;

    if (!hasRequiredSessionMetadata(metadata)) {
      return null;
    }

    if (amount_total === null) return null;

    return {
      id,
      paymentStatus: isPaymentStatus(payment_status)
        ? payment_status
        : "unpaid",
      paymentReference: payment_intent ?? "",
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
    return intent?.latest_charge?.refunded ?? false;
  },

  setupWebhookEndpoint(...args: Parameters<typeof setupWebhookEndpoint>) {
    return setupWebhookEndpoint(...args);
  },

  resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<ValidatedPaymentSession | "skip" | null> {
    const metadata = obj.metadata as
      | Record<string, string | undefined>
      | undefined;

    const id = asString(obj.id);
    const paymentStatus = asString(obj.payment_status);
    const amountTotal = obj.amount_total;

    // Stripe includes the full session in the event — extract directly
    if (
      id &&
      paymentStatus &&
      typeof amountTotal === "number" &&
      hasRequiredSessionMetadata(metadata)
    ) {
      return Promise.resolve({
        id,
        paymentStatus: isPaymentStatus(paymentStatus)
          ? paymentStatus
          : "unpaid",
        paymentReference: asString(obj.payment_intent),
        amountTotal,
        metadata: extractSessionMetadata(metadata),
      });
    }

    // Fallback: retrieve session by ID from event data
    if (id) {
      return this.retrieveSession(id);
    }

    return Promise.resolve(null);
  },
};
