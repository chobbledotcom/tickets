/**
 * Turn a validated, correctly-priced session into a real attendee. Create the
 * attendee plus its per-listing bookings atomically, finalize the payment
 * session in the same batch, and persist the answers the buyer gave. Every
 * failure here is *structured* (never a refund) so the caller can keep a
 * quantity-0 placeholder instead of dropping a paid customer.
 */

/* jscpd:ignore-start */
import { lineGroupId } from "#booking/signed-metadata.ts";
import type {
  AttendeeInput,
  CreateAttendeeResult,
} from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import type { BookingBatchPlan } from "#db/attendees/create-batch.ts";
import {
  decryptSessionTokens,
  type ProcessedPayment,
} from "#db/processed-payments.ts";
import { requiredMapValue } from "#fp";
import { paymentReferenceOf } from "#payment/validated-session.ts";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";
import type { ValidatedItem } from "#routes/api/payment-processing/package-pricing.ts";
import {
  orderLineTotal,
  paidByItem,
} from "#routes/api/payment-processing/pricing.ts";
import {
  type PaidBookingTail,
  paidBookingTail,
} from "#routes/api/payment-processing/tail.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
/* jscpd:ignore-end */
import { refusedOrderItem } from "#shared/attendee-failures.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
/* jscpd:ignore-start */
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
/* jscpd:ignore-end */
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import type {
  CheckoutIntent,
  ModifierSpec,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import type { ListingWithCount } from "#types";

/** The listing id + package path every booking row we build from a signed
 * line shares. The row is a fresh booking, a quantity-0 placeholder, or a
 * dateless ghost. A line's package path keeps a listing booked through two
 * paths in two distinct slots. */
export const bookingSlot = (item: BookingItem) => ({
  listingId: item.e,
  packageGroupId: lineGroupId(item) ?? 0,
});

/** The one success shape every resolved payment session returns. It carries
 *  the created or already-existing attendee (only its id — see
 *  PaymentSuccess), the listing id the redirect resolves lazily, and any
 *  ticket tokens. A fresh booking carries its token. A replay or settle
 *  carries none. Centralised so the resolve paths — fresh booking, balance
 *  settle, processed-payments replay, and ledger replay — cannot drift
 *  apart. */
export const sessionSuccess = (
  attendeeId: number,
  listingId: number,
  ticketTokens: string[] = [],
): PaymentResult => ({
  attendee: { id: attendeeId },
  listingId,
  success: true,
  ticketTokens,
});

/** Return success result for an already-processed session.
 * Accepts a finalized payment record where attendee_id is guaranteed non-null.
 * Carries the listing id (not the loaded listing): the redirect resolves it
 * lazily only when it needs a thank-you URL. A since-deleted listing is
 * still a success replay because the attendee already exists. */
export const alreadyProcessedResult = async (
  listingId: number,
  existing: ProcessedPayment & { attendee_id: number },
): Promise<PaymentResult> => {
  const decrypted = await decryptSessionTokens(existing.ticket_tokens);
  return sessionSuccess(
    existing.attendee_id,
    listingId,
    decrypted ? decrypted.split("+") : [],
  );
};

/**
 * Pair each created booking row with its listing **by listing id**, not by
 * position. `expandChildAllocations` can emit more rows than there are signed
 * items. A child chosen under two parents is one signed item but two
 * per-parent rows, plus any parent-less remainder. A positional
 * `validatedItems[i]` pairing therefore mis-aligns or reads past the end (and
 * throws). Every created row's listing is a signed item by construction, so
 * the by-id lookup is total. Mirrors the free path (`ticket-payment.ts`).
 * Exported for direct unit testing of the multi-parent count mismatch.
 */
export const pairEntriesByListing = <A extends { listing_id: number }>(
  attendees: readonly A[],
  validatedItems: readonly { listing: ListingWithCount }[],
): { attendee: A; listing: ListingWithCount }[] => {
  const listingByItemId = new Map(
    validatedItems.map((v) => [v.listing.id, v.listing]),
  );
  return attendees.map((attendee) => ({
    attendee,
    listing: requiredMapValue(
      listingByItemId,
      attendee.listing_id,
      `Listing ${attendee.listing_id} was not loaded for a created booking`,
    ),
  }));
};

/** Format a capacity failure without assuming the listing has a display name. */
const formatPostPaymentError = (name: string): string =>
  name
    ? `Sorry, ${name} sold out while you were completing payment.`
    : "Sorry, this listing sold out while you were completing payment.";

type CreatedAttendee = Extract<
  Awaited<ReturnType<typeof attendeesApi.createAttendeeAtomic>>,
  { success: true }
>["attendees"][number];

export type CreatedEntry = {
  attendee: CreatedAttendee;
  listing: ListingWithCount;
};

/**
 * The outcome of trying to honour a signed booking at the charged price. On
 * success: the created entries with the buyer's typed free texts. On failure:
 * a structured reason, never a refund — the caller keeps a quantity-0
 * placeholder.
 */
export type HonourResult =
  | {
      entries: CreatedEntry[];
      freeTexts: FreeTextAnswers | undefined;
      ok: true;
    }
  | { ok: null; error: unknown; freeTexts?: FreeTextAnswers | undefined }
  | {
      ok: false;
      reason: "sold_out" | "capacity_exceeded" | "unexpected_error";
      detail: string;
    };

/** The identity fields every stored attendee starts from: who the buyer said
 * they are, the payment that proves it, and the starting status. */
export type AttendeeBaseFields = Pick<
  BookingIntent,
  "address" | "email" | "name" | "phone" | "special_instructions"
> & {
  paymentId: string;
  statusId: number;
};

export const attendeeBaseFields = (
  paymentId: string,
  intent: BookingIntent,
  publicStatusId: number,
): AttendeeBaseFields => ({
  address: intent.address,
  email: intent.email,
  name: intent.name,
  paymentId,
  phone: intent.phone,
  special_instructions: intent.special_instructions,
  statusId: publicStatusId,
});

/**
 * Create the attendee plus per-listing bookings atomically, finalizing the
 * payment session in the SAME batch (see batchFinalizeStatements). The batch
 * sets attendee_id only when the attendee row exists. That closes the crash
 * window between a separate post-transaction finalize and the attendee
 * INSERT. The durationDays value is listing-scoped and re-read here, so the
 * stored range always matches the listing's current duration policy.
 *
 * The batch also carries the booking's whole completion (see
 * {@link paidBookingTail}). A failure anywhere in it rolls the booking back.
 * The function returns a structured failure, never a refund.
 */
export const createAttendeeForSession = async (
  session: ValidatedPaymentSession,
  intent: BookingIntent,
  validatedItems: ValidatedItem[],
  pricingIntent: CheckoutIntent,
  pricedOrder: PricedOrder,
  ticketToken: string,
  publicStatusId: number,
  parentIdsByChild: ReadonlyMap<number, readonly number[]>,
  codeSpecs: ModifierSpec[],
): Promise<HonourResult> => {
  let prepared: {
    attendeeInput: AttendeeInput;
    plan: BookingBatchPlan;
    completion: PaidBookingTail;
  };
  try {
    // Per-line paid amounts are keyed by checkout item object, so one listing
    // booked through two paths keeps each path's own price and package.
    const paidByIntentItem = paidByItem(pricedOrder);
    const listingById = new Map(
      validatedItems.map(({ listing }) => [listing.id, listing]),
    );
    const bookings = bookingsForOrder(
      {
        allocations: intent.allocations,
        date: intent.date,
        dayCount: intent.dayCount,
      },
      checkoutBookingLines(pricingIntent.items, listingById, paidByIntentItem),
    );
    const remainingBalance =
      intent.reservationAmount === undefined
        ? 0
        : pricedOrder.fullSubtotal - orderLineTotal(pricedOrder);

    // Build every fallible input before starting the atomic write. A failure
    // here is known not to have committed, while a write failure below must be
    // checked against primary state before deciding whether to refund.
    const plan = await bookingBatchPlan(
      pricedOrder.modifierApplications,
      {
        eventId: session.id,
        occurredAt: businessTime(session),
        pricedOrder,
      },
      {
        paymentReference: paymentReferenceOf(session),
        sessionId: session.id,
      },
    );
    // A transient failure reading or decrypting the staged answers must not
    // refund a valid payment. Nothing is written yet, so the provider can
    // redeliver and the whole booking runs again. The retryable shape routes
    // through the same recovery as a failed create.
    let completion: PaidBookingTail;
    try {
      completion = await paidBookingTail({
        codeSpecs,
        intent,
        // The listings in booking-row order, the order the created entries keep.
        listings: bookings.map((booking) =>
          requiredMapValue(
            listingById,
            booking.listingId,
            `Listing ${booking.listingId} was not loaded for a created booking`,
          ),
        ),
        modifierApplications: pricedOrder.modifierApplications,
        sessionId: session.id,
      });
    } catch (error) {
      return { error, ok: null };
    }
    prepared = {
      attendeeInput: {
        ...attendeeBaseFields(session.paymentReference, intent, publicStatusId),
        bookings,
        parentIdsByChild,
        remainingBalance,
        ticketToken,
      },
      completion,
      plan,
    };
  } catch (error) {
    return {
      detail: `Unexpected error preparing session ${session.id}: ${String(
        error,
      )}`,
      ok: false,
      reason: "unexpected_error",
    };
  }
  let result: CreateAttendeeResult | "sold-out";
  try {
    result = await attendeesApi.createBookingAtomic(
      prepared.attendeeInput,
      prepared.plan,
      prepared.completion.ride,
    );
  } catch (error) {
    // The batch's outcome is unknown, but the staged free texts were read
    // before it opened. A recovery that queues the sends needs them.
    return { error, freeTexts: prepared.completion.freeTexts, ok: null };
  }
  if (result === "sold-out") {
    return {
      detail: "a chosen add-on or extra sold out during payment",
      ok: false,
      reason: "sold_out",
    };
  }

  // All-or-nothing: a capacity failure rolled the transaction back (no legs).
  if (!result.success) {
    const errorName = refusedOrderItem(
      validatedItems,
      (item) => item.listing.id,
      result.listingIds,
    ).name;
    return {
      detail: formatPostPaymentError(errorName),
      ok: false,
      reason: result.reason,
    };
  }
  const entries = pairEntriesByListing(result.attendees, validatedItems);
  return { entries, freeTexts: prepared.completion.freeTexts, ok: true };
};
