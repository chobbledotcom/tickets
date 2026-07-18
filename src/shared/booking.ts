/**
 * Shared booking logic — context-independent core used by both
 * the web UI (public.ts) and the JSON API (api.ts).
 *
 * Takes validated inputs, returns a plain result object.
 * Callers handle input parsing/validation and response formatting.
 */

import { mapBooking } from "#shared/accounting/mappers.ts";
import { postBookingLegsTx } from "#shared/checkout-complete.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { getPublicStatusId } from "#shared/db/attendee-statuses.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import type { LedgerPoster } from "#shared/db/attendees/create.ts";
import { nowIso } from "#shared/now.ts";
import { singleListingAnswerIds } from "#shared/payment-helpers.ts";
import { checkoutItem, getActivePaymentProvider } from "#shared/payments.ts";
import {
  createPaidCheckout,
  type PaidCheckoutResult,
} from "#shared/staged-checkout.ts";
import type { Attendee, ContactInfo, ListingWithCount } from "#shared/types.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";

/**
 * A {@link LedgerPoster} for a provider-less owed booking: inside the create
 * transaction, post the booking's gross `sale` leg with nothing paid, so the
 * attendee owes exactly `gross` in the ledger, and stamp the booking row's
 * `ledger_event_group` so its per-row amount-paid projection resolves the sale.
 * The single-listing API booking has no priced order, so the facts are built
 * directly — the same legs `mapBooking` would produce from one gross line.
 */
const owedBookingLedgerPoster =
  (listingId: number, gross: number): LedgerPoster =>
  async (tx, attendeeId) => {
    const legs = await mapBooking({
      amountPaid: 0,
      attendeeId,
      bookingFee: 0,
      eventId: `booking-${attendeeId}`,
      lines: [{ gross, listingId }],
      modifiers: [],
      occurredAt: nowIso(),
    });
    await postBookingLegsTx(tx, attendeeId, legs);
  };

/** True when the listing still has spots for this quantity on this date (no
 * date for a date-less listing, whose capacity is one running total). */
export const listingHasSpots = (
  listing: Pick<ListingWithCount, "id" | "duration_days">,
  quantity: number,
  date: string | null | undefined,
): Promise<boolean> =>
  attendeesApi.hasAvailableSpots(
    listing.id,
    quantity,
    date,
    listing.duration_days,
  );

/** Booking result — callers map this to their response format */
export type BookingResult =
  | PaidCheckoutResult
  | { type: "success"; attendee: Attendee }
  | {
      type: "creation_failed";
      reason: "capacity_exceeded" | "encryption_error";
    };

const processPaidBooking = async (input: {
  listing: ListingWithCount;
  contact: ContactInfo;
  quantity: number;
  date: string | null;
  baseUrl: string;
  unitPrice: number;
  answerIds?: number[] | undefined;
}): Promise<BookingResult> => {
  const { listing, contact, quantity, date, baseUrl, unitPrice, answerIds } =
    input;
  const provider = (await getActivePaymentProvider())!;
  return createPaidCheckout({
    baseUrl,
    intent: {
      ...contact,
      date,
      items: [checkoutItem(listing, quantity, unitPrice)],
      listingAnswerIds: singleListingAnswerIds(listing.id, answerIds),
    },
    provider,
  });
};

/**
 * Process a single-listing booking.
 *
 * Determines whether payment is needed, then either:
 * - Creates a checkout session (paid) or
 * - Atomically creates an attendee (free)
 */
export const processBooking = async (
  listing: ListingWithCount,
  contact: ContactInfo,
  quantity: number,
  date: string | null,
  baseUrl: string,
  customUnitPrice?: number,
  answerIds?: number[],
): Promise<BookingResult> => {
  const paymentsEnabled = isPaymentsEnabled();
  const unitPrice = customUnitPrice ?? listing.unit_price;
  const needsPayment = paymentsEnabled && unitPrice > 0;

  if (needsPayment) {
    return processPaidBooking({
      answerIds,
      baseUrl,
      contact,
      date,
      listing,
      quantity,
      unitPrice,
    });
  }

  // Reached when the listing is free, or when it costs money but no payment
  // provider is configured. In the latter case we still accept the booking and
  // record the full value as the amount owed — exactly like a zero-deposit
  // reservation — so nothing is collected up front but the balance is tracked.
  // The attendee starts in the public-default status, matching the web free
  // path so a balance-carrying booking is never left status-less.
  const remainingBalance = paymentsEnabled ? 0 : unitPrice * quantity;
  const result = await attendeesApi.createAttendeeAtomic(
    {
      ...contact,
      bookings: [
        {
          date,
          durationDays: listing.duration_days,
          listingId: listing.id,
          quantity,
        },
      ],
      remainingBalance,
      statusId: await getPublicStatusId(),
    },
    // An owed booking must record its balance in the ledger at creation, since
    // the outstanding balance projects from it: post the booking's gross sale
    // leg with nothing paid, so the attendee owes the full value (mirroring the
    // web provider-less path's ledger dual-write). A free or paid-in-full
    // booking owes nothing, so it posts no legs and runs as a plain batch.
    remainingBalance > 0
      ? owedBookingLedgerPoster(listing.id, remainingBalance)
      : undefined,
  );

  if (!result.success) {
    return { reason: result.reason, type: "creation_failed" };
  }

  await logAndNotifyRegistration([{ attendee: result.attendees[0]!, listing }]);
  return { attendee: result.attendees[0]!, type: "success" };
};
