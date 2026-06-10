/**
 * SumUp implementation of the PaymentProvider interface.
 *
 * Wraps sumup.ts to conform to the provider-agnostic PaymentProvider contract.
 *
 * Key differences from Stripe/Square:
 * - Hosted Checkout; our checkout_reference is the session id throughout
 * - Booking metadata is stored locally (not on the provider) and looked up by
 *   reference (db/sumup-checkouts.ts)
 * - Webhooks are unsigned (requiresWebhookSignature = false); the webhook only
 *   carries a checkout id, so we re-fetch to establish authenticity + status
 * - There is no programmatic webhook endpoint to set up (the return_url is set
 *   per checkout at creation time)
 */

import { getSumupCheckoutMetadata } from "#shared/db/sumup-checkouts.ts";
import {
  toCheckoutResult,
  toValidatedSession,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
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
  retrieveCheckoutByReference,
  type SumupCheckout,
} from "#shared/sumup.ts";

/**
 * Build a validated session from a SumUp checkout, joining the locally-stored
 * booking metadata. Returns null when the checkout is unknown to us (no stored
 * metadata) — e.g. created by another integration sharing the account.
 */
const buildValidatedSession = async (
  checkout: SumupCheckout,
): Promise<ValidatedPaymentSession | null> => {
  if (!checkout.reference) return null;
  const metadata = await getSumupCheckoutMetadata(checkout.reference);
  return toValidatedSession(
    {
      amountTotal: checkout.amountMinor,
      id: checkout.reference,
      paymentReference: checkout.transactionId,
      paymentStatus: checkout.status === "PAID" ? "paid" : "unpaid",
    },
    metadata,
  );
};

/** SumUp payment provider implementation. */
export const sumupPaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "CHECKOUT_STATUS_CHANGED",
  requiresWebhookSignature: false,

  createCheckoutSession: (intent: CheckoutIntent, baseUrl: string) =>
    withCheckoutError(async () => {
      const result = await createCheckout(intent, baseUrl);
      return toCheckoutResult(result?.reference, result?.url, "SumUp");
    }),

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    return (await getTransactionStatus(paymentReference)) === "REFUNDED";
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return refundTransaction(paymentReference);
  },

  async resolveWebhookSession(
    webhookEvent: WebhookEvent,
  ): Promise<ValidatedPaymentSession | "skip" | null> {
    // SumUp's webhook carries only the checkout id; re-fetch to confirm.
    if (!webhookEvent.id) return null;
    const checkout = await retrieveCheckoutById(webhookEvent.id);
    if (!checkout) return null;
    const session = await buildValidatedSession(checkout);
    // Unknown checkout, or not yet paid: acknowledge without processing.
    if (!session || session.paymentStatus !== "paid") return "skip";
    return session;
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    // sessionId is our checkout_reference (set on the redirect URL).
    const checkout = await retrieveCheckoutByReference(sessionId);
    return checkout ? buildValidatedSession(checkout) : null;
  },

  // SumUp sets return_url per checkout — there is no global endpoint to register.
  setupWebhookEndpoint: (): Promise<WebhookSetupResult> =>
    Promise.resolve({
      error:
        "SumUp webhooks are configured automatically per checkout — no setup needed",
      success: false,
    }),
  type: "sumup",

  verifyWebhookSignature(
    payload: string,
  ): Promise<WebhookVerifyResult> {
    // SumUp does not sign webhooks; authenticity is established by re-fetching
    // the checkout in resolveWebhookSession. We only parse the tiny payload
    // ({ event_type, id }) into the provider-agnostic event shape here.
    try {
      const parsed = JSON.parse(payload) as { event_type?: string; id?: string };
      const id = parsed.id ?? "";
      return Promise.resolve({
        event: {
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
