/* jscpd:ignore-start -- imports */
import * as v from "valibot";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import {
  hasRequiredSessionMetadata,
  makeProviderCheckout,
} from "#shared/payment-helpers.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import {
  ignoredProviderNotice,
  parseVerifiedProviderNotice,
  providerNotice,
} from "#shared/payment-runtime/provider-notice.ts";
import {
  foundProviderPayment,
  invalidProviderRead,
  providerCharge,
  providerFactDetails,
} from "#shared/payment-runtime/provider-read.ts";
import {
  type ProviderRead,
  ProviderReadSchema,
} from "#shared/payment-state/observation.ts";
import {
  type ChargeLeg,
  type Money,
  type ProviderResource,
  type RefundObservation,
  ResourceIdSchema,
} from "#shared/payment-state/resources.ts";
import type { PaymentProvider, WebhookVerifyResult } from "#shared/payments.ts";
import {
  invalidProviderReadResult,
  providerReadForTransportIssue,
  providerReadValidator,
} from "#shared/provider-transport.ts";
import { refundStripeCharge } from "#shared/stripe/provider-refund.ts";
import type {
  StripeCharge,
  StripeCheckoutSession,
  StripeExpandedPaymentIntent,
  StripeRefund,
} from "#shared/stripe/schemas.ts";
import { verifyWebhookSignature } from "#shared/stripe/webhook.ts";
import {
  isoFromUnixSeconds,
  type StripeApi,
  stripeApi,
} from "#shared/stripe.ts";

/* jscpd:ignore-end */

const StripeNoticeSchema = v.object({
  data: v.object({ object: v.object({ id: ResourceIdSchema }) }),
  id: ResourceIdSchema,
  type: v.string(),
});

const stripeResources = PAYMENT_PROVIDER_RESOURCES.stripe;

const stripeMoney = (amount: number, currency: string): Money => ({
  amount,
  currency: currency.toUpperCase(),
});

const createStripeCheckout = makeProviderCheckout(
  "Stripe",
  (checkout) => stripeApi.createCheckout(checkout),
  (session) => ({
    session: session === null ? undefined : stripeResources.session(session.id),
    sessionId: session?.id,
    url: session?.url,
  }),
);

type SessionIdResult = { id: string } | { read: ProviderRead };

const sessionIdFor = (
  payment: PaymentSession | null,
  requested: ProviderResource,
): SessionIdResult => {
  if (requested.provider !== "stripe") {
    return invalidProviderReadResult(requested, payment, "mismatched_parent");
  }
  if (requested.kind === "stripe_checkout_session") {
    return { id: requested.id };
  }
  if (requested.kind === "stripe_payment_intent") {
    return { id: requested.parentId };
  }
  const stored = payment?.session;
  return stored?.provider === "stripe"
    ? { id: stored.id }
    : {
        read: invalidProviderRead(
          requested,
          payment,
          "missing_documented_resource",
        ),
      };
};

const storedSessionMatches = (
  payment: PaymentSession | null,
  sessionId: string,
): boolean =>
  payment?.session === null ||
  payment?.session === undefined ||
  (payment.session.provider === "stripe" && payment.session.id === sessionId);

const paidResourcesMatch = (
  session: StripeCheckoutSession,
  intent: StripeExpandedPaymentIntent,
  charge: StripeCharge,
): boolean =>
  session.amount_total === intent.amount &&
  intent.amount === intent.amount_received &&
  intent.amount_received === charge.amount &&
  charge.amount === charge.amount_captured &&
  session.currency === intent.currency &&
  intent.currency === charge.currency &&
  session.livemode === intent.livemode &&
  intent.livemode === charge.livemode;

const requestedChargeMatches = (
  requested: ProviderResource,
  intentId: string,
): "mismatched_id" | "mismatched_parent" | null => {
  if (requested.kind === "stripe_payment_intent" && requested.id !== intentId) {
    return "mismatched_id";
  }
  if (requested.kind === "stripe_refund" && requested.parentId !== intentId) {
    return "mismatched_parent";
  }
  return null;
};

const refundObservation = (refund: StripeRefund): RefundObservation => {
  const amount = stripeMoney(refund.amount, refund.currency);
  const resource = stripeResources.refund(refund.id, refund.payment_intent);
  if (refund.status === "succeeded") {
    return { amount, refund: resource, status: "completed" };
  }
  if (refund.status === "pending" || refund.status === "requires_action") {
    return { amount, refund: resource, status: "pending" };
  }
  return {
    amount,
    reason: "provider_failed",
    refund: resource,
    status: "failed",
  };
};

type RequestedRefundResult =
  | { observation?: RefundObservation }
  | { read: ProviderRead };

const readRequestedRefund = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  intent: StripeExpandedPaymentIntent,
  charge: StripeCharge,
): Promise<RequestedRefundResult> => {
  if (requested.kind !== "stripe_refund") return {};
  const lookup = await stripeApi.retrieveRefund(requested.id);
  if (lookup.status !== "found") {
    return {
      read: providerReadForTransportIssue(lookup, payment, requested),
    };
  }
  const refund = lookup.value;
  if (refund.id !== requested.id) {
    return invalidProviderReadResult(requested, payment, "mismatched_id");
  }
  const validate = providerReadValidator(requested, payment);
  const wrongParent = validate(
    refund.payment_intent === intent.id &&
      refund.charge === charge.id &&
      requested.parentId === intent.id,
    "mismatched_parent",
  );
  if (wrongParent !== null) return wrongParent;
  const malformed = validate(
    refund.currency === charge.currency &&
      refund.amount <= charge.amount_captured &&
      (refund.status !== "succeeded" ||
        refund.amount <= charge.amount_refunded),
    "malformed_response",
  );
  if (malformed !== null) return malformed;
  return { observation: refundObservation(refund) };
};

const actualModeRead = (
  read: ProviderRead,
  livemode: boolean,
  requested: ProviderResource,
): ProviderRead => {
  if (read.status !== "found") return read;
  return v.parse(ProviderReadSchema, {
    ...read,
    observation: {
      ...read.observation,
      mode: livemode ? "live" : "test",
    },
    requested,
    returned: requested,
  });
};

const foundStripePayment = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  session: StripeCheckoutSession,
  status: "failed" | "paid" | "pending",
  charges?: ChargeLeg[],
): Promise<ProviderRead> => {
  const metadata = hasRequiredSessionMetadata(session.metadata)
    ? session.metadata
    : undefined;
  const baseRequest =
    requested.kind === "stripe_refund"
      ? stripeResources.charge(requested.parentId, session.id)
      : requested;
  const read = await foundProviderPayment(
    payment,
    baseRequest,
    stripeResources.session(session.id),
    stripeMoney(session.amount_total, session.currency),
    status,
    providerFactDetails(charges, isoFromUnixSeconds(session.created), metadata),
  );
  return actualModeRead(read, session.livemode, requested);
};

const readCapturedStripeIntent = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  session: StripeCheckoutSession,
  intent: StripeExpandedPaymentIntent,
): Promise<ProviderRead> => {
  const requestedMismatch = requestedChargeMatches(requested, intent.id);
  if (requestedMismatch !== null) {
    return invalidProviderRead(requested, payment, requestedMismatch);
  }
  if (intent.status !== "succeeded") {
    return invalidProviderRead(requested, payment, "unsupported_status");
  }
  const charge = intent.latest_charge;
  if (charge === null) {
    return invalidProviderRead(
      requested,
      payment,
      "missing_documented_resource",
    );
  }
  if (charge.payment_intent !== intent.id) {
    return invalidProviderRead(requested, payment, "mismatched_parent");
  }
  if (!charge.captured || !charge.paid) {
    return invalidProviderRead(requested, payment, "unsupported_status");
  }
  if (!paidResourcesMatch(session, intent, charge)) {
    return invalidProviderRead(requested, payment, "malformed_response");
  }
  const requestedRefund = await readRequestedRefund(
    payment,
    requested,
    intent,
    charge,
  );
  if ("read" in requestedRefund) return requestedRefund.read;
  const chargeLeg = providerCharge(
    stripeMoney(charge.amount_captured, charge.currency),
    stripeMoney(charge.amount_refunded, charge.currency),
    stripeResources.charge(intent.id, session.id),
  );
  const charges = [
    requestedRefund.observation === undefined
      ? chargeLeg
      : { ...chargeLeg, refunds: [requestedRefund.observation] },
  ];
  return foundStripePayment(payment, requested, session, "paid", charges);
};

const readPaidStripePayment = async (
  payment: PaymentSession | null,
  requested: ProviderResource,
  session: StripeCheckoutSession,
): Promise<ProviderRead> => {
  if (session.status !== "complete") {
    return invalidProviderRead(requested, payment, "unsupported_status");
  }
  if (session.payment_intent === null) {
    return invalidProviderRead(
      requested,
      payment,
      "missing_documented_resource",
    );
  }
  const intentLookup = await stripeApi.lookupPaymentIntent(
    session.payment_intent,
  );
  if (intentLookup.status !== "found") {
    return providerReadForTransportIssue(intentLookup, payment, requested);
  }
  if (intentLookup.value.id !== session.payment_intent) {
    return invalidProviderRead(requested, payment, "mismatched_id");
  }
  return readCapturedStripeIntent(
    payment,
    requested,
    session,
    intentLookup.value,
  );
};

const readStripePayment: PaymentProvider["readPayment"] = async (
  payment,
  requested,
) => {
  const sessionId = sessionIdFor(payment, requested);
  if ("read" in sessionId) return sessionId.read;
  if (!storedSessionMatches(payment, sessionId.id)) {
    return invalidProviderRead(requested, payment, "mismatched_parent");
  }
  const sessionLookup = await stripeApi.lookupCheckoutSession(sessionId.id);
  if (sessionLookup.status !== "found") {
    return providerReadForTransportIssue(sessionLookup, payment, requested);
  }
  const session = sessionLookup.value;
  if (session.id !== sessionId.id) {
    return invalidProviderRead(requested, payment, "mismatched_id");
  }
  if (session.payment_status !== "paid") {
    if (requested.kind !== "stripe_checkout_session") {
      return invalidProviderRead(
        requested,
        payment,
        "missing_documented_resource",
      );
    }
    return foundStripePayment(
      payment,
      requested,
      session,
      session.status === "expired" ? "failed" : "pending",
    );
  }
  return readPaidStripePayment(payment, requested, session);
};

const verifyStripeNotice = async (
  payload: string,
  signature: string,
): Promise<WebhookVerifyResult> => {
  const verified = await verifyWebhookSignature(payload, signature);
  return parseVerifiedProviderNotice(verified, StripeNoticeSchema, (event) =>
    event.type === "checkout.session.completed"
      ? providerNotice(
          event.id,
          stripeResources.session(event.data.object.id),
          event.type,
        )
      : ignoredProviderNotice(),
  );
};

export const stripePaymentProvider: PaymentProvider = {
  createCheckout: createStripeCheckout,
  readPayment: readStripePayment,
  refundCharge: refundStripeCharge,
  requiresWebhookSignature: true,
  setupWebhookEndpoint(...args: Parameters<StripeApi["setupWebhookEndpoint"]>) {
    return stripeApi.setupWebhookEndpoint(...args);
  },
  type: "stripe",
  verifyWebhookSignature: (payload, signature) =>
    verifyStripeNotice(payload, signature),
};
