/**
 * A refunded rejection gets a real Money target.
 *
 * When the payment boundary refuses a session but its charge was paid, the
 * charge is refunded. That money went out and came back, so the books must
 * say so — this module stores the same quantity-0 ghost the other
 * keep-and-refund paths use, posts the payment and refund legs under the
 * session's own event group, and lets the refund authority finish through
 * the normal recorded flow. Without it the authority sits parked in Refund
 * recovery, offering a "recorded in Money" answer with nothing to record
 * against.
 */

import { requirePublicStatusId } from "#db/attendee-statuses.ts";
import type { RowSettlement } from "#db/payment-claim.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  type ProcessedPayment,
  prepareSessionFailure,
  releaseReservation,
  reserveSession,
} from "#db/processed-payments.ts";
import { loadRefundAuthorityById } from "#db/provider-refund-authority.ts";
/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import {
  type PlaceholderRefund,
  placeholderRefund,
} from "#payment/placeholder-refund.ts";
import type { TaggedPaymentReference } from "#payment/provider-reference.ts";
import { completedAtOf } from "#payment/refund-authority-state.ts";
/* jscpd:ignore-end */
import {
  type MalformedRejection,
  rejectedChargeReference,
  type SessionRejection,
} from "#payment/validated-session.ts";
/* jscpd:ignore-start -- imports */
import { attendeeBaseFields } from "#routes/api/payment-processing/create.ts";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
import {
  findHeldAnchor,
  settlementForHeldClaim,
} from "#routes/api/payment-processing/placeholder-resume.ts";
import {
  type RejectionOutcome,
  type ReturnedRejectionReceipt,
  refundRejectedCharge,
} from "#routes/api/payment-processing/refunds.ts";
import {
  datelessGhostBookings,
  storeClaimedPlaceholder,
} from "#routes/api/payment-processing/store-refund.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { requireValue } from "#shared/required-value.ts";

/* jscpd:ignore-end */

/** What a later delivery reads back for this session; the buyer answer is
 * the refunded message below. The marker tells a replay to check that the
 * follow-up money records finished. */
const STORED_OUTCOME = {
  completion: { code: "malformed_charge" },
  error: "The payment could not be read, so it was refunded.",
  refunded: true,
  status: 400,
} as const;

/**
 * Refund a rejected paid charge and, when the money came back, persist its
 * quantity-0 ghost and Money legs so the authority records mechanically.
 */
export const settleRejectedCharge = async (
  rejection: SessionRejection,
): Promise<RejectionOutcome> => {
  const outcome = await refundRejectedCharge(rejection);
  // Only a malformed_charge rejection can carry returned money — a blank
  // reference names no charge, so refundRejectedCharge never refunds one.
  if (rejection.reason !== "malformed_charge" || outcome.returned === null) {
    return outcome;
  }
  const reservation = await reserveSession(rejection.sessionId);
  if (!reservation.reserved) {
    await resumeRejectedTarget(
      rejection,
      outcome.returned,
      reservation.existing,
    );
    return outcome;
  }
  try {
    await storeRejectedTarget(rejection, outcome.returned);
  } catch (error) {
    // A failure before the outcome is stored must give the fence back, or
    // redelivery collides with the empty hold until it goes stale. Once the
    // outcome is stored, the release matches no unresolved row and no-ops.
    await releaseReservation(rejection.sessionId);
    throw error;
  }
  return outcome;
};

/** The one completion call the fresh store and a resumed redelivery share;
 * only where the target's facts come from differs. */
const completeRejectedMoney =
  (facts: {
    readonly amount: number;
    readonly listingId: number;
    readonly reference: TaggedPaymentReference;
    readonly returned: ReturnedRejectionReceipt;
    readonly sessionId: string;
    readonly spec: PlaceholderRefund;
  }) =>
  async (target: {
    readonly attendeeId: number;
    readonly occurredAt: string;
    readonly settlement: RowSettlement;
  }): Promise<void> => {
    await completePlaceholderMoney({
      activityMessage: `Automatic refund (${facts.spec.code}); rejected payment kept at quantity 0`,
      amount: facts.amount,
      attendeeId: target.attendeeId,
      dueAuthority:
        facts.returned.local === "due" ? facts.returned.authority : null,
      listingId: facts.listingId,
      occurredAt: target.occurredAt,
      onLedgerMiss: "throw",
      referenceIndexes: [await paymentReferenceIndex(facts.reference)],
      sessionId: facts.sessionId,
      settlement: target.settlement,
      spec: facts.spec,
    });
  };

/**
 * A redelivery that lost the fence: when an earlier delivery stored the
 * target but crashed before its money records finished, the ghost's anchor
 * row still holds the claim — rebuild the completion from durable rows and
 * finish it. A fresh empty hold (racing delivery), a finalized row, or a
 * free anchor all leave nothing to resume.
 */
const resumeRejectedTarget = async (
  rejection: MalformedRejection,
  returned: ReturnedRejectionReceipt,
  existing: ProcessedPayment,
): Promise<void> => {
  if (existing.attendee_id !== null || existing.failure_data === "") return;
  const reference = rejectedChargeReference(rejection);
  const search = await findHeldAnchor(reference, rejection.sessionId);
  if (search.held === null) return;
  const { claim, record } = search.held;
  const intent = requireValue(
    extractIntentFromMetadata(rejection.metadata),
    `Resumed rejected session ${rejection.sessionId} lost its readable metadata`,
  );
  const authority = requireValue(
    await loadRefundAuthorityById(returned.authority.id),
    `Resumed rejected session ${rejection.sessionId} lost its refund authority row`,
  );
  await completeRejectedMoney({
    amount: authority.captured.amount,
    listingId: intent.items[0]!.e,
    reference,
    returned,
    sessionId: rejection.sessionId,
    // The only code this flow ever stores, so the resume needs no read to
    // rebuild it — see STORED_OUTCOME above.
    spec: placeholderRefund("malformed_charge")(
      `Resumed after a crashed delivery of session ${rejection.sessionId}`,
    ),
  })({
    attendeeId: record.attendeeId,
    // The anchor row was born carrying the instant the money came back, so
    // every resume posts the same legs the first delivery would have.
    occurredAt: requireValue(
      record.state.unrecorded,
      `Resumed rejected anchor for session ${rejection.sessionId} lost its return time`,
    ).returnedAt,
    settlement: settlementForHeldClaim(record.sessionId, claim),
  });
};

/**
 * The answer a buyer-facing callback gives for a rejected session. A charge
 * left unsettled answers 503, so the caller comes back for it rather than
 * acknowledging money that is still out there.
 */
export const answerRejectedSession = async (
  rejection: SessionRejection,
  log: (detail: string) => void,
): Promise<Response> => {
  const { refunded, settled } = await settleRejectedCharge(rejection);
  log(
    `Session rejected as ${rejection.reason} (session=${rejection.sessionId}, refunded: ${refunded})`,
  );
  return paymentErrorResponse(
    refunded
      ? t("payment.error.refunded")
      : t("payment.error.session_not_found"),
    settled ? 400 : 503,
  );
};

const storeRejectedTarget = async (
  rejection: MalformedRejection,
  returned: ReturnedRejectionReceipt,
): Promise<void> => {
  const intent = extractIntentFromMetadata(rejection.metadata);
  if (intent === null) {
    // The metadata cannot name the booking lines, so there is nothing true
    // to store. Give the row back and keep today's behavior: the authority
    // stays in Refund recovery with its owner route.
    await releaseReservation(rejection.sessionId);
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Refunded rejected session ${rejection.sessionId} has unreadable metadata; no Money target stored`,
    });
    return;
  }
  // The malformed session cannot say what was captured; the authority's own
  // provider-read money can. A returned receipt means the engine recorded a
  // full provider return, so the row's captured sum is the true round-trip.
  const authority = requireValue(
    await loadRefundAuthorityById(returned.authority.id),
    `Refunded rejected session ${rejection.sessionId} lost its refund authority row`,
  );
  // The moment the provider finished returning the money — durable on the
  // authority row before the fence, so every delivery posts the same legs.
  const returnInstant = new Date(
    requireValue(
      completedAtOf(authority.state),
      `Refunded rejected session ${rejection.sessionId} has a receipt but no completed authority`,
    ),
  ).toISOString();
  const spec = placeholderRefund("malformed_charge")(
    `Provider reported session ${rejection.sessionId} in a form the site could not read`,
  );
  const listingId = intent.items[0]!.e;
  const paymentReference = rejectedChargeReference(rejection);
  const { attendeeId, claimedAnchor } = await storeClaimedPlaceholder({
    bookings: datelessGhostBookings(intent.items),
    fields: attendeeBaseFields(
      rejection.paymentReference,
      intent,
      await requirePublicStatusId(),
    ),
    paymentReference,
    sessionFailure: await prepareSessionFailure(
      rejection.sessionId,
      STORED_OUTCOME,
    ),
    sessionId: rejection.sessionId,
    // The money is already back, so the row is born saying the books have
    // not caught up — the truth the completion below clears.
    unrecordedAt: returnInstant,
  });
  // An owner may have recorded the authority by hand between a failed store
  // and this redelivery; a recorded authority must not be recorded again. A
  // ledger miss throws: the delivery fails, the provider redelivers, and the
  // authority stays due and visible meanwhile.
  await completeRejectedMoney({
    amount: authority.captured.amount,
    listingId,
    reference: paymentReference,
    returned,
    sessionId: rejection.sessionId,
    spec,
  })({
    attendeeId,
    occurredAt: returnInstant,
    settlement: claimedAnchor.settlement,
  });
};
