/** The zero-total / payments-disabled reservation: one atomic write that
 * commits the booking, its modifier stock, its ledger legs, and the buyer's
 * answers. Split from `ticket-payment.ts`, which owns the paid flow. */

import { formatAtomicError } from "#booking/form.ts";
import type { TicketListing } from "#booking/model.ts";
import { requirePublicStatusId } from "#db/attendee-statuses.ts";
import type { ChildAllocation } from "#db/attendee-types.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import type { ModifierUsage } from "#db/modifier-usage.ts";
import { bookedAnswersTail } from "#db/questions/attendee-answers/at-booking.ts";
import {
  groupListingAnswerSets,
  prepareAttendeeAnswerSave,
} from "#db/questions/attendee-answers/save.ts";
import type { ListingAnswerMaps } from "#routes/public/ticket-form.ts";
import { refusedOrderItem } from "#shared/attendee-failures.ts";
/* jscpd:ignore-start */
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import { bookingBatchPlan } from "#shared/checkout-complete.ts";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
/* jscpd:ignore-end */
import type { EmailEntry } from "#shared/email.ts";
import { nowIso } from "#shared/now.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import type { ContactInfo } from "#types";

type FreeReservationParams = {
  /** The order's per-path checkout lines ({@link buildOrderLines}) — each
   * becomes its own booking row carrying its package and its charged amount. */
  items: CheckoutItem[];
  listings: TicketListing[];
  contact: ContactInfo;
  date: string | null;
  dayCount?: number;
  paidByItem?: Map<CheckoutItem, number> | undefined;
  remainingBalance?: number | undefined;
  /** Modifier stock to consume in the create transaction. Amounts are zeroed when
   *  payments are disabled — stock is still capped, nothing is charged. */
  modifierUsages: ModifierUsage[];
  /** Priced order to post to the ledger, or null to skip it (payments disabled —
   *  no money to record). Lets a zero-total free booking record the same
   *  sale/discount/balance legs a paid one would. */
  ledgerOrder: PricedOrder | null;
  /** Per-(child, parent) allocations from the fold: when present,
   * `createFreeReservation` expands each child booking into one row per
   * allocation instead of one summed row, giving each row its real
   * `parentListingId`. Absent for legacy/no-parent orders. */
  allocations?: ChildAllocation[] | undefined;
  /** The submission's per-listing answers, keyed by `String(listing.id)`.
   * When present they are saved inside the same atomic boundary as the
   * booking, so a failing answers write rolls the reservation back. */
  listingAnswers?: ListingAnswerMaps;
};

type FreeReservationResult =
  | { success: true; token: string; entries: EmailEntry[] }
  | { success: false; error: string };

/** User-facing message when a chosen add-on or discount sold out during a
 * zero-total completion (no provider, so the webhook path's "while completing
 * payment" wording doesn't apply). */
const MODIFIER_SOLD_OUT_MESSAGE =
  "An extra you selected sold out while you were checking out. Please try again.";

/** A zero priced order: a free booking that consumes modifier stock but posts no
 *  legs (payments disabled) builds its batch plan from this — no lines, so
 *  mapBooking yields no legs while the modifier stock is still consumed. */
const EMPTY_PRICED_ORDER: PricedOrder = {
  extras: [],
  fullSubtotal: 0,
  lines: [],
  modifierApplications: [],
  total: 0,
};

export const createFreeReservation = async ({
  items,
  listings,
  contact,
  date,
  dayCount = 1,
  paidByItem,
  remainingBalance = 0,
  modifierUsages,
  ledgerOrder,
  allocations,
  listingAnswers,
}: FreeReservationParams): Promise<FreeReservationResult> => {
  const listingById = new Map(
    listings.map((info) => [info.listing.id, info.listing]),
  );
  const finalBookings = bookingsForOrder(
    { allocations, date, dayCount },
    checkoutBookingLines(items, listingById, paidByItem),
  );
  // The answers ride the same atomic boundary as the booking. One submission
  // creates one attendee, so every booked line's answers reduce to one set
  // keyed by a placeholder the boundary resolves from the batch's ticket
  // token; the free text is encrypted here, before the boundary opens.
  const answersTail =
    listingAnswers === undefined
      ? undefined
      : bookedAnswersTail(
          await prepareAttendeeAnswerSave(
            groupListingAnswerSets(
              finalBookings.map((booking) => ({
                attendee: { id: 0 },
                listing: { id: booking.listingId },
              })),
              listingAnswers.answerIds,
              listingAnswers.textAnswers,
            ),
          ),
          finalBookings.map((booking) => booking.listingId),
        );
  // When there are legs to post or stock to consume, commit the booking, its
  // modifier stock, and its sale legs as ONE batch (exactly as the paid webhook
  // does) — never an interactive transaction held open across a read-per-leg. The
  // free path has no payment session, so the ledger event is keyed on a fresh
  // unique id (attendee-id-independent, so the legs are built before the attendee
  // exists) and no session is finalized; a sold-out modifier rolls the whole batch
  // back. A plain booking with neither legs nor stock has no plan, so it writes as
  // a single capacity-checked batch (createAttendeeAtomic) — concurrent free
  // submissions never contend on the one connection.
  const statusId = await requirePublicStatusId();
  const input = {
    ...contact,
    bookings: finalBookings,
    remainingBalance,
    statusId,
  };
  const result =
    ledgerOrder !== null || modifierUsages.length > 0
      ? await attendeesApi.createBookingAtomic(
          input,
          await bookingBatchPlan(modifierUsages, {
            eventId: crypto.randomUUID(),
            occurredAt: nowIso(),
            pricedOrder: ledgerOrder ?? EMPTY_PRICED_ORDER,
          }),
          answersTail,
        )
      : await attendeesApi.createAttendeeAtomic(input, undefined, answersTail);
  if (result === "sold-out") {
    return { error: MODIFIER_SOLD_OUT_MESSAGE, success: false };
  }

  if (!result.success) {
    const namedItem = refusedOrderItem(
      items,
      (item) => item.listingId,
      result.listingIds,
    );
    return {
      error: formatAtomicError(result.reason, namedItem.name),
      success: false,
    };
  }
  const { attendees } = result;

  const entries: EmailEntry[] = attendees.map((attendee) => ({
    attendee,
    listing: listingById.get(attendee.listing_id)!,
  }));
  return {
    entries,
    success: true,
    token: attendees[0]!.ticket_token,
  };
};
