/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

/* jscpd:ignore-start -- imports */
import type Stripe from "stripe";
import * as v from "valibot";
import {
  mapProviderReader,
  type ProviderRead,
} from "#payment/provider-read.ts";
import { refundWithOneReread } from "#payment/refund-attempt.ts";
import { requireProviderRefundAuthorization } from "#payment/refund-provider-authorization.ts";
import { type ChargeMoney, chargeMoneyRead } from "#payment/resources.ts";
import { validatedPaymentSession } from "#payment/validated-session.ts";
/* jscpd:ignore-end */
import {
  hasRequiredSessionMetadata,
  makeCreateCheckoutSession,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  RetrieveSessionResult,
  WebhookEvent,
  WebhookSessionResult,
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
): RetrieveSessionResult => {
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
    currency,
    id,
    metadata,
    paymentReference: payment_intent ?? "",
    paymentStatus: payment_status,
    provider: "stripe",
  });
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "Stripe",
  (...args) => stripeApi.createCheckoutSession(...args),
  (session) => ({ id: session?.id, url: session?.url }),
);

const readStripeCharge = mapProviderReader(
  (reference) => stripeApi.readPaymentIntent(reference),
  ({ latest_charge: charge }): ProviderRead<ChargeMoney> => {
    if (charge === null) {
      return {
        reason: "missing_documented_resource",
        status: "invalid",
      };
    }
    if (!charge.captured || !charge.paid || charge.status !== "succeeded") {
      return { reason: "unsupported_status", status: "invalid" };
    }
    return chargeMoneyRead(
      charge.amount_captured,
      charge.currency,
      charge.amount_refunded,
    );
  },
);

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType:
    "checkout.session.completed" satisfies StripeCheckoutCompletedEvent["type"],
  createCheckoutSession: createStripeCheckoutSession,

  readCharge: readStripeCharge,
  refundCapability: "keyed",

  refundCharge: refundWithOneReread(
    (request) => {
      requireProviderRefundAuthorization(request, "stripe");
      return stripeApi.refundCharge(request);
    },
    (reference) => stripePaymentProvider.readCharge(reference),
  ),
  requiresWebhookSignature: true,

  async resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<WebhookSessionResult> {
    const id = obj.id;
    if (typeof id !== "string" || id.length === 0) return null;

    const session = v.parse(StripeCheckoutSessionSchema, obj);
    const validated = toValidatedSession(session);
    return validated === null ? await this.retrieveSession(id) : validated;
  },

  async retrieveSession(sessionId: string): Promise<RetrieveSessionResult> {
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
