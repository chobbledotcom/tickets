/**
 * SumUp implementation of the PaymentProvider interface.
 *
 * Wraps sumup.ts to conform to the provider-agnostic PaymentProvider contract.
 *
 * Key differences from Stripe/Square:
 * - Hosted Checkout; our checkout_reference is the session id throughout
 * - Booking metadata is staged locally, encrypted (db/sumup-checkouts.ts)
 * - Webhooks are unsigned (no signature header in the provider registry):
 *   listings are pre-filtered against our staging rows, then the checkout is
 *   re-fetched from SumUp to establish authenticity and payment status
 * - No webhook endpoint to set up (return_url is set per checkout)
 */

import * as v from "valibot";
import { getSumupCheckout } from "#db/sumup-checkouts.ts";
import {
  type RefundAttemptResult,
  refundOutcomeAfterReread,
} from "#payment/refund-attempt.ts";
import {
  type AuthorizedRefundRequest,
  requireProviderRefundAuthorization,
} from "#payment/refund-provider-authorization.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  makeCreateCheckoutSession,
  parseWebhookPayload,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  RetrieveSessionResult,
  WebhookEvent,
  WebhookSessionResult,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  buildSumupSession,
  resolveSumupCheckoutById,
} from "#shared/sumup/checkout-resolution.ts";
import { readSumupCharge, sumupRefundOutcome } from "#shared/sumup/money.ts";
import { sumupApi } from "#shared/sumup.ts";

/** SumUp posts an object carrying two fields. A body that is not an object
 *  names no checkout at all, and this public door is unsigned, so anyone can
 *  post one. */
const SumupWebhookBodySchema = v.object({
  event_type: v.optional(v.string()),
  id: v.optional(v.string()),
});

/** Build the provider-agnostic event from the two fields SumUp posts, or
 *  nothing when the body is not one of its callbacks. A callback naming
 *  neither field is still read: resolveWebhookSession refuses a blank id
 *  before it looks anything up, so that absence is carried through rather
 *  than guessed at. */
const sumupWebhookEvent = (body: unknown): WebhookEvent | null => {
  // valibot reads a list as an object carrying none of the fields, and a
  // SumUp callback is never a list.
  if (Array.isArray(body)) return null;
  const posted = v.safeParse(SumupWebhookBodySchema, body);
  if (!posted.success) return null;
  const id = posted.output.id ?? "";
  return { data: { object: { id } }, id, type: posted.output.event_type ?? "" };
};

/** SumUp's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createSumupCheckoutSession = makeCreateCheckoutSession(
  "sumup",
  // A lambda, not the member itself: the checkout builder is captured once
  // at module load, and resolving the member per call keeps test stubs live.
  (intent, baseUrl) => sumupApi.createCheckout(intent, baseUrl),
  (result) => ({ id: result?.reference, url: result?.url }),
);

/** SumUp payment provider implementation. */
export const sumupPaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "CHECKOUT_STATUS_CHANGED",
  createCheckoutSession: createSumupCheckoutSession,

  readCharge: readSumupCharge,

  async refundCharge(
    request: AuthorizedRefundRequest,
  ): Promise<RefundAttemptResult> {
    requireProviderRefundAuthorization(request, "sumup");
    const submission = await sumupApi.refundTransaction(
      request.paymentReference,
    );
    if (submission.kind === "not_sent") return submission;

    // The immediate answer never outranks fresh money evidence: a rejected
    // request can race a refund made in the dashboard, while a successful or
    // uncertain call carries no conclusive refund facts of its own.
    const freshRead = await sumupPaymentProvider.readCharge(
      request.paymentReference,
    );
    return submission.kind === "rejected"
      ? refundOutcomeAfterReread({
          attempt: submission,
          freshCharge: freshRead,
          request,
        })
      : sumupRefundOutcome(submission, request, freshRead);
  },

  async resolveWebhookSession(
    webhookEvent: WebhookEvent,
  ): Promise<WebhookSessionResult> {
    return (await resolveSumupCheckoutById(webhookEvent.id, "Webhook"))
      .resolved;
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(sessionId: string): Promise<RetrieveSessionResult> {
    /* jscpd:ignore-end */
    // sessionId is our checkout_reference (set on the redirect URL); the
    // staged row carries the SumUp id for a direct fetch. An empty sumupId
    // means checkout creation failed after staging — nothing to retrieve.
    const stored = await getSumupCheckout(sessionId);
    if (!stored?.sumupId) return null;
    const read = await sumupApi.readCheckoutById(stored.sumupId);
    // SumUp being unreachable is temporary: throwing keeps the browser's
    // answer honest — a "not found" page for a passing outage would read as
    // a missing payment.
    if (read.status === "unavailable") {
      throw new Error(
        `SumUp could not answer for a staged checkout (${read.reason})`,
      );
    }
    // The redirect's reference opened this staging row, so the checkout it
    // names must echo that same reference back; anything else is not this
    // booking.
    if (read.status !== "found" || read.resource.reference !== sessionId) {
      return null;
    }
    return buildSumupSession(read.resource, stored.metadata);
  },

  // SumUp sets return_url per checkout — there is no global endpoint to register.
  setupWebhookEndpoint: (): Promise<WebhookSetupResult> =>
    Promise.resolve({
      error:
        "SumUp webhooks are configured automatically per checkout — no setup needed",
      success: false,
    }),
  type: "sumup",

  verifyWebhookSignature(payload: string): Promise<WebhookVerifyResult> {
    // SumUp does not sign webhooks; authenticity is established in
    // resolveWebhookSession. This door only reads the tiny payload.
    return Promise.resolve(
      parseWebhookPayload(payload, ErrorCode.SUMUP_WEBHOOK, sumupWebhookEvent),
    );
  },
};
