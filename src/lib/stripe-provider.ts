/**
 * Stripe implementation of the PaymentProvider interface
 *
 * Wraps the existing stripe.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 */

import {
  extractSessionMetadata,
  hasRequiredSessionMetadata,
  PaymentUserError,
  toCheckoutResult,
} from "#lib/payment-helpers.ts";
import {
  type CheckoutIntent,
  type CheckoutSessionResult,
  isPaymentStatus,
  type PaymentProvider,
  type ValidatedPaymentSession,
  type WebhookEvent,
  type WebhookVerifyResult,
} from "#lib/payments.ts";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  setupWebhookEndpoint,
  refundPayment as stripeRefund,
  verifyWebhookSignature,
} from "#lib/stripe.ts";

/** Convert a Stripe checkout session to a CheckoutResult */
const stripeCheckoutResult = (
  session: { id?: string; url?: string | null } | null,
) => toCheckoutResult(session?.id, session?.url, "Stripe");

/** Wrap a checkout operation, converting PaymentUserError to { error } result */
const withUserError = async (
  op: () => Promise<CheckoutSessionResult>,
): Promise<CheckoutSessionResult> => {
  try {
    return await op();
  } catch (err) {
    if (err instanceof PaymentUserError) return { error: err.message };
    return null;
  }
};

/** Stripe payment provider implementation */
export const stripePaymentProvider: PaymentProvider = {
  type: "stripe",

  checkoutCompletedEventType: "checkout.session.completed",

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withUserError(async () => {
      const session = await createCheckoutSession(intent, baseUrl);
      return stripeCheckoutResult(session);
    });
  },

  async retrieveSession(
    sessionId: string,
  ): Promise<ValidatedPaymentSession | null> {
    const session = await retrieveCheckoutSession(sessionId);
    if (!session) return null;

    const { id, payment_status, payment_intent, metadata, amount_total } =
      session;

    if (!hasRequiredSessionMetadata(metadata)) {
      return null;
    }

    if (amount_total === null) return null;

    return {
      id,
      paymentStatus: isPaymentStatus(payment_status)
        ? payment_status
        : "unpaid",
      paymentReference:
        typeof payment_intent === "string" ? payment_intent : "",
      amountTotal: amount_total,
      metadata: extractSessionMetadata(metadata),
    };
  },

  async verifyWebhookSignature(
    payload: string,
    signature: string,
    _webhookUrl: string,
    _payloadBytes: Uint8Array,
  ): Promise<WebhookVerifyResult> {
    const result = await verifyWebhookSignature(payload, signature);
    if (!result.valid) {
      return { valid: false, error: result.error };
    }
    return {
      valid: true,
      event: result.event,
    };
  },

  async refundPayment(paymentReference: string): Promise<boolean> {
    const result = await stripeRefund(paymentReference);
    return result !== null;
  },

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const intent = await retrievePaymentIntent(paymentReference);
    if (!intent) return false;
    const charge = intent.latest_charge;
    if (typeof charge === "object" && charge !== null) {
      return (charge as { refunded: boolean }).refunded;
    }
    return false;
  },

  setupWebhookEndpoint(...args: Parameters<typeof setupWebhookEndpoint>) {
    return setupWebhookEndpoint(...args);
  },

  resolveWebhookSession({
    data: { object: obj },
  }: WebhookEvent): Promise<ValidatedPaymentSession | "skip" | null> {
    const metadata = obj.metadata as
      | Record<string, string | undefined>
      | undefined;

    // Stripe includes the full session in the event — extract directly
    if (
      typeof obj.id === "string" &&
      typeof obj.payment_status === "string" &&
      typeof obj.amount_total === "number" &&
      hasRequiredSessionMetadata(metadata)
    ) {
      return Promise.resolve({
        id: obj.id,
        paymentStatus: isPaymentStatus(obj.payment_status)
          ? obj.payment_status
          : "unpaid",
        paymentReference:
          typeof obj.payment_intent === "string" ? obj.payment_intent : "",
        amountTotal: obj.amount_total,
        metadata: extractSessionMetadata(metadata),
      });
    }

    // Fallback: retrieve session by ID from event data
    if (typeof obj.id === "string") {
      return this.retrieveSession(obj.id);
    }

    return Promise.resolve(null);
  },
};
