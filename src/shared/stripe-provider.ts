/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import { asString } from "#fp";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  hasRequiredSessionMetadata,
  makeCreateCheckoutSession,
  validatedPaymentSession,
} from "#shared/payment-helpers.ts";
import {
  isPaymentStatus,
  type PaymentProvider,
  type PaymentRefundResult,
  type PaymentStatus,
  type ValidatedPaymentSession,
  type WebhookEvent,
  type WebhookSessionResolution,
  type WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  closeCheckoutSession,
  createCheckoutSession,
  isoFromUnixSeconds,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  STRIPE_CHECKOUT_WEBHOOK_EVENTS,
  setupWebhookEndpoint,
  refundPayment as stripeRefund,
  verifyWebhookSignature,
} from "#shared/stripe.ts";

/** Stripe's payment_status string, or "unpaid" when it isn't one we know. */
const toPaymentStatus = (status: string): PaymentStatus =>
  isPaymentStatus(status) ? status : "unpaid";

/** A paid Stripe checkout must identify the payment that can be refunded. */
const hasExpectedPaymentReference = (
  id: string,
  paymentStatus: PaymentStatus,
  paymentReference: string,
): boolean => {
  if (paymentStatus !== "paid" || paymentReference) return true;
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Stripe checkout ${id} is paid but has no payment intent`,
  });
  return false;
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  createCheckoutSession,
  (session) => ({
    id: session?.id,
    providerCheckoutId: session?.id,
    url: session?.url,
  }),
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  checkoutWebhookEvents: STRIPE_CHECKOUT_WEBHOOK_EVENTS,
  closeCheckout: ({ providerCheckoutId }) =>
    closeCheckoutSession(providerCheckoutId),
  createCheckoutSession: createStripeCheckoutSession,

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await retrievePaymentIntent(paymentReference);
    return intent?.latest_charge?.refunded ?? false;
  },

  async refundPayment(paymentReference: string): Promise<PaymentRefundResult> {
    const result = await stripeRefund(paymentReference);
    if (result?.status === "succeeded") return "refunded";
    return result?.status === "pending" || result?.status === "requires_action"
      ? "pending"
      : "failed";
  },
  requiresWebhookSignature: true,

  resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<WebhookSessionResolution> {
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
      const normalizedStatus = toPaymentStatus(paymentStatus);
      const paymentReference = asString(obj.payment_intent);
      if (
        !hasExpectedPaymentReference(id, normalizedStatus, paymentReference)
      ) {
        return Promise.resolve("retry");
      }
      return Promise.resolve(
        validatedPaymentSession({
          amountTotal,
          createdAt: isoFromUnixSeconds(obj.created),
          id,
          metadata,
          paymentReference,
          paymentStatus: normalizedStatus,
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

    const paymentStatus = toPaymentStatus(payment_status);
    const paymentReference = payment_intent ?? "";
    if (!hasExpectedPaymentReference(id, paymentStatus, paymentReference)) {
      return null;
    }
    return validatedPaymentSession({
      amountTotal: amount_total,
      createdAt: isoFromUnixSeconds(session.created),
      id,
      metadata,
      paymentReference,
      paymentStatus,
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
