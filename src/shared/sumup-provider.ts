/**
 * SumUp implementation of the PaymentProvider interface.
 *
 * Wraps sumup.ts to conform to the provider-agnostic PaymentProvider contract.
 *
 * Key differences from Stripe/Square:
 * - Hosted Checkout; our checkout_reference is the session id throughout
 * - Booking metadata is staged locally, encrypted (db/sumup-checkouts.ts)
 * - Webhooks are unsigned (requiresWebhookSignature = false): listings are
 *   pre-filtered against our staging rows, then the checkout is re-fetched
 *   from SumUp to establish authenticity and payment status
 * - No webhook endpoint to set up (return_url is set per checkout)
 */

import {
  getSumupCheckout,
  hasSumupCheckoutId,
} from "#shared/db/sumup-checkouts.ts";
import { logDebug } from "#shared/logger.ts";
import {
  isSessionRejection,
  type SessionRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import {
  makeCreateCheckoutSession,
  toCanonicalIso,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  PaymentStatus,
  RetrieveSessionResult,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSessionResult,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  createCheckout,
  getTransactionStatus,
  refundTransaction,
  sumupApi,
} from "#shared/sumup.ts";
import type {
  SumupCheckout,
  SumupCheckoutStatus,
} from "#shared/sumup-observation.ts";

/** Map SumUp's checkout lifecycle to the provider-agnostic payment status.
 * FAILED (declined) and EXPIRED are terminal — the redirect handler shows the
 * cancel page for those instead of a "contact support" error. */
const toPaymentStatus = (status: SumupCheckoutStatus): PaymentStatus =>
  status === "PAID" ? "paid" : status === "PENDING" ? "unpaid" : "failed";

/** No real SumUp checkout id is anywhere near this long, so a longer one is
 * provably not ours and is refused before it costs a database lookup. */
const MAX_SUMUP_ID_BYTES = 255;

const isUsableSumupId = (id: string): boolean =>
  id !== "" && new TextEncoder().encode(id).byteLength <= MAX_SUMUP_ID_BYTES;

/** Refuse a callback retryably with a value-free console line. Forged and
 * unreadable callbacks must not spend alert subrequests, and the fixed words
 * carry the outcome without carrying any value from the payload. */
const refuseRetryably = (why: string): "retry" => {
  logDebug("Webhook", `SumUp callback refused retryably: ${why}`);
  return "retry";
};

/** Build a validated session from a fetched checkout and its staged metadata.
 * The metadata was written by our own buildItemsMetadata, so it always carries
 * the required fields. Returns a rejection when the checkout's charge or
 * resource id is malformed (the boundary validates both), so a paid charge the
 * boundary cannot read still reaches the refund path. */
const buildValidatedSession = (
  checkout: SumupCheckout,
  metadata: Record<string, string>,
): ValidatedPaymentSession | SessionRejection =>
  validatedPaymentSession({
    amountTotal: checkout.amountMinor,
    createdAt: toCanonicalIso(checkout.createdAt),
    currency: checkout.currency,
    id: checkout.reference,
    metadata: metadata as SessionMetadata,
    paymentReference: checkout.transactionId,
    paymentStatus: toPaymentStatus(checkout.status),
  });

/** SumUp's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createSumupCheckoutSession = makeCreateCheckoutSession(
  "SumUp",
  createCheckout,
  (result) => ({ id: result?.reference, url: result?.url }),
);

/** SumUp payment provider implementation. */
export const sumupPaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "CHECKOUT_STATUS_CHANGED",
  createCheckoutSession: createSumupCheckoutSession,

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    return (await getTransactionStatus(paymentReference)) === "REFUNDED";
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return refundTransaction(paymentReference);
  },
  requiresWebhookSignature: false,

  async resolveWebhookSession(
    webhookEvent: WebhookEvent,
  ): Promise<WebhookSessionResult> {
    if (!isUsableSumupId(webhookEvent.id)) return null;
    // Unsigned webhooks: only fetch checkouts we created. Spam and other
    // integrations' listings never cost an API call — but they are refused
    // retryably rather than acknowledged, because the same answer covers a
    // real callback racing our own staging write, and one fixed refusal
    // tells a forger nothing about whether an id exists.
    if (!(await hasSumupCheckoutId(webhookEvent.id))) {
      return refuseRetryably("checkout is not one we staged");
    }
    // The staging row already proved this checkout is ours, so anything but a
    // clean read is refused retryably: acknowledging is terminal, and a paid
    // checkout would be left with the money taken and no booking.
    const read = await sumupApi.readCheckoutById(webhookEvent.id);
    if (read.status !== "found") {
      return refuseRetryably(
        "reason" in read
          ? `read ${read.status} (${read.reason})`
          : "read missing",
      );
    }
    const checkout = read.resource;
    // The reference SumUp echoes back must be the one we generated for this
    // checkout and staged under this webhook id. If it is unknown or another
    // booking's, SumUp has contradicted itself about a checkout we created.
    // The booking is encrypted under that reference, so without a match we
    // can neither read it nor prove the charge is ours to refund.
    const stored = await getSumupCheckout(checkout.reference);
    if (!stored || stored.sumupId !== webhookEvent.id) {
      return refuseRetryably("reference does not open the staged row");
    }
    const session = buildValidatedSession(checkout, stored.metadata);
    // A charge the boundary could not read: surface the rejection so a paid
    // one still reaches the refund path.
    if (isSessionRejection(session)) return session;
    // Not yet (or never) paid: acknowledge without processing.
    return session.paymentStatus === "paid" ? session : "skip";
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
    return buildValidatedSession(read.resource, stored.metadata);
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
    // resolveWebhookSession. We only parse the tiny payload
    // ({ event_type, id }) into the provider-agnostic event shape here.
    try {
      const parsed = JSON.parse(payload) as {
        event_type?: string;
        id?: string;
      };
      const id = parsed.id ?? "";
      return Promise.resolve({
        listing: {
          data: { object: { id } },
          id,
          type: parsed.event_type ?? "",
        },
        valid: true,
      });
    } catch {
      return Promise.resolve({ error: "Invalid JSON payload", valid: false });
    }
  },
};
