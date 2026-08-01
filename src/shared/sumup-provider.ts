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
import { isResourceId } from "#shared/payment/resource-id.ts";
import {
  isSessionRejection,
  malformedChargeRejection,
  type SessionRejection,
  sessionOrRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import {
  makeCreateCheckoutSession,
  toCanonicalIso,
} from "#shared/payment-helpers.ts";
import type {
  PaymentProvider,
  PaymentStatus,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSetupResult,
  WebhookVerifyResult,
} from "#shared/payments.ts";
import {
  createCheckout,
  getTransactionStatus,
  refundTransaction,
  retrieveCheckoutById,
  type SumupCheckout,
} from "#shared/sumup.ts";

/** Map SumUp's checkout lifecycle to the provider-agnostic payment status.
 * FAILED (declined) and EXPIRED are terminal — the redirect handler shows the
 * cancel page for those instead of a "contact support" error. */
const toPaymentStatus = (status: SumupCheckout["status"]): PaymentStatus =>
  status === "PAID" ? "paid" : status === "PENDING" ? "unpaid" : "failed";

/** Build a validated session from a fetched checkout and its staged metadata.
 * The metadata was written by our own buildItemsMetadata, so it always carries
 * the required fields. Returns a rejection when the checkout's charge or
 * resource id is malformed (the boundary validates both), so a paid charge the
 * boundary cannot read still reaches the refund path. */
const buildValidatedSession = (
  checkout: SumupCheckout,
  metadata: Record<string, string>,
): ValidatedPaymentSession | SessionRejection => {
  // An over-precise raw amount cannot be trusted in minor units: refuse the
  // charge and let the callback refund a paid one rather than booking a
  // charge for an amount the provider did not actually take.
  if (checkout.overPrecise) {
    return malformedChargeRejection(
      checkout.transactionId,
      checkout.status === "PAID",
      metadata as SessionMetadata,
    );
  }
  const build = validatedPaymentSession({
    amountTotal: checkout.amountMinor,
    createdAt: toCanonicalIso(checkout.createdAt),
    currency: checkout.currency,
    id: checkout.reference,
    metadata: metadata as SessionMetadata,
    paymentReference: checkout.transactionId,
    paymentStatus: toPaymentStatus(checkout.status),
  });
  return sessionOrRejection(build);
};

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
  ): Promise<ValidatedPaymentSession | "skip" | SessionRejection | null> {
    if (!webhookEvent.id) return null;
    // Unsigned webhooks: only fetch checkouts we created. Spam or another
    // integration's listings are acknowledged without an API call.
    if (!(await hasSumupCheckoutId(webhookEvent.id))) return "skip";
    const checkout = await retrieveCheckoutById(webhookEvent.id);
    if (!checkout) return null;
    // A blank checkout reference names no staged row — reject the malformed
    // webhook rather than dereferencing nothing.
    if (!isResourceId(checkout.reference)) return null;
    const stored = await getSumupCheckout(checkout.reference);
    if (!stored) return null;
    // The staged row must be the one the webhook id proved exists: the provider
    // response could otherwise name a different staged checkout and this flow
    // would process the wrong booking's metadata.
    if (stored.sumupId !== webhookEvent.id) return null;
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
  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | SessionRejection | null> {
    /* jscpd:ignore-end */
    // sessionId is our checkout_reference (set on the redirect URL); the
    // staged row carries the SumUp id for a direct fetch. An empty sumupId
    // means checkout creation failed after staging — nothing to retrieve.
    const stored = await getSumupCheckout(sessionId);
    if (!stored?.sumupId) return null;
    const checkout = await retrieveCheckoutById(stored.sumupId);
    return checkout && buildValidatedSession(checkout, stored.metadata);
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
