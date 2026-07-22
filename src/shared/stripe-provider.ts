/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import * as v from "valibot";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  hasRequiredSessionMetadata,
  makeCreateCheckoutSession,
  validatedPaymentSession,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  PaymentRefundResult,
  PaymentStatus,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSessionResolution,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  type StripeCheckoutSession,
  StripeCheckoutSessionSchema,
} from "#shared/stripe/schemas.ts";
import { verifyWebhookSignature } from "#shared/stripe/webhook.ts";
import {
  isoFromUnixSeconds,
  type StripeApi,
  stripeApi,
} from "#shared/stripe.ts";

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

const toValidatedSession = (
  session: StripeCheckoutSession,
): ValidatedPaymentSession | null => {
  const { amount_total, id, metadata, payment_intent, payment_status } =
    session;
  if (!hasRequiredSessionMetadata(metadata) || amount_total === null)
    return null;
  const paymentReference = payment_intent ?? "";
  if (!hasExpectedPaymentReference(id, payment_status, paymentReference)) {
    return null;
  }
  return validatedPaymentSession({
    amountTotal: amount_total,
    createdAt: isoFromUnixSeconds(session.created),
    id,
    metadata,
    paymentReference,
    paymentStatus: payment_status,
  });
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  (...args) => stripeApi.createCheckoutSession(...args),
  (session) => ({
    id: session?.id,
    providerCheckoutId: session?.id,
    url: session?.url,
  }),
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  checkoutWebhookEvents: {
    completed: "checkout.session.completed",
    expired: "checkout.session.expired",
  },
  closeCheckout: ({ providerCheckoutId }) =>
    stripeApi.closeCheckoutSession(providerCheckoutId),
  createCheckoutSession: createStripeCheckoutSession,

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await stripeApi.retrievePaymentIntent(paymentReference);
    return intent?.latest_charge?.refunded === true;
  },

  async refundPayment(paymentReference: string): Promise<PaymentRefundResult> {
    const result = await stripeApi.refundPayment(paymentReference);
    if (result?.status === "succeeded") return "refunded";
    return result?.status === "pending" || result?.status === "requires_action"
      ? "pending"
      : "failed";
  },
  requiresWebhookSignature: true,

  async resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<WebhookSessionResolution> {
    const id = obj.id;
    if (typeof id !== "string" || id.length === 0) return null;

    const session = v.parse(StripeCheckoutSessionSchema, obj);
    if (session.payment_status === "paid" && !session.payment_intent) {
      hasExpectedPaymentReference(session.id, "paid", "");
      return "retry";
    }
    const validated = toValidatedSession(session);
    return validated === null ? await this.retrieveSession(id) : validated;
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    const session = await stripeApi.retrieveCheckoutSession(sessionId);
    if (!session) return null;
    return toValidatedSession(session);
  },

  setupWebhookEndpoint(...args: Parameters<StripeApi["setupWebhookEndpoint"]>) {
    return stripeApi.setupWebhookEndpoint(...args);
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
