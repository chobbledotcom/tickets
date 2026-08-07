/**
 * The refund mechanics of the payment machine, plus the typed reasons a
 * signed-by-us payment must be refunded.
 *
 * `tryRefund` and friends issue the money-back call and turn it into a handled
 * {@link PaymentFailureResult}; {@link RefundSpec} names *why* a booking we
 * kept had to be refunded, stamped PII-free into the ledger reversal and the
 * attendee's system note.
 */

import type {
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { t } from "#shared/i18n.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { isResourceId } from "#shared/payment/resource-id.ts";
import type { SessionRejection } from "#shared/payment/validated-session.ts";
import type { PaymentAttempt } from "#shared/payment-attempt.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";

/** User-facing message when the listing price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this listing changed while you were completing payment.";

/** The diagnostic message from a failed payment result. */
export const failureDetail = (result: PaymentFailureResult): string =>
  result.detail ?? result.error;

/** What became of a rejected session's charge. `settled` means nothing is left
 *  owing; `refunded` means money actually moved. They are kept apart because
 *  "nothing to refund" and "refunded" must never read alike in a log or on a
 *  page — one leaves the buyer out of pocket, the other does not. */
type RejectionOutcome = { settled: boolean; refunded: boolean };

/** Nothing of ours was captured, so there is nothing to return. */
const NOTHING_TO_REFUND: RejectionOutcome = { refunded: false, settled: true };

/**
 * Refund a paid charge the provider boundary could not read, when its
 * reference is usable. A blank-reference rejection names no charge to refund.
 */
export const refundRejectedCharge = async (
  attempt: PaymentAttempt,
  rejection: SessionRejection,
): Promise<RejectionOutcome> => {
  if (rejection.reason === "blank_reference" || !rejection.refundable) {
    return NOTHING_TO_REFUND;
  }
  // Refund only a charge we can prove is ours: the price proof in the metadata
  // is signed with this instance's key, so a session belonging to another
  // instance sharing the provider account verifies false and its charge is
  // left alone.
  const parsed = parsePriceProof(rejection.metadata.price_proof);
  if (
    parsed === null ||
    !(await verifyPrice(rejection.metadata, parsed.total, parsed.sig))
  ) {
    return NOTHING_TO_REFUND;
  }
  const refunded = await tryRefund(attempt, rejection.paymentReference);
  return { refunded, settled: refunded };
};

/**
 * The answer a buyer-facing callback gives for a rejected session. A charge
 * left unsettled answers 503, so the caller comes back for it rather than
 * acknowledging money that is still out there.
 */
export const answerRejectedSession = async (
  attempt: PaymentAttempt,
  rejection: SessionRejection,
  sessionId: string,
  log: (detail: string) => void,
): Promise<Response> => {
  const { refunded, settled } = await refundRejectedCharge(attempt, rejection);
  log(
    `Session rejected as ${rejection.reason} (session=${sessionId}, refunded: ${refunded})`,
  );
  return paymentErrorResponse(
    refunded
      ? t("payment.error.refunded")
      : t("payment.error.session_not_found"),
    settled ? 400 : 503,
  );
};

/**
 * Attempt to refund a payment. Returns true if refund succeeded, false otherwise.
 * Logs an error if refund fails.
 */
export const tryRefund = async (
  attempt: PaymentAttempt,
  paymentReference: string,
  listingId?: number,
): Promise<boolean> => {
  // A blank or whitespace-only provider resource id names no charge to refund,
  // so the refund is refused before any provider call. The provider boundary
  // already rejects a paid session with a blank id; this is the safety net for
  // a reference that reaches here from a stored or legacy row.
  if (!isResourceId(paymentReference)) return false;

  if (await attempt.refundPayment(paymentReference)) {
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
  if (await attempt.isPaymentRefunded(paymentReference)) {
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
  attempt: PaymentAttempt,
  session: ValidatedPaymentSession,
  error: string,
  listingId: number,
): Promise<boolean> => {
  const refunded = await tryRefund(
    attempt,
    session.paymentReference,
    listingId,
  );
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
  attempt: PaymentAttempt,
  session: ValidatedPaymentSession,
  message: string,
  listingId: number,
  status: number | undefined,
  detail?: string,
): Promise<PaymentFailureResult> => {
  const refunded = await refundAndLog(attempt, session, message, listingId);
  return {
    detail,
    error: message,
    refunded,
    status,
    success: false,
  };
};

/**
 * Handle listing validation failure: skip refund for unknown listings (404)
 * since the webhook may be intended for a different instance sharing the same
 * payment provider account. For known-listing failures (inactive, closed),
 * refund so the customer gets their money back.
 */
export const validationFailure = (
  attempt: PaymentAttempt,
  session: ValidatedPaymentSession,
  validation: { error: string; status?: number },
  listingId: number,
): Promise<PaymentFailureResult> | PaymentFailureResult => {
  if (validation.status === 404) {
    return {
      detail: `Post-payment listing not found (session=${session.id})`,
      error: validation.error,
      status: 404,
      success: false,
    };
  }
  return refundAndFail(
    attempt,
    session,
    validation.error,
    listingId,
    validation.status,
  );
};

/** Log a price mismatch and refund the session */
const priceMismatchRefund = (
  attempt: PaymentAttempt,
  session: ValidatedPaymentSession,
  detail: string,
  listingId: number,
): Promise<PaymentResult> =>
  refundAndFail(
    attempt,
    session,
    PRICE_CHANGED_MESSAGE,
    listingId,
    409,
    detail,
  );

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
  attempt: PaymentAttempt,
  session: ValidatedPaymentSession,
  agreed: number,
  listingId: number,
): Promise<PaymentResult> => {
  addPendingWork(sendNtfyError(ErrorCode.WEBHOOK_PRICE_SIGNATURE));
  return priceMismatchRefund(
    attempt,
    session,
    chargedVsSigned(session, agreed),
    listingId,
  );
};

/**
 * Why a signed-by-us payment must be refunded even though we can't just drop it.
 * `code` is a PII-free reason stamped into the ledger reversal and the system
 * note; `reason` is the operator-facing phrase for the note; `detail` is the
 * internal log line (ids/prices, never PII); `notify` optionally pages an alert.
 */
export type RefundSpec = {
  code: string;
  reason: string;
  detail: string;
  notify?: ErrorCodeType;
};

/**
 * Every reason we keep-and-refund a signed booking, as one table: the
 * operator-facing phrase for the system note, plus (where the failure means a
 * broken promise rather than plain bad luck) the alert to page. Unexpected
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

/** A signed booking whose listing was deleted between checkout and payment:
 *  nothing left to honour, but we keep a quantity-0 ghost so the customer (and
 *  their refund) is never lost. */
export const deletedListingSpec = (
  session: ValidatedPaymentSession,
): RefundSpec =>
  refundSpec("listing_removed")(
    `Listing not found for a signed session (session=${session.id})`,
  );

/**
 * The PII-free system note for a stored-but-refunded booking. Explains in plain
 * language what happened, carries the provider's payment reference and our reason
 * code so the charge/refund can be reconciled in the provider dashboard, and
 * links the operator to the attendee's ledger statement. No names or emails.
 */
export const refundedNoteText = (
  attendeeId: number,
  spec: RefundSpec,
  refunded: boolean,
  paymentReference: string,
): string => {
  const ledger = `[ledger](/admin/ledger/attendee/${attendeeId})`;
  // PII-free: the provider's payment reference lets the operator reconcile the
  // charge/refund in the provider dashboard; the reason code names why.
  const ref = ` Payment reference: ${paymentReference} (code: ${spec.code}).`;
  return refunded
    ? `This booking was kept at quantity 0 but its payment was refunded because ${spec.reason}.${ref} Please check the ${ledger}.`
    : `This booking was kept at quantity 0 but its payment could NOT be refunded automatically because ${spec.reason}.${ref} Please refund it manually and check the ${ledger}.`;
};
