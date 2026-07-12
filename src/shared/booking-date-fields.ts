import { capacityDateFor } from "#shared/capacity-rules.ts";
import { type ListingWithCount, normalizeDurationDays } from "#shared/types.ts";

type BookingDateListing = {
  customisable_days: boolean;
  duration_days: number;
  listing_type: ListingWithCount["listing_type"];
};

/** Resolve the date and duration stored for one booking line. */
export const bookingDateFields = (
  listing: BookingDateListing,
  date: string | null,
  dayCount: number | undefined,
): { date: string | null; durationDays: number } => ({
  date: capacityDateFor(listing.listing_type, date),
  durationDays: listing.customisable_days
    ? normalizeDurationDays(dayCount)
    : listing.listing_type === "daily"
      ? normalizeDurationDays(listing.duration_days)
      : 1,
});
