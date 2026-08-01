/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import type Stripe from "stripe";
import * as v from "valibot";
import { validatedPaymentSession } from "#shared/payment/validated-session.ts";
import {
  hasRequiredSessionMetadata,
  makeCreateCheckoutSession,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  ValidatedPaymentSession,
  WebhookEvent,
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

type StripeCheckoutCompletedEvent = Pick<
  Stripe.CheckoutSessionCompletedEvent,
  "data" | "id" | "type"
>;

const toValidatedSession = (
  session: StripeCheckoutSession,
): ValidatedPaymentSession | null => {
  const {
    amount_total,
    currency,
    id,
    metadata,
    payment_intent,
    payment_status,
  } = session;
  if (!hasRequiredSessionMetadata(metadata)) return null;
  return validatedPaymentSession({
    amountTotal: amount_total,
    createdAt: isoFromUnixSeconds(session.created),
    currency: currency ?? null,
    id,
    metadata,
    paymentReference: payment_intent ?? "",
    paymentStatus: payment_status,
  });
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  (...args) => stripeApi.createCheckoutSession(...args),
  (session) => ({ id: session?.id, url: session?.url }),
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType:
    "checkout.session.completed" satisfies StripeCheckoutCompletedEvent["type"],
  createCheckoutSession: createStripeCheckoutSession,

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await stripeApi.retrievePaymentIntent(paymentReference);
    return intent?.latest_charge?.refunded === true;
  },

  async refundPayment(paymentReference: string): Promise<boolean> {
    const result = await stripeApi.refundPayment(paymentReference);
    return result?.status === "succeeded";
  },
  requiresWebhookSignature: true,

  async resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<ValidatedPaymentSession | "skip" | null> {
    const id = obj.id;
    if (typeof id !== "string" || id.length === 0) return null;

    const session = v.parse(StripeCheckoutSessionSchema, obj);
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
