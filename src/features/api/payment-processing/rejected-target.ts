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

import { attendeeBaseFields } from "#routes/api/payment-processing/create.ts";
import { extractIntentFromMetadata } from "#routes/api/payment-processing/metadata.ts";
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
import { logActivity } from "#shared/db/activity-log.ts";
import { requirePublicStatusId } from "#shared/db/attendee-statuses.ts";
import { createSystemNote } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { settleAttendeeRows } from "#shared/db/payment-claim.ts";
import {
  prepareSessionFailure,
  releaseReservation,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { loadRefundAuthorityById } from "#shared/db/provider-refund-authority.ts";
import { t } from "#shared/i18n.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sameMoney } from "#shared/payment/money.ts";
import {
  placeholderRefund,
  placeholderRefundNote,
} from "#shared/payment/placeholder-refund.ts";
import type { SessionRejection } from "#shared/payment/validated-session.ts";
import { recordProviderRefunds } from "#shared/provider-refunds.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger/placeholder.ts";

/** What a later delivery reads back for this session; the buyer answer is
 * the refunded message below. */
const STORED_OUTCOME = {
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
  if (outcome.returned === null) return outcome;
  if (rejection.reason !== "malformed_charge") {
    throw new Error("A blank-reference rejection cannot have returned money");
  }
  await persistRejectedTarget(rejection, outcome.returned);
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

const persistRejectedTarget = async (
  rejection: Extract<SessionRejection, { reason: "malformed_charge" }>,
  returned: ReturnedRejectionReceipt,
): Promise<void> => {
  const reservation = await reserveSession(rejection.sessionId);
  if (!reservation.reserved) {
    // A stored outcome means an earlier delivery already made the target;
    // a fresh empty hold means a racing delivery is making it right now.
    return;
  }
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
  // provider-read money can, and a completed return must be the whole sum.
  const authority = await loadRefundAuthorityById(returned.authority.id);
  if (
    authority === null ||
    !sameMoney(authority.captured, authority.refunded)
  ) {
    throw new Error(
      `Refunded rejected session ${rejection.sessionId} does not show a full provider return`,
    );
  }
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
    paymentReference: {
      kind: "tagged",
      provider: rejection.provider,
      reference: rejection.paymentReference,
    },
    sessionFailure: await prepareSessionFailure(
      rejection.sessionId,
      STORED_OUTCOME,
    ),
    sessionId: rejection.sessionId,
  });
  const recording = await recordPlaceholderRefund(
    {
      amount: authority.captured.amount,
      attendeeId,
      eventId: rejection.sessionId,
      listingId,
      occurredAt: nowIso(),
    },
    spec.code,
    true,
  );
  if (recording.posted && returned.local === "due") {
    await recordProviderRefunds([returned.authority]);
  }
  await createSystemNote(
    attendeeNotes(attendeeId),
    placeholderRefundNote(attendeeId, spec, true),
  );
  await settleAttendeeRows(claimedAnchor.settlement);
  await logActivity(
    `Automatic refund (${spec.code}); rejected payment kept at quantity 0`,
    listingId,
    attendeeId,
  );
};
