/**
 * Build the booking rows shared by paid and free checkout completion.
 * Checkout items keep each listing path separate, while the order details add
 * dates, parent allocations, and inherited package paths.
 */

import {
  soleParentPackageIds,
  stampChildRowPackages,
} from "#booking/page-packages.ts";
import type { ChildAllocation, ListingBooking } from "#db/attendee-types.ts";
import { expandChildAllocations } from "#db/attendees/order-parents.ts";
import { requiredMapValue } from "#fp";
import {
  type BookingDateSource,
  bookingDateFields,
} from "#shared/booking-date-fields.ts";
import type { CheckoutItem } from "#shared/payments.ts";

type BookingLine = {
  listingId: number;
  packageGroupId: number;
  quantity: number;
  listing: BookingDateSource;
  pricePaid?: number;
};

type BookingOrder = {
  date: string | null;
  dayCount?: number | undefined;
  allocations?: ChildAllocation[] | undefined;
};

/** Get the item's paid amount when this checkout carries paid amounts. Pricing
 * has no line for an existing zero-unit signed item, so only that amount may be
 * absent. */
const paidAmountForOrNull = <T extends CheckoutItem>(
  item: T,
  paidByItem: ReadonlyMap<T, number> | undefined,
): number | undefined => {
  if (paidByItem === undefined) return;
  const amount = paidByItem.get(item);
  if (amount === undefined && item.quantity !== 0) {
    throw new Error(
      `Paid amount for listing ${item.listingId} was not loaded for checkout`,
    );
  }
  return amount;
};

/** Turn checkout items into booking lines using their loaded listings and paid
 * amounts. A missing lookup means the checkout data is incomplete, so it fails
 * before any booking write starts. */
export const checkoutBookingLines = <T extends CheckoutItem>(
  items: readonly T[],
  listingById: ReadonlyMap<number, BookingDateSource>,
  paidByItem?: ReadonlyMap<T, number>,
): BookingLine[] =>
  items.map((item) => {
    const pricePaid = paidAmountForOrNull(item, paidByItem);
    return {
      listing: requiredMapValue(
        listingById,
        item.listingId,
        `Listing ${item.listingId} was not loaded for checkout`,
      ),
      listingId: item.listingId,
      packageGroupId: item.packageGroupId ?? 0,
      ...(pricePaid !== undefined ? { pricePaid } : {}),
      quantity: item.quantity,
    };
  });

/** Apply an order's date and parent allocations to its booking lines. Input
 * order is kept. Allocated children expand in allocation order, with any
 * standalone remainder last, and split prices keep their exact total. */
export const bookingsForOrder = (
  { allocations, date, dayCount }: BookingOrder,
  lines: readonly BookingLine[],
): ListingBooking[] => {
  const bookings: ListingBooking[] = lines.map((line) => ({
    listingId: line.listingId,
    packageGroupId: line.packageGroupId,
    quantity: line.quantity,
    ...bookingDateFields(line.listing, date, dayCount),
    ...(line.pricePaid !== undefined ? { pricePaid: line.pricePaid } : {}),
  }));
  return stampChildRowPackages(
    allocations && allocations.length > 0
      ? expandChildAllocations(bookings, allocations)
      : bookings,
    soleParentPackageIds(lines),
  );
};
