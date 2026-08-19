/**
 * The refund mechanics of the payment machine, plus the typed reasons a
 * signed-by-us payment must be refunded.
 *
 * The durable provider-refund authority issues the money-back call. This module
 * turns its answer into a handled {@link PaymentFailureResult};
 * {@link PlaceholderRefund} names *why* a booking we kept had to be refunded,
 * stamped PII-free into the ledger reversal and the attendee's system note.
 */

import { logActivity } from "#db/activity-log.ts";
/* jscpd:ignore-start -- imports */
import {
  type PreparedRefundAuthority,
  prepareRefundAuthority,
} from "#db/provider-refund-authority.ts";
import {
  type PlaceholderRefund,
  placeholderRefund,
} from "#payment/placeholder-refund.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { refundCallbackReplayIndex } from "#payment/refund-request-identity.ts";
/* jscpd:ignore-end */
import {
  paidPaymentReferenceOf,
  rejectedChargeReference,
  type SessionRejection,
} from "#payment/validated-session.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { nowMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { reportWithheldRefund } from "#shared/payment-review.ts";
import { parsePriceProof, verifyPrice } from "#shared/payment-signature.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { initialRefundState } from "#shared/provider-refunds/state.ts";
import {
  type ProviderRefundResult,
  type RefundAuthorityReceipt,
  requestProviderRefund,
} from "#shared/provider-refunds.ts";

/** User-facing message when the listing price changed between checkout and payment */
const PRICE_CHANGED_MESSAGE =
  "The price for this listing changed while you were completing payment.";

/** The diagnostic message from a failed payment result. */
export const failureDetail = (result: PaymentFailureResult): string =>
  result.detail ?? result.error;

/** The receipt a returned rejection refund carries, so the caller can post
 *  the money into the books and finish the authority's local recording. */
export type ReturnedRejectionReceipt = {
  readonly authority: RefundAuthorityReceipt;
  readonly local: "due" | "recorded";
};

/** What became of a rejected session's charge. `settled` means nothing is left
 *  owing; `refunded` means money actually moved. They are kept apart because
 *  "nothing to refund" and "refunded" must never read alike in a log or on a
 *  page — one leaves the buyer out of pocket, the other does not. */
export type RejectionOutcome = {
  settled: boolean;
  refunded: boolean;
  returned: ReturnedRejectionReceipt | null;
};

/** Nothing of ours was captured, so there is nothing to return. */
const NOTHING_TO_REFUND: RejectionOutcome = {
  refunded: false,
  returned: null,
  settled: true,
};

/**
 * Refund a paid charge the provider boundary could not read, when its
 * reference is usable. A blank-reference rejection names no charge to refund.
 */
export const refundRejectedCharge = async (
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
  // The verified proof establishes ownership, but the refund amount comes from a
  // fresh provider read: malformed charges may have captured a different sum.
  const result = await requestProviderRefund({
    callbackSessionId: rejection.sessionId,
    evidence: { kind: "read_provider" },
    mode: "send",
    reference: rejectedChargeReference(rejection),
  });
  const refunded = providerRefundReturned(result);
  return {
    refunded,
    returned:
      result.kind === "returned"
        ? { authority: result.authority, local: result.local }
        : null,
    settled: refunded,
  };
};

type RefundLogContext = {
  listingId?: number | undefined;
  provider: TaggedPaymentReference["provider"];
};

/** Report the durable outcome without treating an armed request as returned. */
export const providerRefundReturned = (
  result: ProviderRefundResult,
  { listingId, provider }: RefundLogContext = {
    provider: result.reference.provider,
  },
): boolean => {
  if (result.kind === "withheld") {
    reportWithheldRefund(result.admission, { listingId, provider });
    return false;
  }
  if (result.kind === "returned") {
    logDebug("Payment", "Refund completed");
    return true;
  }
  if (result.kind === "pending") {
    logDebug("Payment", "Refund sent and awaiting provider confirmation");
    return false;
  }
  if (result.kind === "changed") {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Refund authority changed before money could be sent through ${provider}`,
      listingId,
    });
    return false;
  }
  if (result.kind === "unchanged") {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Refund was only observed for ${provider} payment`,
      listingId,
    });
    return false;
  }
  if (result.kind === "needs_provider_check") {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Refund needs another provider check for ${provider} payment`,
      listingId,
    });
    return false;
  }
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail:
      result.kind === "ready"
        ? `Refund was not sent for ${provider} payment; its durable request remains ready`
        : `Refund needs an owner decision for ${provider} payment (${result.reason})`,
    listingId,
  });
  return false;
};

const sessionRefundFacts = (session: ValidatedPaymentSession) => ({
  callbackSessionId: session.id,
  captured: { amount: session.amountTotal, currency: session.currency },
  reference: paidPaymentReferenceOf(session),
});

const sessionRefundTarget = (session: ValidatedPaymentSession) => {
  const facts = sessionRefundFacts(session);
  return {
    callbackSessionId: facts.callbackSessionId,
    evidence: {
      captured: facts.captured,
      kind: "validated_callback",
    },
    mode: "send",
    reference: facts.reference,
  } as const;
};

/** Prepare the ready authority a callback must own before it becomes terminal. */
export const prepareSessionRefundAuthority = async (
  session: ValidatedPaymentSession,
): Promise<PreparedRefundAuthority> => {
  const facts = sessionRefundFacts(session);
  const now = nowMs();
  return await prepareRefundAuthority({
    callbackReplayIndex: await refundCallbackReplayIndex(
      facts.reference.provider,
      facts.callbackSessionId,
    ),
    captured: facts.captured,
    now,
    reference: facts.reference,
    state: await initialRefundState(facts.reference, now),
  });
};

/** Ask the one durable authority to refund a validated callback session. */
export const requestSessionRefund = (
  session: ValidatedPaymentSession,
): Promise<ProviderRefundResult> =>
  requestProviderRefund(sessionRefundTarget(session));

/** Attempt refund and log activity if successful */
const refundAndLog = async (
  session: ValidatedPaymentSession,
  error: string,
  listingId: number,
): Promise<boolean> => {
  const result = await requestSessionRefund(session);
  const refunded = providerRefundReturned(result, {
    listingId,
    provider: session.provider,
  });
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
  return refundAndFail(session, validation.error, listingId, validation.status);
};

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

/** A payment the provider charged for a different amount than our signed total. */
export const chargeMismatchSpec = (
  session: ValidatedPaymentSession,
  agreed: number,
): PlaceholderRefund =>
  placeholderRefund("charge_mismatch")(chargedVsSigned(session, agreed));

/** A signed booking whose listing was deleted between checkout and payment:
 *  nothing left to honour, but we keep a quantity-0 ghost so the customer (and
 *  their refund) is never lost. */
export const deletedListingSpec = (
  session: ValidatedPaymentSession,
): PlaceholderRefund =>
  placeholderRefund("listing_removed")(
    `Listing not found for a signed session (session=${session.id})`,
  );
