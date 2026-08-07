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

/* jscpd:ignore-start */
import {
  getSumupCheckout,
  hasSumupCheckoutId,
} from "#shared/db/sumup-checkouts.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import type { SessionRejection } from "#shared/payment/validated-session.ts";
import type {
  PaymentAttempt,
  PaymentAttemptConfig,
} from "#shared/payment-attempt.ts";
import {
  extractSessionMetadata,
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
  createSumupClientOperations,
  isTransactionRefunded,
  refundTransaction,
  retrieveCheckoutById,
  type SumupCheckout,
  type SumupClientOperations,
  sumupApi,
} from "#shared/sumup.ts";

/* jscpd:ignore-end */

/** Map SumUp's checkout lifecycle to the provider-agnostic payment status.
 * FAILED (declined) and EXPIRED are terminal — the redirect handler shows the
 * cancel page for those instead of a "contact support" error. */
const toPaymentStatus = (status: SumupCheckout["status"]): PaymentStatus =>
  status === "PAID" ? "paid" : status === "PENDING" ? "unpaid" : "failed";

/** Build a validated session from a parsed checkout and its staged metadata. */
const buildValidatedSession = (
  checkout: SumupCheckout,
  metadata: Record<string, string>,
): ValidatedPaymentSession => {
  const createdAt = toCanonicalIso(checkout.createdAt);
  return {
    amountTotal: checkout.amountMinor,
    ...(createdAt === undefined ? {} : { createdAt }),
    currency: checkout.currency,
    id: checkout.reference,
    metadata: extractSessionMetadata(metadata as SessionMetadata),
    paymentReference: checkout.transactionId,
    paymentStatus: toPaymentStatus(checkout.status),
  };
};

/** SumUp's checkout-session builder (see {@link makeCreateCheckoutSession}). */
const createSumupCheckoutSession = makeCreateCheckoutSession(
  "SumUp",
  createCheckout,
  (result) => ({ id: result?.reference, url: result?.url }),
);

type SumupProviderOperations = SumupClientOperations;

const resolveWebhookSession = async (
  operations: SumupProviderOperations,
  webhookEvent: WebhookEvent,
): Promise<ValidatedPaymentSession | "skip" | SessionRejection | null> => {
  if (!webhookEvent.id) return null;
  // Unsigned webhooks only fetch checkouts we created.
  if (!(await hasSumupCheckoutId(webhookEvent.id))) return "skip";
  const checkout = await operations.retrieveCheckoutById(webhookEvent.id);
  if (!checkout) {
    throw new Error(`SumUp checkout ${webhookEvent.id} could not be read`);
  }
  // SumUp must return the reference staged for this checkout id.
  const stored = isResourceId(checkout.reference)
    ? await getSumupCheckout(checkout.reference)
    : null;
  if (!stored || stored.sumupId !== webhookEvent.id) {
    throw new Error(
      `SumUp checkout ${webhookEvent.id} came back under reference "${checkout.reference}", which is not the one staged for it (status=${checkout.status}, transaction=${checkout.transactionId})`,
    );
  }
  const session = buildValidatedSession(checkout, stored.metadata);
  return session.paymentStatus === "paid" ? session : "skip";
};

const createSumupProvider = (
  operations: SumupProviderOperations,
): PaymentProvider => ({
  checkoutCompletedEventType: "CHECKOUT_STATUS_CHANGED",
  createCheckoutSession: createSumupCheckoutSession,

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    return (await operations.isTransactionRefunded(paymentReference)) === true;
  },

  refundPayment(paymentReference: string): Promise<boolean> {
    return operations.refundTransaction(paymentReference);
  },
  requiresWebhookSignature: false,

  async resolveWebhookSession(
    webhookEvent: WebhookEvent,
  ): Promise<ValidatedPaymentSession | "skip" | SessionRejection | null> {
    return await resolveWebhookSession(operations, webhookEvent);
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
    const checkout = await operations.retrieveCheckoutById(stored.sumupId);
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
});

const configuredOperations: SumupProviderOperations = {
  isTransactionRefunded,
  refundTransaction,
  retrieveCheckoutById,
};

/** SumUp payment provider implementation. */
export const sumupPaymentProvider: PaymentProvider =
  createSumupProvider(configuredOperations);

type SumupAttemptConfig = Extract<PaymentAttemptConfig, { type: "sumup" }>;

/** Bind settlement to the credentials captured when the payment was observed. */
export const createSumupPaymentAttempt = (
  config: SumupAttemptConfig,
): PaymentAttempt => {
  const client = sumupApi.getSumupClient(config.apiKey);
  if (!client) throw new Error("SumUp API key is required");
  const operations = createSumupClientOperations(client, config.merchantCode);
  return { ...createSumupProvider(operations), currency: config.currency };
};
