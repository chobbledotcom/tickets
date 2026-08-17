/**
 * Finish a stored placeholder's refund and money records — on the first
 * delivery and on any later one.
 *
 * The atomic store writes the ghost, its held claim, the refund authority,
 * and a conservative "refund being arranged" outcome together. Everything
 * after that — sending the refund, posting the ledger legs, recording the
 * authority, the note, releasing the row, advancing the stored outcome — is
 * a tail of idempotent steps. This module owns that tail once: the fresh
 * flow runs it right after the store, and a redelivery whose stored outcome
 * carries the completion marker rebuilds the same work from durable rows and
 * runs it again from wherever a crash stopped it.
 */

import { sortStrings, unique } from "#fp";
/* jscpd:ignore-start -- imports */
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import {
  completePlaceholderMoney,
  type PlaceholderMoneyTarget,
} from "#routes/api/payment-processing/placeholder-completion.ts";
import {
  providerRefundReturned,
  requestSessionRefund,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import { createSystemNote } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  type AnchorRowWork,
  loadAnchorRowWork,
} from "#shared/db/payment-anchor/held-work.ts";
import {
  type PaymentRowRecord,
  paymentRowsWith,
  type RowSettlement,
  settleAttendeeRows,
} from "#shared/db/payment-claim.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { advanceSessionFailure } from "#shared/db/processed-payments.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  assertJointStateLegal,
  authorityFactOf,
  jointRowFactOf,
} from "#shared/payment/joint-state.ts";
import {
  type PlaceholderRefund,
  placeholderRefund,
  placeholderRefundNote,
} from "#shared/payment/placeholder-refund.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  type RefundClaim,
  type StoredPaymentFailure,
  sessionAnswerOf,
} from "#shared/payment/row-state.ts";
import { paidPaymentReferenceOf } from "#shared/payment/validated-session.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger/placeholder.ts";

/* jscpd:ignore-end */

/**
 * User-facing message when a signed-by-us payment can't be honoured (price
 * changed, charge mismatch, sold out, or an unexpected error) so the booking
 * is kept and refunded. The refund clause is appended by formatPaymentError
 * (or the refund-pending suffix below), so this just covers "we saved your
 * details".
 */
const BOOKING_SAVED_MESSAGE =
  "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.";

export interface PlaceholderFailureResult extends PaymentFailureResult {
  readonly status: 200;
}

export const placeholderFailure = (
  spec: PlaceholderRefund,
  refunded: boolean,
): PlaceholderFailureResult => ({
  detail: spec.detail,
  error: refunded
    ? BOOKING_SAVED_MESSAGE
    : `${BOOKING_SAVED_MESSAGE} Your refund is being arranged — please contact us if it does not arrive.`,
  ...(refunded ? { refunded: true } : {}),
  status: 200,
  success: false,
});

/** The stored form of a placeholder outcome: the replayed answer plus the
 * marker naming the refund reason, so a later delivery can finish and label
 * the money records exactly as the first one would have. */
export const storedPlaceholderOutcome = (
  spec: PlaceholderRefund,
  refunded: boolean,
): StoredPaymentFailure => ({
  completion: { code: spec.code },
  ...sessionAnswerOf(placeholderFailure(spec, refunded)),
});

/** Rebuild the exact settlement a stored claim's holder would have used, so
 * the release matches the fence a crashed run left on the row. */
export const settlementForHeldClaim = (
  sessionId: string,
  claim: RefundClaim,
): RowSettlement => ({
  commandId: claim.commandId,
  heldSince: claim.writtenAt,
  rows: new Map([[sessionId, { claim: "release", phase: claim.phase }]]),
});

/** One name per attendee-and-charges pair, so every run that reaches the
 * unreturned note writes the same name and only the first insert lands. */
const unreturnedNoteKey = (work: PlaceholderMoneyTarget): string =>
  JSON.stringify([
    work.attendeeId,
    sortStrings(unique([...work.referenceIndexes])),
  ]);

/** The refund did not come back: land the payment leg so the books show the
 * money in, tell the operator once, and let go of the row. The refund itself
 * stays with the durable authority's recovery routes. */
const recordUnreturnedRefund = async (
  session: ValidatedPaymentSession,
  work: PlaceholderMoneyTarget,
): Promise<void> => {
  await recordPlaceholderRefund(
    {
      amount: session.amountTotal,
      attendeeId: work.attendeeId,
      eventId: work.sessionId,
      listingId: work.listingId,
      occurredAt: work.occurredAt,
    },
    work.spec.code,
    false,
  );
  logError({
    code: ErrorCode.PAYMENT_REFUND,
    detail: `Stored-but-unrefunded booking ${work.attendeeId} (${work.spec.code}): ${work.spec.detail}`,
    listingId: work.listingId,
  });
  await createSystemNote(
    attendeeNotes(work.attendeeId),
    placeholderRefundNote(work.attendeeId, work.spec, false),
    { key: unreturnedNoteKey(work), purpose: "refund_unreturned" },
  );
  await settleAttendeeRows(work.settlement);
};

/**
 * Drive a stored placeholder's refund to its recorded end: ask the durable
 * authority (idempotent — an already-sent refund answers from its own row),
 * finish the money records for a returned one, or record the payment leg and
 * park the refund with its recovery routes for anything else. Ends by
 * advancing the stored outcome, so replays tell the buyer what really
 * happened.
 */
export const finishPlaceholderRefund = async (
  session: ValidatedPaymentSession,
  work: PlaceholderMoneyTarget,
): Promise<PlaceholderFailureResult> => {
  const refundResult = await requestSessionRefund(session);
  const refunded = providerRefundReturned(refundResult, {
    listingId: work.listingId,
    provider: session.provider,
  });
  if (refundResult.kind === "returned") {
    // The money came back: finish its records through the shared, resumable
    // completion. A ledger miss keeps the row saying "unrecorded" rather
    // than failing the buyer's answer — the refresh route finishes it.
    await completePlaceholderMoney({
      activityMessage: `Automatic refund (${work.spec.code}); booking kept at quantity 0`,
      amount: session.amountTotal,
      attendeeId: work.attendeeId,
      dueAuthority:
        refundResult.local === "due" ? refundResult.authority : null,
      listingId: work.listingId,
      occurredAt: work.occurredAt,
      onLedgerMiss: "mark_unrecorded",
      referenceIndexes: work.referenceIndexes,
      sessionId: work.sessionId,
      settlement: work.settlement,
      spec: work.spec,
    });
  } else {
    await recordUnreturnedRefund(session, work);
  }
  await advanceSessionFailure(
    work.sessionId,
    storedPlaceholderOutcome(work.spec, false),
    storedPlaceholderOutcome(work.spec, refunded),
  );
  return placeholderFailure(work.spec, refunded);
};

/** One payment's anchor rows with the single held claim picked out. */
export interface HeldAnchorSearch {
  readonly held: {
    readonly claim: RefundClaim;
    readonly record: PaymentRowRecord;
  } | null;
  readonly rows: readonly AnchorRowWork[];
}

/**
 * The one anchor row still holding a claim for this payment. More than one
 * held anchor is a state no flow can mint — log it and resume nothing rather
 * than guess which money work to finish.
 */
export const findHeldAnchor = async (
  payment: TaggedPaymentReference,
  sessionId: string,
): Promise<HeldAnchorSearch> => {
  const rows = await loadAnchorRowWork(payment);
  const held = paymentRowsWith(
    rows.map((row) => row.record),
    (state) => state.claim,
  );
  if (held.length > 1) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail: `Placeholder resume found ${held.length} held anchors for session ${sessionId}`,
    });
    return { held: null, rows };
  }
  const first = held[0];
  return {
    held:
      first === undefined ? null : { claim: first.value, record: first.row },
    rows,
  };
};

/**
 * A redelivered session whose stored outcome may carry the completion
 * marker: finish whatever tail is still open and answer with the result.
 * Null means there is nothing to finish — the caller replays the stored
 * outcome exactly as it is. Unmarked outcomes cost no extra reads.
 */
export const resumePlaceholderSession = async (
  data: ValidatedSession,
  stored: StoredPaymentFailure,
): Promise<PaymentResult | null> => {
  const marker = stored.completion;
  if (marker === undefined) return null;
  const { session } = data;
  const spec = placeholderRefund(marker.code)(
    `Resumed after a crashed delivery of session ${session.id}`,
  );
  const search = await findHeldAnchor(
    paidPaymentReferenceOf(session),
    session.id,
  );
  // A resume navigates a combination of machines a crash left behind, so
  // prove the combination is one a flow can produce before acting on it.
  assertJointStateLegal(
    jointRowFactOf(
      search.held !== null
        ? { claim: search.held.claim, outcome: stored }
        : { outcome: stored },
      false,
    ),
    search.rows.length === 0
      ? ["absent"]
      : search.rows.map((row) => authorityFactOf(row.refundStateName)),
    `resume of session ${session.id}`,
  );
  if (search.held !== null) {
    const { claim, record } = search.held;
    return await finishPlaceholderRefund(session, {
      attendeeId: record.attendeeId,
      listingId: data.intent.items[0]!.e,
      // The session's own business time — the same instant every fresh
      // delivery posts, so a resumed leg replays instead of conflicting.
      occurredAt: businessTime(session),
      referenceIndexes: [
        await paymentReferenceIndex(paidPaymentReferenceOf(session)),
      ],
      sessionId: session.id,
      settlement: settlementForHeldClaim(record.sessionId, claim),
      spec,
    });
  }
  // No held claim: the tail is done except, possibly, the final words — a
  // crash between the release and the advance leaves the pending outcome on
  // a refund the durable authority knows completed.
  if (stored.refunded === true) return null;
  if (!search.rows.some((row) => row.refundStateName === "completed")) {
    return null;
  }
  const final = storedPlaceholderOutcome(spec, true);
  await advanceSessionFailure(session.id, stored, final);
  return { ...sessionAnswerOf(final), success: false };
};
