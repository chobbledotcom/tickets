// effects: pure
/** Put the plan of a started subscription on the booking row it belongs to. */

import type { ListingBooking } from "#db/attendee-types.ts";
import {
  planOfStart,
  type SubscriptionStart,
} from "#shared/subscriptions/plan.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";

/** A row booked on its own: not through a package, and not as an add-on. */
const isOwnRowOf =
  (listingId: number) =>
  (booking: ListingBooking): boolean =>
    booking.listingId === listingId &&
    !booking.packageGroupId &&
    !booking.parentListingId;

/** The order's rows, with the plan on the row of the subscribed listing. The
 * checkout refuses any other shape, so a subscription that names a listing
 * the order does not book on its own contradicts the checkout. */
export const withSubscriptionPlan = (
  bookings: ListingBooking[],
  start: SubscriptionStart | undefined,
  policy: TaxPolicy,
): ListingBooking[] => {
  if (start === undefined) return bookings;
  const index = bookings.findIndex(isOwnRowOf(start.listingId));
  if (index === -1) {
    throw new Error(
      `Subscription ${start.id} names listing ${start.listingId}, which the order does not book on its own`,
    );
  }
  const subscription = planOfStart(start, policy);
  return bookings.map((booking, position) =>
    position === index ? { ...booking, subscription } : booking,
  );
};
