/**
 * Square implementation of the PaymentProvider interface
 *
 * Wraps the square.ts module to conform to the
 * provider-agnostic PaymentProvider contract.
 *
 * Key differences from Stripe:
 * - Uses Payment Links instead of checkout sessions
 * - Order ID is the session equivalent
 * - Webhook event is payment.updated (not checkout.session.completed)
 * - Retrieving session requires fetching Order + checking payment status
 * - Webhook setup is manual (user provides signature key from dashboard)
 */

/* jscpd:ignore-start -- imports */
import { logDebug } from "#shared/logger.ts";
import type { ChargeMoney } from "#shared/payment/resources.ts";
import { chargeMoneyOrNull } from "#shared/payment/resources.ts";
import { validatedPaymentSession } from "#shared/payment/validated-session.ts";
/* jscpd:ignore-end */
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  RetrieveSessionResult,
  WebhookEvent,
  WebhookSessionResult,
  WebhookSetupResult,
} from "#shared/payments.ts";
import { squareApi, verifyWebhookSignature } from "#shared/square.ts";

/**
 * How much of a Square payment has gone back, or nothing when Square's answer
 * cannot be read.
 *
 * Square leaves the refunded total off a payment nothing has gone back on, so
 * an absent one is a stated zero. A total that IS there but names no amount, or
 * names a different currency from the money taken, is an answer we cannot
 * account for — and reading either as zero would tell the refund guard the
 * buyer is still owed money that may already be back with them.
 */
const squareMoneyReturned = (
  refunded:
    | { amount?: bigint | undefined; currency?: string | undefined }
    | undefined,
  captured: { currency?: string | undefined },
): bigint | null => {
  if (refunded === undefined) return 0n;
  if (refunded.amount === undefined) return null;
  return refunded.currency === captured.currency ? refunded.amount : null;
};

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  checkoutCompletedEventType: "payment.updated",

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withCheckoutError(async () => {
      const link = await squareApi.createPaymentLink(intent, baseUrl);
      return toCheckoutResult(link?.orderId, link?.url, "Square");
    });
  },

  async readChargeMoneyOrNull(
    paymentReference: string,
  ): Promise<ChargeMoney | null> {
    const payment = await squareApi.retrievePayment(paymentReference);
    const captured = payment?.amountMoney;
    if (!captured) return null;
    const returned = squareMoneyReturned(payment.refundedMoney, captured);
    if (returned === null) return null;
    return chargeMoneyOrNull(captured.amount, captured.currency, returned);
  },
  refundCapability: "keyed",

  refundPayment(paymentReference: string): Promise<boolean> {
    return squareApi.refundPayment(paymentReference);
  },
  requiresWebhookSignature: true,

  async resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<WebhookSessionResult> {
    const obj = listing.data.object;

    // Square nests payment fields under data.object.payment
    const payment =
      typeof obj.payment === "object" && obj.payment !== null
        ? (obj.payment as Record<string, unknown>)
        : obj;

    const paymentId = typeof payment.id === "string" ? payment.id : null;
    if (!paymentId && listing.type.startsWith("payment.")) {
      throw new Error("Square payment webhook is missing id");
    }

    // Extract the order ID (Square's session equivalent)
    const orderId =
      typeof payment.order_id === "string" ? payment.order_id : null;

    if (!orderId || !paymentId) return Promise.resolve(null);

    // Skip non-completed payments to avoid unnecessary API calls
    if (typeof payment.status === "string" && payment.status !== "COMPLETED") {
      logDebug(
        "Square",
        `Skipping webhook for non-completed payment (status=${payment.status})`,
      );
      return Promise.resolve("skip");
    }

    // If the order has no metadata (e.g. created directly in Square
    // dashboard/POS, not by our system), skip silently instead of treating
    // it as an error — avoids noisy logs and 400 responses that trigger
    // Square webhook retries.
    const session = await this.retrieveSession(orderId, paymentId);
    return session ?? "skip";
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(
    sessionId: string,
    paidPaymentId?: string,
  ): Promise<RetrieveSessionResult> {
    /* jscpd:ignore-end */
    // sessionId is the Square order ID
    const order = await squareApi.retrieveOrder(sessionId);
    if (!order?.id) {
      logDebug("Square", `Order ${sessionId} not found`);
      return null;
    }

    const { metadata } = order;
    if (!hasRequiredSessionMetadata(metadata)) {
      logDebug("Square", `Order ${sessionId} missing required metadata fields`);
      return null;
    }

    // A webhook names the payment Square just reported COMPLETED, so it wins:
    // the order's tenders can lag behind it entirely, or still lead with an
    // earlier payment, and either would call this captured charge unpaid.
    const paymentReference =
      paidPaymentId ?? order.tenders?.[0]?.paymentId ?? "";
    const payment = paymentReference
      ? await squareApi.retrievePayment(paymentReference)
      : null;
    // The webhook already saw this payment complete, so a read-back that is
    // missing or still short of COMPLETED is Square lagging its own signed
    // event, not an unpaid order. Throwing answers the caller retryably; going
    // quiet would acknowledge a captured charge as pending, and Square would
    // have no reason to deliver it again.
    if (paidPaymentId && payment?.status !== "COMPLETED") {
      throw new Error(
        `Square payment ${paidPaymentId} did not read back as completed (status=${payment?.status ?? "unreadable"})`,
      );
    }

    // The payment must be for the order whose signed metadata we are about to
    // book. Square saying otherwise contradicts the signed event that sent us
    // here, so neither answer is safe: booking uses the wrong metadata, and
    // acknowledging is terminal on a charge that has already taken money.
    // Throwing keeps it retryable until Square answers consistently.
    if (
      payment &&
      payment.orderId !== undefined &&
      payment.orderId !== order.id
    ) {
      throw new Error(
        `Square payment ${paymentReference} reports order ${payment.orderId}, not ${order.id}`,
      );
    }

    // Money we can see was taken. A completed payment names its own amount, and
    // standing the order total in for it would let a short or unreadable charge
    // match the signed price and book as paid in full. Until then the order
    // total is all there is, and nothing has been captured against it.
    const paid = payment?.status === "COMPLETED";
    const charged = paid ? payment.amountMoney : order.totalMoney;
    return validatedPaymentSession({
      // A missing amount stays missing: Number(null) is 0, which the
      // boundary would accept as a real free order.
      amountTotal:
        typeof charged?.amount === "bigint" ? Number(charged.amount) : null,
      createdAt: toCanonicalIso(order.createdAt),
      currency: charged?.currency,
      id: order.id,
      metadata,
      paymentReference,
      paymentStatus: paid ? "paid" : "unpaid",
    });
  },

  setupWebhookEndpoint(
    _secretKey: string,
    _webhookUrl: string,
    _existingEndpointId?: string | null,
  ): Promise<WebhookSetupResult> {
    // Square webhook setup is manual - user creates subscription in dashboard
    // and provides the signature key. This method is a no-op for Square.
    return Promise.resolve({
      error:
        "Square webhooks must be configured manually in the Square Developer Dashboard",
      success: false,
    });
  },
  type: "square",

  verifyWebhookSignature(
    ...args: Parameters<PaymentProvider["verifyWebhookSignature"]>
  ) {
    return verifyWebhookSignature(...args);
  },
};
