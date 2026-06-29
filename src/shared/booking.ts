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
import type { LedgerPoster } from "#shared/db/attendees/create.ts";
import {
  createAttendeeAtomic,
  hasAvailableSpots,
} from "#shared/db/attendees.ts";
import { singleListingAnswerIds } from "#shared/payment-helpers.ts";
import { getActivePaymentProvider } from "#shared/payments.ts";
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
      occurredAt: new Date().toISOString(),
    });
    await postBookingLegsTx(tx, attendeeId, legs);
  };

/** Booking result — callers map this to their response format */
export type BookingResult =
  | { type: "success"; attendee: Attendee }
  | { type: "checkout"; checkoutUrl: string }
  | { type: "sold_out" }
  | { type: "checkout_failed"; error?: string }
  | {
      type: "creation_failed";
      reason: "capacity_exceeded" | "encryption_error";
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
  const needsPayment =
    (paymentsEnabled && listing.unit_price > 0) ||
    (customUnitPrice !== undefined && customUnitPrice > 0 && paymentsEnabled);

  if (needsPayment) {
    const available = await hasAvailableSpots(
      listing.id,
      quantity,
      date,
      listing.duration_days,
    );
    if (!available) return { type: "sold_out" };

    // Provider is guaranteed to exist when isPaymentsEnabled() is true
    const provider = (await getActivePaymentProvider())!;

    const unitPrice = customUnitPrice ?? listing.unit_price;
    const result = await provider.createCheckoutSession(
      {
        ...contact,
        date,
        items: [
          {
            listingId: listing.id,
            name: listing.name,
            quantity,
            slug: listing.slug,
            unitPrice,
          },
        ],
        listingAnswerIds: singleListingAnswerIds(listing.id, answerIds),
      },
      baseUrl,
    );
    if (!result) return { type: "checkout_failed" };
    if ("error" in result) {
      return { error: result.error, type: "checkout_failed" };
    }

    return { checkoutUrl: result.checkoutUrl, type: "checkout" };
  }

  // Reached when the listing is free, or when it costs money but no payment
  // provider is configured. In the latter case we still accept the booking and
  // record the full value as the amount owed — exactly like a zero-deposit
  // reservation — so nothing is collected up front but the balance is tracked.
  // The attendee starts in the public-default status, matching the web free
  // path so a balance-carrying booking is never left status-less.
  const unitPrice = customUnitPrice ?? listing.unit_price;
  const remainingBalance = paymentsEnabled
    ? 0
    : Math.max(0, unitPrice * quantity);
  const result = await createAttendeeAtomic(
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
