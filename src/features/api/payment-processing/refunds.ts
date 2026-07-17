/**
 * The refund mechanics of the payment machine, plus the typed reasons a
 * signed-by-us payment must be refunded.
 *
 * `tryRefund` and friends issue the money-back call and turn it into a handled
 * {@link PaymentFailureResult}; {@link RefundSpec} names why a staged booking
 * had to be refunded and stamps that reason into the ledger reversal.
 */

/* jscpd:ignore-start */
import type {
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { markSessionFailed } from "#shared/db/processed-payments.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";

/* jscpd:ignore-end */

/** User-facing message when the listing price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this listing changed while you were completing payment.";

/**
 * Resolve the active payment provider. When none is configured, log a
 * structured error with the caller's code/detail and return null, so each
 * caller can pick its own fallback (a false, a 400, ...).
 */
export const getPaymentProviderOrLog = async (
  code: ErrorCodeType,
  detail: string,
  listingId?: number,
): Promise<Awaited<ReturnType<typeof getActivePaymentProvider>>> => {
  const provider = await getActivePaymentProvider();
  if (!provider) logError({ code, detail, listingId });
  return provider;
};

/**
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
export const tryRefund = async (
  paymentReference: string,
  listingId?: number,
): Promise<boolean> => {
  if (!paymentReference) return false;

  const provider = await getPaymentProviderOrLog(
    ErrorCode.PAYMENT_REFUND,
    "No payment provider configured for refund",
    listingId,
  );
  if (!provider) return false;

  if (await provider.refundPayment(paymentReference)) {
    logDebug("Payment", "Refund issued");
    return true;
  }

  // A false return can simply mean the payment was ALREADY fully refunded: each
  // provider rejects a second full refund (Stripe errors on an already-refunded
  // intent; Square and SumUp reject a re-refund), and that rejection surfaces
  // here as false. That is success, not failure — the money is back with the
  // customer — so confirm via the provider's refund-status query before
  // reporting failure. Without this, a redelivery after a recovered refund would
  // loop on a 503 retry for money already returned.
  if (await provider.isPaymentRefunded(paymentReference)) {
    logDebug("Payment", "Payment already fully refunded");
    return true;
  }

  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Failed to refund payment ${paymentReference}`,
    listingId,
  });
  return false;
};

/** Attempt refund and log activity if successful */
const refundAndLog = async (
  session: ValidatedPaymentSession,
  error: string,
  listingId: number,
): Promise<boolean> => {
  const refunded = await tryRefund(session.paymentReference, listingId);
  if (refunded) {
    await logActivity(`Automatic refund: ${error}`, listingId);
  }
  return refunded;
};

/**
 * Refund the session and return a handled-failure PaymentResult. The single
 * refund-and-fail shape shared by post-payment failures (validation, price
 * mismatch, balance mismatch) so the refundAndLog + 409/410 result block isn't
 * re-spelled at each site.
 */
export const refundAndFail = async (
  session: ValidatedPaymentSession,
  message: string,
  listingId: number,
  status: number | undefined,
  detail?: string,
): Promise<PaymentFailureResult> => {
  const refunded = await refundAndLog(session, message, listingId);
  const failure: PaymentFailureResult = {
    detail,
    error: message,
    refunded,
    status,
    success: false,
  };
  // Provider and database writes cannot share one transaction. If this write
  // fails, the caller releases the reservation; retry confirms the provider
  // already refunded before storing the same terminal result.
  if (refunded) await markSessionFailed(session.id, failure);
  return failure;
};

/**
 * Handle listing validation failure: skip refund for unknown listings (404)
 * since the webhook may be intended for a different instance sharing the same
 * payment provider account. For known-listing failures (inactive, closed),
 * refund so the customer gets their money back.
 */
export const validationFailure = (
  _session: ValidatedPaymentSession,
  validation: { error: string; status?: number },
  _listingId: number,
): PaymentFailureResult => ({
  error: validation.error,
  status: validation.status,
  success: false,
});

/** Log a price mismatch and refund the session */
const priceMismatchRefund = (
  session: ValidatedPaymentSession,
  detail: string,
  listingId: number,
): Promise<PaymentResult> =>
  refundAndFail(session, PRICE_CHANGED_MESSAGE, listingId, 409, detail);

/** The internal log line for a charge that didn't match our signed total. */
const chargedVsSigned = (
  session: ValidatedPaymentSession,
  agreed: number,
): string =>
  `Provider charged ${session.amountTotal} but signed total was ${agreed}`;

/**
 * Refund a session the provider charged for an amount other than our signed
 * total. Defers the alert so a slow ntfy never delays the money.
 */
export const refuseMismatch = (
  session: ValidatedPaymentSession,
  agreed: number,
  listingId: number,
): Promise<PaymentResult> => {
  addPendingWork(sendNtfyError(ErrorCode.WEBHOOK_PRICE_SIGNATURE));
  return priceMismatchRefund(
    session,
    chargedVsSigned(session, agreed),
    listingId,
  );
};

/**
 * Why a signed-by-us payment must be refunded even though we can't just drop it.
 * `code` is a PII-free reason stamped into the ledger reversal; `reason` is the
 * operator-facing phrase; `detail` is the internal log line (ids/prices, never
 * PII); `notify` optionally pages an alert.
 */
export type RefundSpec = {
  code: string;
  reason: string;
  detail: string;
  error?: string;
  notify?: ErrorCodeType;
  status?: number | undefined;
};

/**
 * Every reason we keep-and-refund a signed booking, as one table: the
 * operator-facing reason, plus (where the failure means a broken promise rather
 * than plain bad luck) the alert to page. Unexpected
 * errors and removed listings page because someone should look; a full event
 * or a sold-out extra is normal operation.
 */
const REFUND_REASONS = {
  capacity_full: { reason: "the event filled up while they were paying" },
  charge_mismatch: {
    notify: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
    reason: "the amount charged did not match the agreed total",
  },
  listing_removed: {
    notify: ErrorCode.PAYMENT_SESSION,
    reason: "the listing was removed while they were paying",
  },
  price_changed: {
    reason: "the listing price changed while they were paying",
  },
  sold_out: {
    reason: "an add-on or extra they chose sold out while they were paying",
  },
  unexpected_error: {
    notify: ErrorCode.PAYMENT_SESSION,
    reason: "an unexpected error stopped the booking being completed",
  },
} as const satisfies Record<string, { reason: string; notify?: ErrorCodeType }>;

export type RefundCode = keyof typeof REFUND_REASONS;

/** Build the RefundSpec for a reason code: the table supplies the note phrase
 *  and any alert, the caller supplies the internal log line (ids/prices, never
 *  PII). */
export const refundSpec =
  (code: RefundCode) =>
  (detail: string): RefundSpec => ({
    code,
    detail,
    ...REFUND_REASONS[code],
  });

/** A payment the provider charged for a different amount than our signed total. */
export const chargeMismatchSpec = (
  session: ValidatedPaymentSession,
  agreed: number,
): RefundSpec =>
  refundSpec("charge_mismatch")(chargedVsSigned(session, agreed));

/** A signed booking whose listing was deleted between checkout and payment has
 * nothing left to honour, so its staged payment must be refunded. */
export const deletedListingSpec = (
  session: ValidatedPaymentSession,
): RefundSpec =>
  refundSpec("listing_removed")(
    `Listing not found for a signed session (session=${session.id})`,
  );
