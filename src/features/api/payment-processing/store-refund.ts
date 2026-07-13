/**
 * The keep-and-refund paths of the payment machine. When a signed-by-us payment
 * can't be honoured — a price changed, a listing was deleted, an extra sold out,
 * the event filled, or an unexpected error hit after the charge — we never drop
 * the customer: we store a quantity-0 placeholder, refund the payment, record the
 * cash round-trip in the ledger, and flag the attendee with a plain-language
 * note. A balance session settles the existing attendee instead of creating one.
 */

import {
  attendeeBaseFields,
  bookingSlot,
  type HonourResult,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  type RefundCode,
  type RefundSpec,
  refundAndFail,
  refundedNoteText,
  refundSpec,
  tryRefund,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  BookingIntent,
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { CreateAttendeeSuccess } from "#shared/db/attendee-types.ts";
import { createAttendeeAtomic } from "#shared/db/attendees/api.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { contactFields } from "#shared/db/attendees/pii.ts";
import { updateAttendeePII } from "#shared/db/attendees/update.ts";
import {
  type CheckoutStage,
  getCheckoutStageOrNull,
  markCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { balanceFinalizeStatement } from "#shared/db/payment-finalize.ts";
import { createSystemNote } from "#shared/db/system-notes.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import type { BookingItem, ValidatedPaymentSession } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import {
  type PlaceholderRefundFacts,
  recordPlaceholderRefund,
} from "#shared/refund-ledger.ts";

/** User-facing message when the outstanding balance changed mid-payment. */
const BALANCE_CHANGED_MESSAGE =
  "The outstanding balance for this booking changed while you were paying.";

/**
 * User-facing message when a signed-by-us payment can't be honoured (price
 * changed, charge mismatch, sold out, or an unexpected error) so the booking is
 * kept and refunded. The refund clause is appended by formatPaymentError (or the
 * refund-pending suffix below), so this just covers "we saved your details".
 */
const BOOKING_SAVED_MESSAGE =
  "We couldn't complete your booking, so we've saved your details and a member of our team can help you rebook.";

/** The quantity-0, money-free booking lines for a stored-but-refunded placeholder
 *  — one per validated item, carrying the listing's current date range so the
 *  ghost still sits on the right day, and each line's package path so a listing
 *  booked through two paths keeps two distinct slots (identical slots would be
 *  refused as duplicates and crash the store-and-refund). */
export const placeholderBookings = (
  validatedItems: ValidatedItem[],
  intent: BookingIntent,
) =>
  validatedItems.map(({ item, listing }) => ({
    ...bookingSlot(item),
    pricePaid: 0,
    quantity: 0,
    ...bookingDateFields(listing, intent.date, intent.dayCount),
  }));

/** Quantity-0 ghost rows for a since-deleted listing: no date fields, because
 * the listing row is gone and there is nothing left to derive a range from. Used
 * per SIGNED LINE so a multi-item cart's deleted line is named with its package
 * path rather than collapsed onto the first listing. */
export const datelessGhostBookings = (items: readonly BookingItem[]) =>
  items.map((item) => ({ ...bookingSlot(item), pricePaid: 0, quantity: 0 }));

type PlaceholderBookings = Parameters<
  typeof createAttendeeAtomic
>[0]["bookings"];

/** The money facts of a kept-but-unhonoured booking, read off its session:
 * what the provider charged, whose record holds it, and the session id that
 * keys the ledger event group. Shared by every keep-and-record path. */
const placeholderFacts = (
  session: ValidatedPaymentSession,
  attendeeId: number,
  listingId: number,
): PlaceholderRefundFacts => ({
  amount: session.amountTotal,
  attendeeId,
  eventId: session.id,
  listingId,
  occurredAt: businessTime(session),
});

/** Write the provider's payment reference into a kept staged record's stored
 * details (rewriting the same contact fields staging wrote from this same
 * signed intent), so the record's payment panel can find the charge. Every
 * terminal outcome that keeps a staged record for a charged session stamps
 * this — without it the operator has no in-app view of the money. Also used by
 * the ledger-heal path, which repairs a crash that lost the stamp after the
 * money legs were already posted. */
export const stampStagedPaymentId = (
  stage: CheckoutStage,
  session: ValidatedPaymentSession,
  intent: BookingIntent,
): Promise<void> =>
  updateAttendeePII(stage.attendeeId, {
    ...contactFields(intent),
    lat: "",
    lng: "",
    payment_id: session.paymentReference,
    ticket_token: stage.ticketToken,
  });

/** The facts identifying a charge held against a staged record: the paid
 * session, its signed intent, the staged attendee, and the listing the money is
 * for. These four always travel together into the money-posting helper. */
type HeldStagedCharge = {
  session: ValidatedPaymentSession;
  intent: BookingIntent;
  stage: CheckoutStage;
  listingId: number;
};

/** Stamp the held charge's payment reference onto the staged record, then post
 * its money to the ledger — the `payment` leg, plus `refund_cash` when the money
 * went back. Shared by both paid-but-not-ticketed terminal paths (a mid-payment
 * close and a mid-payment edit conflict) so neither can post one without the
 * other. A failed ledger write is a system fault, not part of the outcome: it
 * throws so the caller leaves the stage pending and the provider's next delivery
 * re-runs the whole path (a settled refund reads back as refunded, so a retry
 * never moves money twice). */
const recordHeldStagedMoney = async (
  { session, intent, stage, listingId }: HeldStagedCharge,
  memo: string,
  refunded: boolean,
): Promise<void> => {
  const { posted } = await recordPlaceholderRefund(
    placeholderFacts(session, stage.attendeeId, listingId),
    memo,
    refunded,
  );
  if (!posted) {
    throw new Error(
      `Could not record session ${session.id}'s money in the ledger`,
    );
  }
  // Stamp the payment reference only AFTER the money is in the ledger: a failed
  // post throws above, leaving the still-pending stage with no reference for the
  // Actions tab to expose a mid-flight refund against.
  await stampStagedPaymentId(stage, session, intent);
};

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
    [
      await balanceFinalizeStatement(
        sessionId,
        attendeeId,
        expectedAmount,
        session.paymentReference,
      ),
    ],
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

/**
 * Keep a signed-by-us booking we can't honour rather than dropping it into limbo:
 * store it as a quantity-0 placeholder (overbook-tolerant, so capacity — or a
 * since-deleted listing — can never downgrade the store into a drop), refund the
 * payment, record the cash round-trip in the ledger (a `payment` + `refund_cash`
 * with NO `sale` leg, so the placeholder recognises no revenue and its projected
 * price_paid stays 0), and flag the attendee with a plain-language system note
 * carrying the reason and the provider's payment reference. The customer is told
 * their details were saved and the payment refunded; no ticket is issued.
 *
 * We never report `refunded: false`. The booking now exists, so a retry must NOT
 * re-create it — an un-refunded payment is recorded as a terminal, operator-
 * resolved outcome (the note's manual-refund instruction stands) rather than
 * released for re-processing.
 */
export const storeRefundedBooking = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  bookings: PlaceholderBookings,
  spec: RefundSpec,
): Promise<PaymentFailureResult> => {
  if (spec.notify) addPendingWork(sendNtfyError(spec.notify));
  // Resolved here, not taken as a parameter, so no failure path can forget the
  // session was staged and mint a duplicate placeholder beside the staged one.
  const stage = await getCheckoutStageOrNull(session.id);
  const listingId = bookings[0]!.listingId;
  // A quantity-0 overbook insert has no capacity gate and consumes no modifier
  // stock, so it always writes the row — trust it. (If the PII can't encrypt the
  // whole system is broken; we don't defend against that.)
  const attendeeId = stage
    ? stage.attendeeId
    : (
        (await createAttendeeAtomic({
          ...(await attendeeBaseFields(session, intent)),
          allowOverbook: true,
          bookings,
        })) as CreateAttendeeSuccess
      ).attendees[0]!.id;
  const refunded = await tryRefund(session.paymentReference, listingId);
  const { posted } = await recordPlaceholderRefund(
    placeholderFacts(session, attendeeId, listingId),
    spec.code,
    refunded,
  );
  // A failed ledger post on a STAGED order must retry, not resolve: throw so the
  // stage stays pending and the provider's next delivery re-posts (tryRefund
  // reads the settled refund back as success, so it never refunds twice). The
  // no-stage path can't retry without minting a duplicate placeholder, so it
  // proceeds — postWithoutThrowing has already logged the miss.
  if (!posted && stage) {
    throw new Error(
      `Could not record session ${session.id}'s placeholder money in the ledger`,
    );
  }
  // Stamp the payment reference only AFTER the money is recorded, so a failed
  // post never leaves a refundable reference on a still-pending stage — the
  // Actions tab would otherwise offer to refund a charge the ledger hasn't seen.
  if (stage) await stampStagedPaymentId(stage, session, intent);
  if (refunded) {
    await logActivity(
      `Automatic refund (${spec.code}); booking kept at quantity 0`,
      listingId,
      attendeeId,
    );
  } else {
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Stored-but-unrefunded booking ${attendeeId} (${spec.code}): ${spec.detail}`,
      listingId,
    });
  }
  await createSystemNote(
    attendeeId,
    refundedNoteText(attendeeId, spec, refunded, session.paymentReference),
  );
  // The stage resolves LAST — after the refund attempt and the ledger/note
  // writes — so a throw anywhere above leaves it pending and the redelivery
  // re-runs the whole path (tryRefund reads an already-settled refund as
  // success, so a retry never refunds twice). A crash between the ledger post
  // and this line is healed by the next delivery's orphaned-ledger answer,
  // which resolves the leftover pending stage (resolvePendingStage).
  if (stage) await markCheckoutStage(session.id);
  // Status 200: a fully-handled terminal outcome (booking kept, money returned or
  // flagged). The webhook acks it (never the 409 transient-lock retry nor a 503
  // refund retry — the booking exists, so a retry can't re-create it), and the
  // customer sees an informational "saved your details" message.
  return {
    detail: spec.detail,
    error: refunded
      ? BOOKING_SAVED_MESSAGE
      : `${BOOKING_SAVED_MESSAGE} Your refund is being arranged — please contact us if it does not arrive.`,
    ...(refunded ? { refunded: true } : {}),
    status: 200,
    success: false,
  };
};

/** Every honour failure that is safe to refund. "stage_active" is deliberately
 * excluded: its rows may be a live booking, so the money must wait for the
 * operator ({@link stagedConflict}) — the type makes routing it here an error. */
export type RefundableFailure = Extract<HonourResult, { ok: false }> & {
  reason: Exclude<
    Extract<HonourResult, { ok: false }>["reason"],
    "stage_active"
  >;
};

/** The refund reason code for each way a booking we tried can fail: a sold-out
 *  extra reads differently from a full event, the broken-system
 *  encryption_error we don't special-case is treated as "the event filled up",
 *  and changed staged lines (still all quantity 0, so nothing is live) read as
 *  "the booking changed". */
const FAILURE_REFUND_CODES: Record<RefundableFailure["reason"], RefundCode> = {
  capacity_exceeded: "capacity_full",
  encryption_error: "capacity_full",
  sold_out: "sold_out",
  stage_mismatch: "order_changed",
};

/** The placeholder refund reason for a booking we tried but couldn't honour. */
export const specForFailure = (failure: RefundableFailure): RefundSpec =>
  refundSpec(FAILURE_REFUND_CODES[failure.reason])(failure.detail);

/**
 * After a known-listing validation failure refunds a session (closed or
 * deactivated mid-payment — the refund happened in validateAllItems), resolve
 * the stage: mark it failed and leave the usual refunded-booking note on the
 * staged attendee, which IS the operator's record of the order. Without this
 * the stage stayed "pending", which both hid the story from the operator and
 * held the staged PII shielded from the prune for as long as the payment row
 * lived. A session with no stage passes through unchanged.
 */
export const failStagedValidation = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  listingId: number,
  result: PaymentFailureResult,
): Promise<PaymentFailureResult> => {
  const stage = await getCheckoutStageOrNull(session.id);
  if (!stage) return result;
  // A refund that FAILED must stay retryable: the reservation is released and
  // the provider's next delivery re-attempts it. Resolving the stage here
  // would make that retry hit the resolved-stage guard and answer "already
  // processed" without ever refunding — so the stage only resolves once the
  // money is actually back.
  if (result.refunded !== true) return result;
  // The staged attendee is the operator's record of the order, so its ledger
  // must show the charge and the refund that actually happened — the same
  // payment + refund_cash round-trip every other kept-and-refunded booking
  // records.
  await recordHeldStagedMoney(
    { intent, listingId, session, stage },
    "listing_closed",
    true,
  );
  await createSystemNote(
    stage.attendeeId,
    refundedNoteText(
      stage.attendeeId,
      refundSpec("listing_closed")(result.detail ?? result.error),
      true,
      session.paymentReference,
    ),
  );
  // Resolved last: a throw above leaves the stage pending, so the redelivery
  // re-runs this path (the settled refund reads back as refunded). A crash
  // between the ledger post and this line is healed by the next delivery's
  // orphaned-ledger answer (resolvePendingStage).
  await markCheckoutStage(session.id);
  return result;
};

/** What the customer reads when their paid order needs the organiser's eyes:
 * we neither issue a ticket nor promise a refund, because the operator decides. */
const NEEDS_ORGANISER_MESSAGE =
  "Your payment was received, but this booking needs to be confirmed by the organiser. Please contact them.";

/** The operator-facing note for a staged order whose rows were already given a
 * real quantity outside payment. PII-free; carries the payment reference so the
 * charge can be found in the provider dashboard. */
const stagedConflictNote = (paymentReference: string): string =>
  `This booking was changed while its payment was still being processed, so the payment could not complete automatically. The payment was NOT refunded. Please check the booking's quantities, then either confirm the booking with the customer or refund the payment manually. Payment reference: ${paymentReference} (code: stage_active).`;

/**
 * A paid session whose staged rows were already given a real quantity outside
 * the payment flow (an operator edit mid-checkout). The rows may be a live
 * booking, so this must NOT refund (money back beside a live ticket is the
 * exact failure the staged flow exists to prevent) and must NOT re-claim the
 * rows (double-counting capacity and money). Instead the money waits for the
 * operator: a loud classified error, a note on the booking's own record, and a
 * terminal handled outcome so every replay answers the same.
 */
export const stagedConflict = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  stage: CheckoutStage,
  listingId: number,
  detail: string,
): Promise<PaymentFailureResult> => {
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail,
    listingId,
  });
  await createSystemNote(
    stage.attendeeId,
    stagedConflictNote(session.paymentReference),
  );
  // The charge we hold is a money fact the operator reconciles against: stamp
  // the payment reference (so the record's payment panel and in-app refund
  // work) and post the received `payment` leg — no sale and no refund, so the
  // ledger says exactly "we hold this customer's money". Posted before the
  // stage resolves: a crash in between replays off the ledger preflight as
  // "already handled" (the conflicted rows never carry this session's event
  // group, so the leg reads as orphaned money) — never a double post, and the
  // preflight resolves the leftover pending stage (resolvePendingStage).
  await recordHeldStagedMoney(
    { intent, listingId, session, stage },
    "stage_active",
    false,
  );
  // The outcome is recorded, so the stage resolves: the operator must now be
  // ABLE to edit the record to act on the note (a pending stage blocks edits
  // and merges), and a very late redelivery answers "already processed".
  await markCheckoutStage(session.id);
  // Status 200: a recorded, operator-owned terminal outcome. The webhook acks
  // it (retrying cannot resolve a human decision), and `refunded` stays absent
  // so the customer message carries no refund promise either way.
  return {
    detail,
    error: NEEDS_ORGANISER_MESSAGE,
    status: 200,
    success: false,
  };
};
