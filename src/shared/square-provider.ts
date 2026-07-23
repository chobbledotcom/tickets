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

import { identity } from "#fp";
import { logDebug } from "#shared/logger.ts";
import {
  hasRequiredSessionMetadata,
  toCanonicalIso,
  toCheckoutResult,
  validatedPaymentSession,
  withCheckoutError,
} from "#shared/payment-helpers.ts";
import { hasTerminalPaymentOutcome } from "#shared/payment-outcome.ts";
import type {
  CheckoutIntent,
  PaymentProvider,
  PaymentRefundResult,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookEvent,
  WebhookSessionResolution,
  WebhookSetupResult,
} from "#shared/payments.ts";
import {
  closePaymentLink,
  createPaymentLink,
  refundPayment,
  retrieveCompletedPaymentForOrder,
  retrieveOrder,
  retrievePayment,
  verifyWebhookSignature,
} from "#shared/square.ts";
import {
  type CompletedSquarePayment,
  squareCloseTenderPaymentId,
  squareTenderPaymentIds,
} from "#shared/square-payments.ts";

type SquareOrder = NonNullable<Awaited<ReturnType<typeof retrieveOrder>>>;
type CompleteSquareOrder = SquareOrder & {
  id: string;
  metadata: SessionMetadata;
};

const squareSession = (
  order: CompleteSquareOrder,
  payment: {
    amountTotal: number;
    paymentReference: string;
    paymentStatus: ValidatedPaymentSession["paymentStatus"];
  },
): ValidatedPaymentSession =>
  validatedPaymentSession({
    ...payment,
    createdAt: toCanonicalIso(order.createdAt),
    id: order.id,
    metadata: order.metadata,
  });

const paidSquareSession = (
  order: CompleteSquareOrder,
  { amountTotal, paymentReference }: CompletedSquarePayment,
): ValidatedPaymentSession =>
  squareSession(order, {
    amountTotal,
    paymentReference,
    paymentStatus: "paid",
  });

type SquareSessionPayment =
  | { status: "missing" }
  | { status: "paid"; payment: CompletedSquarePayment }
  | { status: "refunded" };

/** A refund changes provider state only until local state records the outcome. */
const squareSessionPayment = async (
  order: SquareOrder & { id: string },
  replayTerminal: boolean,
): Promise<SquareSessionPayment> => {
  const payment = await retrieveCompletedPaymentForOrder(order);
  if (payment === null) return { status: "missing" };
  if (
    payment.refundedAmount > 0 &&
    (!replayTerminal || !(await hasTerminalPaymentOutcome(order.id)))
  ) {
    return { status: "refunded" };
  }
  return { payment, status: "paid" };
};

type PaymentOrderFor = (order: SquareOrder) => SquareOrder;

const closePaymentOrder = (order: SquareOrder): SquareOrder => {
  const paymentId = squareCloseTenderPaymentId(order);
  return {
    ...order,
    tenders: paymentId === null ? [] : [{ paymentId }],
  };
};

const retrieveSquareSession = async (
  sessionId: string,
  paymentOrderFor: PaymentOrderFor,
  replayTerminal: boolean,
): Promise<ValidatedPaymentSession | null> => {
  const order = await retrieveOrder(sessionId);
  if (!order?.id) {
    logDebug("Square", `Order ${sessionId} not found`);
    return null;
  }

  const { metadata } = order;
  if (!hasRequiredSessionMetadata(metadata)) {
    logDebug("Square", `Order ${sessionId} missing required metadata fields`);
    return null;
  }
  const completeOrder: CompleteSquareOrder = {
    ...order,
    id: order.id,
    metadata,
  };
  const paymentOrder = paymentOrderFor(order);
  const paymentIds = squareTenderPaymentIds(paymentOrder);
  const payment = await squareSessionPayment(
    {
      ...paymentOrder,
      id: completeOrder.id,
    },
    replayTerminal,
  );
  return payment.status === "paid"
    ? paidSquareSession(completeOrder, payment.payment)
    : squareSession(completeOrder, {
        amountTotal: Number(order.totalMoney.amount),
        paymentReference: paymentIds[0] ?? "",
        paymentStatus: "unpaid",
      });
};

type SquareWebhookPayment = {
  orderId: string;
  paymentId: string;
  status: unknown;
};

/** Read identifiers without mistaking another Square product for our order. */
const squareWebhookPayment = (
  listing: WebhookEvent,
): SquareWebhookPayment | null => {
  const object = listing.data.object;
  const payment =
    typeof object.payment === "object" && object.payment !== null
      ? (object.payment as Record<string, unknown>)
      : object;
  const orderId =
    typeof payment.order_id === "string" ? payment.order_id : null;
  const paymentId = typeof payment.id === "string" ? payment.id : null;
  if (!paymentId && listing.type.startsWith("payment.")) {
    throw new Error("Square payment webhook is missing id");
  }
  return orderId && paymentId
    ? { orderId, paymentId, status: payment.status }
    : null;
};

/** Square payment provider implementation */
export const squarePaymentProvider: PaymentProvider = {
  checkoutWebhookEvents: { completed: "payment.updated", expired: null },

  closeCheckout: ({ providerCheckoutId, sessionId }) =>
    closePaymentLink(providerCheckoutId, sessionId),

  createCheckoutSession(intent: CheckoutIntent, baseUrl: string) {
    return withCheckoutError(async () => {
      const link = await createPaymentLink(intent, baseUrl);
      return toCheckoutResult(link?.orderId, link?.url, "Square", link?.id);
    });
  },

  async isPaymentRefunded(paymentReference: string): Promise<boolean> {
    const payment = await retrievePayment(paymentReference);
    if (!payment) return false;
    // Fully refunded only: a partial refund leaves the customer still charged,
    // so it must not count as refunded (matches Stripe's charge.refunded and
    // SumUp's REFUNDED status, and keeps the refund-idempotency fallback honest).
    const charged = payment.amountMoney?.amount;
    const refunded = payment.refundedMoney?.amount;
    if (charged === undefined || refunded === undefined) return false;
    return charged > BigInt(0) && refunded >= charged;
  },

  refundPayment(paymentReference: string): Promise<PaymentRefundResult> {
    return refundPayment(paymentReference);
  },
  refundRetryMode: "idempotent",
  requiresWebhookSignature: true,

  async resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<WebhookSessionResolution> {
    const payment = squareWebhookPayment(listing);
    if (payment === null) return null;
    const { orderId, paymentId } = payment;

    // Skip non-completed payments to avoid unnecessary API calls
    if (typeof payment.status === "string" && payment.status !== "COMPLETED") {
      logDebug(
        "Square",
        `Skipping webhook for non-completed payment (status=${payment.status})`,
      );
      return Promise.resolve("skip");
    }

    const order = await retrieveOrder(orderId);
    if (!order?.id) return "retry";
    if (!hasRequiredSessionMetadata(order.metadata)) return "skip";
    const completeOrder: CompleteSquareOrder = {
      ...order,
      id: order.id,
      metadata: order.metadata,
    };

    const resolved = await squareSessionPayment(
      {
        ...completeOrder,
        tenders: [{ paymentId }],
      },
      true,
    );
    if (resolved.status === "missing") return "retry";
    if (resolved.status === "refunded") return "skip";
    return paidSquareSession(completeOrder, resolved.payment);
  },

  /* jscpd:ignore-start -- PaymentProvider interface conformance, not
     duplication: every provider must write this exact member signature, but
     the bodies share no logic (SumUp reads its locally staged checkout;
     Square fetches the order and its payment from the API). */
  async retrieveSession(
    sessionId: string,
    mode = "callback",
  ): Promise<ValidatedPaymentSession | null> {
    /* jscpd:ignore-end */
    return retrieveSquareSession(
      sessionId,
      mode === "recovery" ? closePaymentOrder : identity,
      mode === "callback",
    );
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
