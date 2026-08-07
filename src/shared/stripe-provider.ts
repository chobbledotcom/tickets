/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import type Stripe from "stripe";
import * as v from "valibot";
import {
  type SessionRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import type {
  PaymentAttempt,
  PaymentAttemptConfig,
} from "#shared/payment-attempt.ts";
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
import { createStripePaymentOperations } from "#shared/stripe/operations.ts";
import { stripeClientRuntime } from "#shared/stripe/runtime.ts";
import {
  type StripeCheckoutSession,
  StripeCheckoutSessionSchema,
} from "#shared/stripe/schemas.ts";
import {
  createStripeWebhookVerifier,
  verifyWebhookSignature,
} from "#shared/stripe/webhook.ts";
import {
  isoFromUnixSeconds,
  type StripeApi,
  stripeApi,
} from "#shared/stripe.ts";

type StripeCheckoutCompletedEvent = Pick<
  Stripe.CheckoutSessionCompletedEvent,
  "data" | "id" | "type"
>;

type StripeAttemptConfig = Extract<PaymentAttemptConfig, { type: "stripe" }>;
type StripeAttemptOperations = Omit<PaymentAttempt, "currency">;

const toValidatedSession = (
  session: StripeCheckoutSession,
): ValidatedPaymentSession | SessionRejection | null => {
  const {
    amount_total,
    currency,
    id,
    metadata,
    payment_intent: rawPaymentIntent,
    payment_status,
  } = session;
  if (!hasRequiredSessionMetadata(metadata)) return null;
  const paymentIntent =
    typeof rawPaymentIntent === "string"
      ? rawPaymentIntent
      : (rawPaymentIntent?.id ?? "");
  return validatedPaymentSession({
    amountTotal: amount_total,
    createdAt: isoFromUnixSeconds(session.created),
    currency,
    id,
    metadata,
    paymentReference: paymentIntent,
    paymentStatus: payment_status,
  });
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  (...args) => stripeApi.createCheckoutSession(...args),
  (session) => ({ id: session?.id, url: session?.url }),
);

const createStripeAttemptOperations = (
  payment: Pick<
    StripeApi,
    "refundPayment" | "retrieveCheckoutSession" | "retrievePaymentIntent"
  >,
  verify: (payload: string, signature: string) => Promise<WebhookVerifyResult>,
): StripeAttemptOperations => {
  const retrieveSession = async (
    sessionId: string,
  ): Promise<ValidatedPaymentSession | SessionRejection | null> => {
    const session = await payment.retrieveCheckoutSession(sessionId);
    if (!session) return null;
    return toValidatedSession(session);
  };

  return {
    checkoutCompletedEventType:
      "checkout.session.completed" satisfies StripeCheckoutCompletedEvent["type"],

    async isPaymentRefunded(paymentReference: string): Promise<boolean> {
      const intent = await payment.retrievePaymentIntent(paymentReference);
      return intent?.latest_charge?.refunded === true;
    },

    async refundPayment(paymentReference: string): Promise<boolean> {
      const result = await payment.refundPayment(paymentReference);
      return result?.status === "succeeded";
    },
    requiresWebhookSignature: true,

    async resolveWebhookSession({
      data: { object: obj },
    }: WebhookEvent): Promise<
      ValidatedPaymentSession | "skip" | SessionRejection | null
    > {
      const id = obj.id;
      if (typeof id !== "string" || id.length === 0) return null;

      const session = v.parse(StripeCheckoutSessionSchema, obj);
      const validated = toValidatedSession(session);
      return validated === null ? await retrieveSession(id) : validated;
    },

    retrieveSession,
    type: "stripe",

    async verifyWebhookSignature(
      payload: string,
      signature: string,
      _webhookUrl: string,
      _payloadBytes: Uint8Array,
    ): Promise<WebhookVerifyResult> {
      const result = await verify(payload, signature);
      if (!result.valid) {
        return { error: result.error, valid: false };
      }
      return {
        listing: result.listing,
        valid: true,
      };
    },
  };
};

const singletonAttemptOperations = createStripeAttemptOperations(
  stripeApi,
  verifyWebhookSignature,
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  ...singletonAttemptOperations,
  createCheckoutSession: createStripeCheckoutSession,
  setupWebhookEndpoint(...args: Parameters<StripeApi["setupWebhookEndpoint"]>) {
    return stripeApi.setupWebhookEndpoint(...args);
  },
};

/** Bind work on one existing Stripe payment to its original configuration. */
export const createStripePaymentAttempt = (
  config: StripeAttemptConfig,
): PaymentAttempt => {
  const verify = createStripeWebhookVerifier(config.webhookSecret);
  return {
    ...createStripeAttemptOperations(
      createStripePaymentOperations(stripeClientRuntime.bind(config.secretKey)),
      verify,
    ),
    currency: config.currency,
  };
};
