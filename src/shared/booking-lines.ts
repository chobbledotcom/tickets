import {
  soleParentPackageIds,
  stampChildRowPackages,
} from "#shared/booking/page-packages.ts";
import { lineGroupId } from "#shared/booking/signed-metadata.ts";
import { bookingDateFields } from "#shared/booking-date-fields.ts";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { expandChildAllocations } from "#shared/db/attendees/order-parents.ts";
import type { BookingIntent, BookingItem } from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";

type BookingLine = {
  item: BookingItem;
  listing: ListingWithCount;
  pricePaid?: number;
};

type BookingLineIntent = Pick<
  BookingIntent,
  "allocations" | "date" | "dayCount" | "items"
>;

export type OrderBooking = ListingBooking & {
  date: string | null;
  durationDays: number;
  quantity: number;
};

/** Build the final per-path booking rows shared by checkout staging and paid
 * activation. Quantities stay desired here; staging maps them to zero last. */
export const orderBookings = (
  lines: BookingLine[],
  intent: BookingLineIntent,
): OrderBooking[] => {
  const raw: OrderBooking[] = lines.map(({ item, listing, pricePaid }) => {
    const dates = bookingDateFields(listing, intent.date, intent.dayCount);
    return {
      ...dates,
      listingId: item.e,
      packageGroupId: lineGroupId(item),
      ...(pricePaid === undefined ? {} : { pricePaid }),
      quantity: item.q,
    };
  });
  return stampChildRowPackages(
    intent.allocations && intent.allocations.length > 0
      ? expandChildAllocations(raw, intent.allocations)
      : raw,
    soleParentPackageIds(
      intent.items.map((item) => ({
        listingId: item.e,
        packageGroupId: lineGroupId(item),
      })),
    ),
  );
};
