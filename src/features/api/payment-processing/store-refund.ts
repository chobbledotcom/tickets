/**
 * The keep-and-refund paths of the payment machine. When a signed-by-us payment
 * can't be honoured — a price changed, a listing was deleted, an extra sold out,
 * the event filled, or an unexpected error hit after the charge — we never drop
 * the customer: we store a quantity-0 placeholder, refund the payment, record the
 * cash round-trip in the ledger, and flag the attendee with a plain-language
 * note. A balance session settles the existing attendee instead of creating one.
 */

import {
  completePlaceholderRefund,
  noPaymentFailure,
  placeholderFailure,
} from "#routes/api/payment-processing/completion-refund.ts";
import { paymentWorkWithCompletion } from "#routes/api/payment-processing/completion-runtime.ts";
/* jscpd:ignore-start -- imports */
import {
  attendeeBaseFields,
  bookingSlot,
  type HonourResult,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { ticketPaymentFulfilmentStatements } from "#routes/api/payment-processing/fence.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  type RefundCode,
  type RefundSpec,
  refundSpec,
} from "#routes/api/payment-processing/refunds.ts";
import type {
  BookingIntent,
  PaymentFailureResult,
  PaymentResult,
  PaymentWork,
} from "#routes/api/webhook-types.ts";
import { attendeeOwedSubquery } from "#shared/accounting/projection-sql.ts";
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import { generateTicketToken } from "#shared/crypto/utils.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { paymentFulfilmentStatements } from "#shared/db/payments/claims.ts";
import {
  type BookingCompletion,
  placeholderRefundCompletion,
} from "#shared/payment-completion.ts";
import {
  type PaymentRefundOutcome,
  refundCharges,
} from "#shared/payment-runtime/refund.ts";
import type { BookingItem } from "#shared/payments.ts";

/* jscpd:ignore-end */

/** User-facing message when the outstanding balance changed mid-payment. */
const BALANCE_CHANGED_MESSAGE =
  "The outstanding balance for this booking changed while you were paying.";

const refundResult = (outcome: PaymentRefundOutcome) =>
  outcome.resolutions.find((item) => item.status !== "completed") ??
  outcome.resolutions[0];

/**
 * User-facing message when a signed-by-us payment can't be honoured (price
 * changed, charge mismatch, sold out, or an unexpected error) so the booking is
 * kept and refunded. The refund clause is appended by formatPaymentError (or the
 * refund-pending suffix below), so this just covers "we saved your details".
 */
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
  work: PaymentWork,
  completion: BookingCompletion,
): Promise<PaymentResult> => {
  const { claim, intent, payment, session } = work;
  const attendeeId = intent.balanceAttendeeId;
  if (attendeeId === undefined) {
    throw new Error(`Payment ${payment.id} has no balance attendee`);
  }
  const balanceItem = intent.items[0];
  if (balanceItem === undefined) {
    throw new Error(`Payment ${payment.id} has no balance item`);
  }
  // A balance checkout is always a single synthetic line whose price is the
  // outstanding balance it was created to clear (proof-bound: see handleBalancePost).
  const expectedAmount = balanceItem.p;
  const listingId = balanceItem.e;

  // settleAttendeeBalance posts the balance payment itself (world funds the
  // attendee, zeroing what they owed) guarded on the ledger balance, keyed to
  // this session so a webhook retry is a no-op. We only finalize the payment
  // session here, atomically with the settle.
  const finalize = await paymentFulfilmentStatements(
    claim,
    payment,
    "?",
    [attendeeId],
    [],
    completion,
    {
      args: [expectedAmount],
      sql: `${attendeeOwedSubquery(String(attendeeId))} = ?`,
    },
  );
  const settled = await settleAttendeeBalance(
    attendeeId,
    expectedAmount,
    { id: payment.id, occurredAt: businessTime(session) },
    finalize,
  );
  if (!settled.settled) {
    const outcome = await refundCharges(payment, undefined, claim);
    return {
      detail: `Balance not settled (${settled.reason}) for attendee ${attendeeId}; paid ${session.amountTotal}`,
      error: BALANCE_CHANGED_MESSAGE,
      refund: refundResult(outcome),
      status: 409,
      success: false,
    };
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
 * payment, then start its durable completion plan. The plan records the payment
 * and pending note before provider work. A pending provider refund is polled by
 * maintenance; once confirmed, the same plan adds `refund_cash`, replaces the
 * note, and logs completion. No ticket is issued.
 */
export const storeRefundedBooking = async (
  work: PaymentWork,
  bookings: PlaceholderBookings,
  spec: RefundSpec,
): Promise<PaymentFailureResult> => {
  const { intent, payment, session } = work;
  const firstBooking = bookings[0];
  if (firstBooking === undefined) {
    throw new Error(`Payment ${payment.id} has no placeholder booking`);
  }
  const listingId = firstBooking.listingId;
  const facts = {
    amount: session.amountTotal,
    listingId,
    occurredAt: businessTime(session),
    spec: {
      code: spec.code,
      detail: spec.detail,
      reason: spec.reason,
    },
  };
  const completion = placeholderRefundCompletion(
    intent,
    facts,
    session.amountTotal === 0
      ? noPaymentFailure({ facts })
      : placeholderFailure(
          { facts },
          [
            {
              amount: { amount: 0, currency: payment.expected.currency },
              status: "pending",
            },
          ],
          payment.state,
        ),
  );
  // A quantity-0 overbook insert has no capacity gate and consumes no modifier
  // stock, so it always writes the row — trust it. (If the PII can't encrypt the
  // whole system is broken; we don't defend against that.)
  const ticketToken = generateTicketToken();
  const finalize = await ticketPaymentFulfilmentStatements(
    work,
    ticketToken,
    [],
    completion,
  );
  const stored = await attendeesApi.createBookingAtomic(
    {
      ...(await attendeeBaseFields(intent)),
      allowOverbook: true,
      bookings,
      ticketToken,
    },
    { finalize, legs: [], usages: [] },
  );
  if (stored === "sold-out" || !stored.success) {
    throw new Error(
      `Could not store refund placeholder for payment ${payment.id}`,
    );
  }
  const firstAttendee = stored.attendees[0];
  if (firstAttendee === undefined) {
    throw new Error(`Payment ${payment.id} stored no placeholder attendee`);
  }
  const attendeeId = firstAttendee.id;
  return completePlaceholderRefund(
    paymentWorkWithCompletion(work, attendeeId, completion, []),
    undefined,
    "critical",
  );
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
): RefundSpec =>
  refundSpec(FAILURE_REFUND_CODES[failure.reason])(failure.detail);
