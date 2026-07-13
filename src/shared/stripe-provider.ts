/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import { asString } from "#fp";
import {
  hasRequiredSessionMetadata,
  makeCreateCheckoutSession,
  validatedPaymentSession,
} from "#shared/payment-helpers.ts";
import {
  isPaymentStatus,
  type PaymentProvider,
  type PaymentStatus,
  type ValidatedPaymentSession,
  type WebhookEvent,
  type WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  createCheckoutSession,
  expireCheckoutSession,
  isoFromUnixSeconds,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  setupWebhookEndpoint,
  refundPayment as stripeRefund,
  verifyWebhookSignature,
} from "#shared/stripe.ts";

/** Stripe's payment_status string, or "unpaid" when it isn't one we know. */
const toPaymentStatus = (status: string): PaymentStatus =>
  isPaymentStatus(status) ? status : "unpaid";

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  createCheckoutSession,
  (session) => ({ id: session?.id, url: session?.url }),
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "checkout.session.completed",

  checkoutExpiredEventType: "checkout.session.expired",

  createCheckoutSession: createStripeCheckoutSession,

  expireCheckoutSession: (sessionId: string) =>
    expireCheckoutSession(sessionId),

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await retrievePaymentIntent(paymentReference);
    return intent?.latest_charge?.refunded ?? false;
  },

  async refundPayment(paymentReference: string): Promise<boolean> {
    const result = await stripeRefund(paymentReference);
    return result !== null;
  },
  requiresWebhookSignature: true,

  resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<ValidatedPaymentSession | "skip" | null> {
    const metadata = obj.metadata as
      | Record<string, string | undefined>
      | undefined;

    const id = asString(obj.id);
    const paymentStatus = asString(obj.payment_status);
    const amountTotal = obj.amount_total;

    // Stripe includes the full session in the listing — extract directly
    if (
      id &&
      paymentStatus &&
      typeof amountTotal === "number" &&
      hasRequiredSessionMetadata(metadata)
    ) {
      return Promise.resolve(
        validatedPaymentSession({
          amountTotal,
          createdAt: isoFromUnixSeconds(obj.created),
          id,
          metadata,
          paymentReference: asString(obj.payment_intent),
          paymentStatus: toPaymentStatus(paymentStatus),
        }),
      );
    }

    // Fallback: retrieve session by ID from listing data
    if (id) {
      return this.retrieveSession(id);
    }

    return Promise.resolve(null);
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

    return validatedPaymentSession({
      amountTotal: amount_total,
      createdAt: isoFromUnixSeconds(session.created),
      id,
      metadata,
      paymentReference: payment_intent ?? "",
      paymentStatus: toPaymentStatus(payment_status),
    });
  },

  setupWebhookEndpoint(...args: Parameters<typeof setupWebhookEndpoint>) {
    return setupWebhookEndpoint(...args);
  },
  type: "stripe",

  async verifyWebhookSignature(
    payload: string,
    signature: string,
    _webhookUrl: string,
    _payloadBytes: Uint8Array,
  ): Promise<WebhookVerifyResult> {
    const result = await verifyWebhookSignature(payload, signature);
    if (!result.valid) {
      return { error: result.error, valid: false };
    }
    return {
      listing: result.listing,
      valid: true,
    };
  },
};
