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
  ListingPaymentFailureResult,
  ListingValidation,
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { markSessionFailed } from "#shared/db/processed-payments.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { refundPaymentAtProvider } from "#shared/payment-refunds.ts";
import type {
  PaymentProvider,
  PaymentRefundResult,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import type { RefundCode, RefundSpec } from "#shared/refund-reasons.ts";

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
 * Attempt to refund a payment and preserve the provider's pending state.
 */
export const refundWithProvider = async (
  provider: PaymentProvider,
  paymentReference: string,
  listingId?: number,
): Promise<PaymentRefundResult> => {
  if (!paymentReference) return "failed";
  const result = await refundPaymentAtProvider(provider, paymentReference);
  if (result === "failed") {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Failed to refund payment ${paymentReference}`,
      listingId,
    });
  }
  return result;
};

export const tryRefund = async (
  paymentReference: string,
  listingId?: number,
): Promise<PaymentRefundResult> => {
  const provider = await getPaymentProviderOrLog(
    ErrorCode.PAYMENT_REFUND,
    "No payment provider configured for refund",
    listingId,
  );
  return provider
    ? refundWithProvider(provider, paymentReference, listingId)
    : "failed";
};

/** Attempt refund and log activity if successful */
const refundAndLog = async (
  session: ValidatedPaymentSession,
  error: string,
  listingId: number,
): Promise<PaymentRefundResult> => {
  const refundStatus = await tryRefund(session.paymentReference, listingId);
  if (refundStatus === "refunded") {
    await logActivity(`Automatic refund: ${error}`, listingId);
  }
  return refundStatus;
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
  const refundStatus = await refundAndLog(session, message, listingId);
  const failure: PaymentFailureResult = {
    detail,
    error: message,
    refundStatus,
    status,
    success: false,
  };
  // Provider and database writes cannot share one transaction. If this write
  // fails, the caller releases the reservation; retry confirms the provider
  // already refunded before storing the same terminal result.
  if (refundStatus === "refunded") {
    await markSessionFailed(session.id, {
      error: failure.error,
      refunded: true,
      status: failure.status,
    });
  }
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
  validation: Extract<ListingValidation, { ok: false }>,
  _listingId: number,
): ListingPaymentFailureResult => ({
  error: validation.error,
  refundCode: validation.refundCode,
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
 * `code` is a PII-free reason stamped into the ledger reversal; `detail` is the
 * internal log line (ids/prices, never PII); `notify` optionally pages an alert.
 */
/**
 * The alert for each refund reason. Unexpected errors, removed listings, and
 * charge mismatches page because someone should look; ordinary availability
 * changes do not.
 */
const REFUND_NOTIFICATIONS = {
  capacity_full: null,
  charge_mismatch: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
  listing_removed: ErrorCode.PAYMENT_SESSION,
  price_changed: null,
  registration_closed: null,
  sold_out: null,
  unexpected_error: ErrorCode.PAYMENT_SESSION,
} as const satisfies Record<RefundCode, ErrorCodeType | null>;

/** Build a refund spec from its ledger code and internal detail. */
export const refundSpec =
  (code: RefundCode) =>
  (detail: string): RefundSpec => {
    const notify = REFUND_NOTIFICATIONS[code];
    return {
      code,
      detail,
      ...(notify === null ? {} : { notify }),
    };
  };

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
