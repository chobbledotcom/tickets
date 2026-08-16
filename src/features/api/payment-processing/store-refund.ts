/**
 * The keep-and-refund paths of the payment machine. When a signed-by-us payment
 * can't be honoured — a price changed, a listing was deleted, an extra sold out,
 * the event filled, or an unexpected error hit after the charge — we never drop
 * the customer: we store a quantity-0 placeholder, refund the payment, record the
 * cash round-trip in the ledger, and flag the attendee with a plain-language
 * note. A balance session settles the existing attendee instead of creating one.
 */

import type { ResultSet } from "@libsql/client";
/* jscpd:ignore-start -- imports */
import {
  type AttendeeBaseFields,
  attendeeBaseFields,
  bookingSlot,
  type HonourResult,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import { completePlaceholderMoney } from "#routes/api/payment-processing/placeholder-completion.ts";
import {
  prepareSessionRefundAuthority,
  providerRefundReturned,
  refundAndFail,
  requestSessionRefund,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  PaymentFailureResult,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { attendeePaymentProvenance } from "#shared/db/attendees/payment-provenance.ts";
import type { SqlStatement } from "#shared/db/client.ts";
import { createSystemNote } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import { prepareClaimedAttendeePaymentAnchor } from "#shared/db/payment-anchor/attendee.ts";
import { settleAttendeeRows } from "#shared/db/payment-claim.ts";
import { balanceFinalizeStatements } from "#shared/db/payment-finalize.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import type { PreparedSessionFailure } from "#shared/db/processed-payments.ts";
import { prepareSessionFailure } from "#shared/db/processed-payments.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import {
  type PlaceholderRefund,
  placeholderRefund,
  placeholderRefundNote,
  type RefundAlert,
  type RefundCode,
} from "#shared/payment/placeholder-refund.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import type { StoredPaymentFailure } from "#shared/payment/row-state.ts";
import { paidPaymentReferenceOf } from "#shared/payment/validated-session.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger/placeholder.ts";
import { requireValue } from "#shared/required-value.ts";

/* jscpd:ignore-end */

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

interface PlaceholderFailureResult extends PaymentFailureResult {
  readonly status: 200;
}

const placeholderFailure = (
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

const storedFailureOf = (
  failure: PlaceholderFailureResult,
): StoredPaymentFailure => ({
  error: failure.error,
  ...(failure.refunded === undefined ? {} : { refunded: failure.refunded }),
  status: failure.status,
});

const REFUND_ALERT_CODES: Record<RefundAlert, ErrorCodeType> = {
  payment_session: ErrorCode.PAYMENT_SESSION,
  webhook_price_signature: ErrorCode.WEBHOOK_PRICE_SIGNATURE,
};

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
  typeof attendeesApi.createAttendeeAtomic
>[0]["bookings"];

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
      paidPaymentReferenceOf(session),
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

/**
 * Keep a signed-by-us booking we can't honour rather than dropping it into limbo:
 * store it as a quantity-0 placeholder (overbook-tolerant, so capacity — or a
 * since-deleted listing — can never downgrade the store into a drop), refund the
 * payment, record the cash round-trip in the ledger (a `payment` + `refund_cash`
 * with NO `sale` leg, so the placeholder recognises no revenue and its projected
 * price_paid stays 0), and flag the attendee with a plain-language system note
 * carrying a non-sensitive reason code. The provider reference stays in
 * owner-key payment storage. The customer is told their details were saved and
 * the payment refunded; no ticket is issued.
 *
 * We never report `refunded: false`. The booking now exists, so a retry must NOT
 * re-create it — an un-refunded payment is recorded as a terminal, operator-
 * resolved outcome (the note's manual-refund instruction stands) rather than
 * released for re-processing.
 */
/** The claimed anchor a stored placeholder hands back for its follow-up
 * money work. */
type ClaimedPlaceholderAnchor = Awaited<
  ReturnType<
    Awaited<
      ReturnType<typeof prepareClaimedAttendeePaymentAnchor>
    >["forAttendee"]
  >
>;

/**
 * Store the quantity-0 ghost with its claimed anchor, provenance, terminal
 * outcome, and any extra statement, in one transaction. A quantity-0
 * overbook insert has no capacity gate and consumes no modifier stock, so
 * it always writes the row — trust it. (If the PII can't encrypt the whole
 * system is broken; we don't defend against that.) The caller does its
 * money work afterwards and then settles the anchor's born claim.
 */
export const storeClaimedPlaceholder = async (config: {
  readonly bookings: PlaceholderBookings;
  readonly extra?: {
    readonly require: (result: ResultSet) => void;
    readonly statement: SqlStatement;
  };
  readonly fields: AttendeeBaseFields;
  readonly paymentReference: TaggedPaymentReference;
  readonly sessionFailure: PreparedSessionFailure;
  readonly sessionId: string;
}): Promise<{
  readonly attendeeId: number;
  readonly claimedAnchor: ClaimedPlaceholderAnchor;
}> => {
  const paymentAnchor = await prepareClaimedAttendeePaymentAnchor(
    config.paymentReference,
  );
  const anchorWritten = Promise.withResolvers<ClaimedPlaceholderAnchor>();
  const stored = await attendeesApi.createAttendeeAtomic(
    { ...config.fields, allowOverbook: true, bookings: config.bookings },
    async (tx, attendeeId) => {
      const claimedAnchor = await paymentAnchor.forAttendee(attendeeId);
      const results = await tx.batch([
        claimedAnchor.statement,
        attendeePaymentProvenance.statement(claimedAnchor.sessionId),
        ...(config.extra === undefined ? [] : [config.extra.statement]),
        config.sessionFailure.statement,
      ]);
      // Positional results, named at the boundary: the anchor write comes
      // first, then provenance, the optional extra, and the terminal last.
      attendeePaymentProvenance.require(
        requireValue(
          results[1],
          "Placeholder provenance write returned no result",
        ),
        claimedAnchor.sessionId,
      );
      if (config.extra !== undefined) {
        config.extra.require(
          requireValue(
            results[2],
            "Placeholder extra write returned no result",
          ),
        );
      }
      const terminalized = requireValue(
        results[results.length - 1],
        "Placeholder terminal write returned no result",
      );
      if (terminalized.rowsAffected !== 1) {
        throw new Error(
          `Payment session lost its reservation before placeholder creation: ${config.sessionId}`,
        );
      }
      anchorWritten.resolve(claimedAnchor);
    },
  );
  const attendeeId = (stored as Extract<typeof stored, { success: true }>)
    .attendees[0]!.id;
  return { attendeeId, claimedAnchor: await anchorWritten.promise };
};

export const storeRefundedBooking = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  bookings: PlaceholderBookings,
  spec: PlaceholderRefund,
  publicStatusId: number,
): Promise<PaymentFailureResult> => {
  if (spec.alert) addPendingWork(sendNtfyError(REFUND_ALERT_CODES[spec.alert]));
  const listingId = bookings[0]!.listingId;
  const pendingResult = placeholderFailure(spec, false);
  const [sessionFailure, refundAuthority] = await Promise.all([
    prepareSessionFailure(session.id, storedFailureOf(pendingResult)),
    prepareSessionRefundAuthority(session),
  ]);
  const { attendeeId, claimedAnchor } = await storeClaimedPlaceholder({
    bookings,
    extra: {
      require: (result) => refundAuthority.requireResult(result),
      statement: refundAuthority.statement,
    },
    fields: attendeeBaseFields(
      session.paymentReference,
      intent,
      publicStatusId,
    ),
    paymentReference: paidPaymentReferenceOf(session),
    sessionFailure,
    sessionId: session.id,
  });
  const refundResult = await requestSessionRefund(session);
  const refunded = providerRefundReturned(refundResult, {
    listingId,
    provider: session.provider,
  });
  if (refundResult.kind === "returned") {
    // The money came back: finish its records through the shared, resumable
    // completion. A ledger miss keeps the row saying "unrecorded" rather
    // than failing the buyer's 200 answer — the refresh route finishes it.
    await completePlaceholderMoney({
      activityMessage: `Automatic refund (${spec.code}); booking kept at quantity 0`,
      amount: session.amountTotal,
      attendeeId,
      dueAuthority:
        refundResult.local === "due" ? refundResult.authority : null,
      listingId,
      occurredAt: businessTime(session),
      onLedgerMiss: "mark_unrecorded",
      referenceIndexes: [
        await paymentReferenceIndex(paidPaymentReferenceOf(session)),
      ],
      sessionId: session.id,
      settlement: claimedAnchor.settlement,
      spec,
    });
  } else {
    // Nothing returned: the payment leg still lands so the books show the
    // money in, the refund stays with its recovery routes, and the note
    // tells the operator the refund is still being arranged.
    await recordPlaceholderRefund(
      {
        amount: session.amountTotal,
        attendeeId,
        eventId: session.id,
        listingId,
        occurredAt: businessTime(session),
      },
      spec.code,
      false,
    );
    logError({
      code: ErrorCode.PAYMENT_REFUND,
      detail: `Stored-but-unrefunded booking ${attendeeId} (${spec.code}): ${spec.detail}`,
      listingId,
    });
    await createSystemNote(
      attendeeNotes(attendeeId),
      placeholderRefundNote(attendeeId, spec, false),
    );
    await settleAttendeeRows(claimedAnchor.settlement);
  }
  const result = placeholderFailure(spec, refunded);
  await sessionFailure.replace(storedFailureOf(result));
  // Status 200: a fully-handled terminal outcome (booking kept, money returned or
  // flagged). The webhook acks it (never the 409 transient-lock retry nor a 503
  // refund retry — the booking exists, so a retry can't re-create it), and the
  // customer sees an informational "saved your details" message.
  return result;
};

/** The refund reason code for each way a booking we tried can fail. */
const FAILURE_REFUND_CODES: Record<
  Extract<HonourResult, { ok: false }>["reason"],
  RefundCode
> = {
  capacity_exceeded: "capacity_full",
  sold_out: "sold_out",
  unexpected_error: "unexpected_error",
};

/** The placeholder refund reason for a booking we tried but couldn't honour. */
export const specForFailure = (
  failure: Extract<HonourResult, { ok: false }>,
): PlaceholderRefund =>
  placeholderRefund(FAILURE_REFUND_CODES[failure.reason])(failure.detail);
