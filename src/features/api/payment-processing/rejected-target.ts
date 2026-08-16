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

/* jscpd:ignore-start -- imports */
import { attendeeBaseFields } from "#routes/api/payment-processing/create.ts";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
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
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import {
  prepareSessionFailure,
  releaseReservation,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { loadRefundAuthorityById } from "#shared/db/provider-refund-authority.ts";
import { t } from "#shared/i18n.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { placeholderRefund } from "#shared/payment/placeholder-refund.ts";
import { completedAtOf } from "#shared/payment/refund-authority-state.ts";
import {
  type MalformedRejection,
  rejectedChargeReference,
  type SessionRejection,
} from "#shared/payment/validated-session.ts";
import { requireValue } from "#shared/required-value.ts";

/* jscpd:ignore-end */

/** What a later delivery reads back for this session; the buyer answer is
 * the refunded message below. The marker tells a replay to check that the
 * follow-up money records finished. */
const STORED_OUTCOME = {
  completion: "placeholder",
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
    // A stored outcome means an earlier delivery already made the target;
    // a fresh empty hold means a racing delivery is making it right now.
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
  const { attendeeId, claimedAnchor } = await storeClaimedPlaceholder({
    bookings: datelessGhostBookings(intent.items),
    fields: attendeeBaseFields(
      rejection.paymentReference,
      intent,
      await requirePublicStatusId(),
    ),
    paymentReference: rejectedChargeReference(rejection),
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
  await completePlaceholderMoney({
    activityMessage: `Automatic refund (${spec.code}); rejected payment kept at quantity 0`,
    amount: authority.captured.amount,
    attendeeId,
    dueAuthority: returned.local === "due" ? returned.authority : null,
    listingId,
    occurredAt: returnInstant,
    onLedgerMiss: "throw",
    referenceIndexes: [
      await paymentReferenceIndex(rejectedChargeReference(rejection)),
    ],
    sessionId: rejection.sessionId,
    settlement: claimedAnchor.settlement,
    spec,
  });
};
