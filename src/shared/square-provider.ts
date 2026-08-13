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
import { refundWithOneReread } from "#shared/payment/refund-attempt.ts";
import { chargeMoneyRead } from "#shared/payment/resources.ts";
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
  SessionMetadata,
  WebhookEvent,
  WebhookSessionResult,
  WebhookSetupResult,
} from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import type { SquareOrder } from "#shared/square/order.ts";
import type { SquarePayment } from "#shared/square/payment-outcomes.ts";
import { verifySquareWebhookSignature } from "#shared/square/webhook.ts";

/** How much of a Square payment has gone back, or nothing when Square's
 *  answer cannot be read. An absent total is a stated zero; one that names no
 *  amount, or a different currency from the money taken, cannot be accounted
 *  for — reading either as zero would tell the guard the buyer is still
 *  owed money that may already be back with them. */
const squareMoneyReturned = (
  refunded:
    | { amount?: bigint | undefined; currency?: string | undefined }
    | undefined,
  captured: { currency?: string | undefined } | undefined,
): bigint | null => {
  if (refunded === undefined) return 0n;
  if (captured === undefined || refunded.amount === undefined) return null;
  if (refunded.currency !== captured.currency) return null;
  return refunded.amount;
};

/** A missing payment is a genuine unpaid answer outside a completed webhook.
 * Any failed read remains loud so the request can be retried. */
const sessionPayment = async (
  paymentReference: string,
): Promise<SquarePayment | null> => {
  if (!paymentReference) return null;
  const read = await squareApi.readPayment(paymentReference);
  if (read.status === "found") return read.resource;
  if (read.status === "missing") return null;
  throw new Error(
    `Square payment could not be read (${read.status}:${read.reason})`,
  );
};

type SquareWebhookPayment = {
  id: string | null;
  orderId: string | null;
  status: unknown;
};

const webhookPaymentObject = (
  object: Record<string, unknown>,
): Record<string, unknown> => {
  const nested = object.payment;
  if (typeof nested === "object" && nested !== null) {
    return nested as Record<string, unknown>;
  }
  return object;
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const isNonCompletedStatus = (status: unknown): status is string =>
  typeof status === "string" && status !== "COMPLETED";

const minorUnitNumber = (amount: bigint | null | undefined): number | null =>
  typeof amount === "bigint" ? Number(amount) : null;

const webhookPayment = (listing: WebhookEvent): SquareWebhookPayment => {
  const object = listing.data.object;
  const payment = webhookPaymentObject(object);
  const id = textOrNull(payment.id);
  const orderId = textOrNull(payment.order_id);
  if (!id && listing.type.startsWith("payment.")) {
    throw new Error("Square payment webhook is missing id");
  }
  if (!orderId && id && payment.status === "COMPLETED") {
    throw new Error("Completed Square payment is missing order id");
  }
  return { id, orderId, status: payment.status };
};

const readSessionOrder = async (
  sessionId: string,
): Promise<SquareOrder | null> => {
  const read = await squareApi.readOrder(sessionId);
  if (read.status === "missing") {
    logDebug("Square", "Square order not found");
    return null;
  }
  if (read.status !== "found") {
    throw new Error(
      `Square order could not be read (${read.status}:${read.reason})`,
    );
  }
  return read.resource;
};

const SQUARE_APP_METADATA_FIELDS = {
  _origin: true,
  address: true,
  allocations: true,
  answer_ids: true,
  b: true,
  balance_attendee_id: true,
  date: true,
  day_count: true,
  email: true,
  items: true,
  modifiers: true,
  name: true,
  phone: true,
  price_proof: true,
  reservation_amount: true,
  site_token_index: true,
  special_instructions: true,
  text_answer_ids: true,
  thank_you_url: true,
} as const satisfies Record<keyof SessionMetadata | "b", true>;

type SquareOrderMetadata =
  | { kind: "ours"; metadata: SessionMetadata }
  | { kind: "foreign" }
  | { kind: "malformed" };

/** Distinguish ordinary Square orders from damaged app checkouts. */
const classifyOrderMetadata = (
  metadata: SquareOrder["metadata"],
): SquareOrderMetadata => {
  if (hasRequiredSessionMetadata(metadata)) {
    return { kind: "ours", metadata };
  }
  const bearsAppField = Object.keys(metadata ?? {}).some((field) =>
    Object.hasOwn(SQUARE_APP_METADATA_FIELDS, field),
  );
  return bearsAppField ? { kind: "malformed" } : { kind: "foreign" };
};

const UNUSABLE_METADATA = {
  foreign: {
    log: "Square order does not carry app metadata",
    retryCompletedWebhook: false,
  },
  malformed: {
    log: "Square order is missing required metadata fields",
    retryCompletedWebhook: true,
  },
} as const satisfies Record<
  Exclude<SquareOrderMetadata["kind"], "ours">,
  { log: string; retryCompletedWebhook: boolean }
>;

const sessionMetadata = (
  order: SquareOrder,
  paidPaymentId: string | undefined,
): SessionMetadata | null => {
  const classified = classifyOrderMetadata(order.metadata);
  if (classified.kind === "ours") return classified.metadata;
  const unusable = UNUSABLE_METADATA[classified.kind];
  if (paidPaymentId && unusable.retryCompletedWebhook) {
    throw new Error("Completed Square order is missing required metadata");
  }
  logDebug("Square", unusable.log);
  return null;
};

type SquareOrderPayment = {
  payment: SquarePayment | null;
  paymentReference: string;
};

const readOrderPayment = async (
  order: SquareOrder,
  paidPaymentId: string | undefined,
): Promise<SquareOrderPayment> => {
  const firstTenderPayment = order.tenders?.[0]?.paymentId;
  const paymentReference = paidPaymentId ?? firstTenderPayment ?? "";
  const payment = await sessionPayment(paymentReference);
  // A completed webhook must stay retryable until Square's read agrees.
  if (paidPaymentId && payment?.status !== "COMPLETED") {
    throw new Error(
      `Square payment did not read back as completed (status=${
        payment?.status ?? "unreadable"
      })`,
    );
  }
  // Never book one order's signed metadata against another order's payment.
  if (payment?.orderId !== undefined && payment.orderId !== order.id) {
    throw new Error("Square payment reports a different order");
  }
  return { payment, paymentReference };
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

  async readCharge(
    paymentReference: string,
  ): ReturnType<PaymentProvider["readCharge"]> {
    const read = await squareApi.readPayment(paymentReference);
    if (read.status !== "found") return read;
    if (read.resource.status !== "COMPLETED") {
      return { reason: "unsupported_status", status: "invalid" };
    }
    const captured = read.resource.amountMoney;
    const refunded = read.resource.refundedMoney;
    if (
      captured?.currency !== undefined &&
      refunded?.currency !== undefined &&
      captured.currency !== refunded.currency
    ) {
      return { reason: "mismatched_money", status: "invalid" };
    }
    const returned = squareMoneyReturned(refunded, captured);
    return chargeMoneyRead(captured?.amount, captured?.currency, returned);
  },
  refundCapability: "keyed",

  refundCharge: refundWithOneReread(
    (request) => squareApi.refundCharge(request),
    (reference) => squarePaymentProvider.readCharge(reference),
  ),
  requiresWebhookSignature: true,

  async resolveWebhookSession(
    listing: WebhookEvent,
  ): Promise<WebhookSessionResult> {
    const payment = webhookPayment(listing);
    if (!payment.orderId || !payment.id) return null;

    // Skip non-completed payments to avoid unnecessary API calls
    if (isNonCompletedStatus(payment.status)) {
      logDebug(
        "Square",
        `Skipping webhook for non-completed payment (status=${payment.status})`,
      );
      return "skip";
    }

    const session = await this.retrieveSession(payment.orderId, payment.id);
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
    const order = await readSessionOrder(sessionId);
    if (!order) return null;
    const metadata = sessionMetadata(order, paidPaymentId);
    if (!metadata) return null;

    // A webhook names the payment Square just reported COMPLETED, so it wins:
    // the order's tenders can lag behind it entirely, or still lead with an
    // earlier payment, and either would call this captured charge unpaid.
    const { payment, paymentReference } = await readOrderPayment(
      order,
      paidPaymentId,
    );

    // Money we can see was taken. A completed payment names its own amount, and
    // standing the order total in for it would let a short or unreadable charge
    // match the signed price and book as paid in full. Until then the order
    // total is all there is, and nothing has been captured against it.
    const paid = payment?.status === "COMPLETED";
    const charged = paid ? payment.amountMoney : order.totalMoney;
    const amountTotal = charged?.amount;
    return validatedPaymentSession({
      // A missing amount stays missing: Number(null) is 0, which the
      // boundary would accept as a real free order.
      amountTotal: minorUnitNumber(amountTotal),
      createdAt: toCanonicalIso(order.createdAt),
      currency: charged?.currency,
      id: order.id,
      metadata,
      paymentReference,
      paymentStatus: paid ? "paid" : "unpaid",
      provider: "square",
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
    return verifySquareWebhookSignature(...args);
  },
};
