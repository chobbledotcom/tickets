/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import type Stripe from "stripe";
import * as v from "valibot";
import { makeCreateCheckoutSession } from "#payment/checkout-session.ts";
import {
  mapProviderReader,
  type ProviderRead,
} from "#payment/provider-read.ts";
import { refundWithOneReread } from "#payment/refund-attempt.ts";
import { requireProviderRefundAuthorization } from "#payment/refund-provider-authorization.ts";
import { type ChargeMoney, chargeMoneyRead } from "#payment/resources.ts";
import { validatedPaymentSession } from "#payment/validated-session.ts";
import { hasRequiredSessionMetadata } from "#shared/payment-helpers.ts";
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
import { subscriptionStartOf } from "#shared/stripe/subscription.ts";
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

/** The resource of a read the completion cannot go without. A refused read
 * stops the callback, so the provider asks again. */
const foundOrThrow = <Resource>(
  read: ProviderRead<Resource>,
  name: string,
): Resource => {
  if (read.status === "found") return read.resource;
  throw new Error(`Stripe ${name} could not be read: ${JSON.stringify(read)}`);
};

/** The charge a session paid with. A subscription-mode session names no
 * payment intent of its own. The intent that paid the session's own first
 * invoice is the charge, so a later renewal can never stand in for it. */
const sessionCharge = async (
  session: StripeCheckoutSession,
): Promise<
  Pick<ValidatedSessionFields, "paymentReference" | "subscription">
> => {
  if (session.mode !== "subscription" || session.subscription === null) {
    return { paymentReference: session.payment_intent ?? "" };
  }
  const invoiceId = session.invoice;
  if (invoiceId === null) {
    throw new Error(`Stripe session ${session.id} names no first invoice`);
  }
  const [subscription, invoice] = await Promise.all([
    stripeApi.readSubscription(session.subscription),
    stripeApi.readInvoicePayments(invoiceId),
  ]);
  const { paymentReference, start } = subscriptionStartOf(
    foundOrThrow(subscription, `subscription ${session.subscription}`),
    foundOrThrow(invoice, `invoice ${invoiceId}`),
  );
  return { paymentReference, subscription: start };
};

type ValidatedSessionFields = Parameters<typeof validatedPaymentSession>[0];

const toValidatedSession = async (
  session: StripeCheckoutSession,
): Promise<RetrieveSessionResult> => {
  const { amount_total, currency, id, metadata, payment_status, status } =
    session;
  if (!hasRequiredSessionMetadata(metadata)) return null;
  return validatedPaymentSession({
    amountTotal: amount_total,
    createdAt: isoFromUnixSeconds(session.created),
    currency,
    id,
    metadata,
    ...(await sessionCharge(session)),
    // An expired session cannot take payment again, so a buyer returning to
    // one gets the cancel page with its try-again link, not the waiting page.
    paymentStatus: status === "expired" ? "failed" : payment_status,
    provider: "stripe",
  });
};

/** Stripe's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createStripeCheckoutSession = makeCreateCheckoutSession(
  "stripe",
  (...args) => stripeApi.createCheckoutSession(...args),
  (session) => {
    // Stripe ends its own page at the expiry we sent. The create answer
    // echoes that time back. It is the whole fact the answers prune reads.
    const linkEndsAt = isoFromUnixSeconds(session?.expires_at);
    return {
      id: session?.id,
      ...(linkEndsAt === undefined ? {} : { linkEndsAt }),
      url: session?.url,
    };
  },
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

  refundCharge: refundWithOneReread(
    (request) => {
      requireProviderRefundAuthorization(request, "stripe");
      return stripeApi.refundCharge(request);
    },
    (reference) => stripePaymentProvider.readCharge(reference),
  ),

  async resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<WebhookSessionResult> {
    const id = obj.id;
    if (typeof id !== "string" || id.length === 0) return null;

    const session = v.parse(StripeCheckoutSessionSchema, obj);
    const validated = await toValidatedSession(session);
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
