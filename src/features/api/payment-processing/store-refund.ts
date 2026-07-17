/**
 * The refund paths of the payment machine. When a signed-by-us payment
 * can't be honoured — a price changed, a listing was deleted, an extra sold out,
 * the event filled, or an unexpected error hit after the charge — we never drop
 * the customer: we refund the payment, record the cash round-trip and terminal
 * replay atomically, then remove the unbooked staged attendee. A balance session
 * settles the existing attendee instead of creating one.
 */

/* jscpd:ignore-start */
import {
  type HonourResult,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import {
  type RefundCode,
  type RefundSpec,
  refundAndFail,
  refundSpec,
  tryRefund,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  BookingIntent,
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { checkoutStagesApi } from "#shared/db/checkout-stages.ts";
import { balanceFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { stagedRefundLegs } from "#shared/refund-ledger.ts";

/* jscpd:ignore-end */

/** User-facing message when the outstanding balance changed mid-payment. */
const BALANCE_CHANGED_MESSAGE =
  "The outstanding balance for this booking changed while you were paying.";

/**
 * User-facing message when a signed-by-us payment cannot be honoured. The caller
 * appends whether the refund completed or support must help.
 */
const BOOKING_FAILED_MESSAGE = "We couldn't complete your booking.";

/**
 * Settle a reserved attendee's balance instead of creating a new attendee.
 *
 * Reached only for a trusted session (the mismatch verdict refunds upstream), so
 * the proof has already bound `balance_attendee_id` and the single balance line,
 * and the charge equals the signed total. The amount this checkout was created
 * for is that line's price (`items[0].p`); the settle clears the balance only if
 * the live `remaining_balance` still equals it — so a balance the owner edited,
 * or one a concurrent/stale checkout already settled, can't be cleared for the
 * wrong figure — and finalizes the session in the SAME transaction so a crash
 * between settle and finalize can't leave a paid-but-unfinalized row (which a
 * later stale-replay would wrongly refund). A mismatch refunds and returns a
 * terminal failure rather than mutating anything.
 */
export const settleBalanceSession = async (
  sessionId: string,
  session: ValidatedPaymentSession,
  intent: BookingIntent,
): Promise<PaymentResult> => {
  const attendeeId = intent.balanceAttendeeId as number;
  // A balance checkout is always a single synthetic line whose price is the
  // outstanding balance it was created to clear (proof-bound: see handleBalancePost).
  const expectedAmount = intent.items[0]!.p;
  const listingId = intent.items[0]!.e;

  // settleAttendeeBalance posts the balance payment itself (world funds the
  // attendee, zeroing what they owed) guarded on the ledger balance, keyed to
  // this session so a webhook retry is a no-op. We only finalize the payment
  // session here, atomically with the settle.
  const settled = await settleAttendeeBalance(
    attendeeId,
    expectedAmount,
    { id: sessionId, occurredAt: businessTime(session) },
    await balanceFinalizeStatements(
      sessionId,
      attendeeId,
      expectedAmount,
      session.paymentReference,
    ),
  );
  if (!settled.settled) {
    return refundAndFail(
      session,
      BALANCE_CHANGED_MESSAGE,
      listingId,
      409,
      `Balance not settled (${settled.reason}) for attendee ${attendeeId}; paid ${session.amountTotal}`,
    );
  }

  // Settle + finalize already committed atomically above. The listing (which
  // may since be deleted) is resolved lazily by the redirect for its thank-you
  // link, so we carry only its id here.
  return sessionSuccess(attendeeId, listingId);
};

/** Refund a paid staged booking that cannot be honoured. A failed provider call
 * leaves the stage in `refunding` for retry. A successful provider call records
 * the payment and reversal, stores replay data, and removes the staged attendee
 * in one database transaction. */
export const refundStagedBooking = async (
  session: ValidatedPaymentSession,
  listingId: number,
  spec: RefundSpec,
): Promise<PaymentFailureResult> => {
  if (spec.notify) addPendingWork(sendNtfyError(spec.notify));
  const stage = await checkoutStagesApi.loadByPaymentSession(session.id);
  if (!stage) throw new Error(`Checkout stage ${session.id} is missing`);
  if (stage.state === "pending") {
    await checkoutStagesApi.beginRefund(session.id);
  }
  const refunded = await tryRefund(session.paymentReference, listingId);
  if (!refunded) {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Staged refund failed for ${stage.attendeeId} (${spec.code}): ${spec.detail}`,
      listingId,
    });
    return {
      detail: spec.detail,
      error: BOOKING_FAILED_MESSAGE,
      refunded: false,
      status: 503,
      success: false,
    };
  }
  const failure = {
    error: spec.error ?? BOOKING_FAILED_MESSAGE,
    refunded: true,
    status: spec.status ?? 200,
  };
  await checkoutStagesApi.finalizeRefund({
    failure,
    legs: await stagedRefundLegs(
      {
        amount: session.amountTotal,
        attendeeId: stage.attendeeId,
        eventId: session.id,
        listingId,
        occurredAt: businessTime(session),
      },
      spec.code,
    ),
    paymentReference: session.paymentReference,
    stage: { ...stage, state: "refunding" },
  });
  await logActivity(
    `Automatic refund (${spec.code}); staged booking removed`,
    listingId,
  );
  // Status 200 acknowledges the terminal refund. A failed refund returns 503
  // above and keeps the stage retryable.
  return {
    detail: spec.detail,
    error: failure.error,
    refunded: true,
    status: failure.status,
    success: false,
  };
};

/** The refund reason code for each way a booking we tried can fail: a sold-out
 *  extra reads differently from a full event, and the broken-system
 *  encryption_error we don't special-case is treated as "the event filled up". */
const FAILURE_REFUND_CODES: Record<
  Extract<HonourResult, { ok: false }>["reason"],
  RefundCode
> = {
  capacity_exceeded: "capacity_full",
  encryption_error: "capacity_full",
  sold_out: "sold_out",
  stage_mismatch: "unexpected_error",
  unexpected_error: "unexpected_error",
};

/** The refund reason for a staged booking we tried but could not honour. */
export const specForFailure = (
  failure: Extract<HonourResult, { ok: false }>,
): RefundSpec =>
  refundSpec(FAILURE_REFUND_CODES[failure.reason])(failure.detail);
