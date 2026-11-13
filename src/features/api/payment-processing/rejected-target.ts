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
import {
  type ProcessedPayment,
  prepareSessionFailure,
  releaseReservation,
} from "#db/processed-payments.ts";
import { t } from "#i18n";
import { placeholderRefund } from "#payment/placeholder-refund.ts";
import { taggedPaymentReference } from "#payment/provider-reference.ts";
import { completedAtOf } from "#payment/refund-authority-state.ts";
import type {
  MalformedRejection,
  SessionRejection,
} from "#payment/validated-session.ts";
import { attendeeBaseFields } from "#routes/api/payment-processing/create.ts";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
import { loadRefundResume } from "#routes/api/payment-processing/placeholder-resume.ts";
import {
  type RejectionHandler,
  type ReturnedRejectionReceipt,
  refundRejectedCharge,
} from "#routes/api/payment-processing/refunds.ts";
import {
  completeRejectedMoney,
  readRejectedAuthority,
} from "#routes/api/payment-processing/rejected-money.ts";
import { withRejectedSession } from "#routes/api/payment-processing/rejected-session.ts";
import { settleRejectedSubscription } from "#routes/api/payment-processing/rejected-subscription.ts";
import { staffPaymentDiagnostics } from "#routes/api/payment-processing/staff-diagnostics.ts";
import {
  datelessGhostBookings,
  storeClaimedPlaceholder,
} from "#routes/api/payment-processing/store-refund.ts";
import { paymentErrorResponse } from "#routes/payment-response.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { requireValue } from "#shared/required-value.ts";

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
export const settleRejectedCharge: RejectionHandler = async (rejection) => {
  if (rejection.subscription !== undefined) {
    return settleRejectedSubscription(rejection);
  }
  const outcome = await refundRejectedCharge(rejection);
  const returned = outcome.returned;
  // Only a malformed_charge rejection can carry returned money — a blank
  // reference names no charge, so refundRejectedCharge never refunds one.
  if (rejection.reason !== "malformed_charge" || returned === null) {
    return outcome;
  }
  return withRejectedSession(rejection.sessionId, async (reservation) => {
    if (!reservation.reserved) {
      await resumeRejectedTarget(rejection, returned, reservation.existing);
    } else {
      await storeRejectedTarget(rejection, returned);
    }
    return outcome;
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
  const reference = taggedPaymentReference(
    rejection.provider,
    rejection.paymentReference,
  );
  const search = await loadRefundResume(
    reference,
    rejection.sessionId,
    (held) =>
      requireValue(
        held.record.state.unrecorded,
        `Resumed rejected anchor for session ${rejection.sessionId} lost its return time`,
      ).returnedAt,
  );
  if (search.target === null) return;
  const intent = requireValue(
    extractIntentFromMetadata(rejection.metadata),
    `Resumed rejected session ${rejection.sessionId} lost its readable metadata`,
  );
  const authority = await readRejectedAuthority(returned, rejection.sessionId);
  await completeRejectedMoney({
    authority,
    intent,
    reference,
    returned,
    sessionId: rejection.sessionId,
    // The only code this flow ever stores, so the resume needs no read to
    // rebuild it — see STORED_OUTCOME above.
    spec: placeholderRefund("malformed_charge")(
      `Resumed after a crashed delivery of session ${rejection.sessionId}`,
    ),
  })(search.target);
};

/**
 * The answer a buyer-facing callback gives for a rejected session. A charge
 * left unsettled answers 503, so the caller comes back for it rather than
 * acknowledging money that is still out there. When the caller saw a browser
 * request, an owner reading the page also gets the checkout's facts.
 */
export const answerRejectedSession = async (
  rejection: SessionRejection,
  log: (detail: string) => void,
  request?: Request,
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
    await staffPaymentDiagnostics(request, {
      sessionId: rejection.sessionId,
    }),
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
  const authority = await readRejectedAuthority(returned, rejection.sessionId);
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
  const paymentReference = taggedPaymentReference(
    rejection.provider,
    rejection.paymentReference,
  );
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
    authority,
    intent,
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
