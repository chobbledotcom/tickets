/**
 * Shared booking date and duration rules — the single definition of how a
 * booking row's `date` and `durationDays` are derived from a listing's type
 * and the buyer's chosen span. Both the payment flows (paid webhook,
 * store-and-refund placeholder) and the public availability/free-booking
 * paths route through here so a listing's range policy can never drift between
 * them.
 *
 * This module is pure: callers pass the listing facts and the chosen date/day
 * count, it returns the two fields. No database, no settings.
 */

import { capacityDateFor } from "#shared/capacity-rules.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { normalizeDurationDays } from "#shared/types.ts";

/** The listing facts the row builder reads to derive a booking's date and
 *  duration. Narrower than the full listing so the helper stays pure over the
 *  fields it actually consumes. */
export type BookingDateSource = Pick<
  ListingWithCount,
  "listing_type" | "duration_days" | "customisable_days"
>;

/**
 * Shared booking-date fields (date + durationDays).
 *
 * Span rules, one declaration:
 *  - A `customisable_days` listing spans the chosen `dayCount`.
 *  - A non-customisable `daily` listing spans its fixed `duration_days`.
 *  - A `standard` listing spans one dateless day (no range column).
 *
 * `dayCount` defaults to `1`, and {@link normalizeDurationDays} clamps
 * non-finite input back to `1`, so a genuinely optional `dayCount` (a legacy
 * signed session without `day_count`, modelled as `undefined` on
 * `BookingIntent`) flows through that default unchanged — missing day count
 * still means one day. `capacityDateFor` drops the date for date-less
 * (standard) listings whose own cap is a running total, never a per-date
 * count.
 */
export const bookingDateFields = (
  listing: BookingDateSource,
  date: string | null,
  dayCount = 1,
): { date: string | null; durationDays: number } => ({
  date: capacityDateFor(listing.listing_type, date),
  durationDays: listing.customisable_days
    ? normalizeDurationDays(dayCount)
    : listing.listing_type === "daily"
      ? normalizeDurationDays(listing.duration_days)
      : 1,
});
