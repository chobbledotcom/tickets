/**
 * Shared booking date and duration rules — the one row shape every booking
 * surface writes. The payment flows (paid webhook, store-and-refund
 * placeholder) and the public availability/free-booking paths route through
 * here. The duration cell is the declared span table's own
 * {@link parentResolvedDuration}. A listing's range policy can never drift
 * between surfaces.
 *
 * This module is pure: callers pass the listing facts and the chosen date/day
 * count, it returns the two fields. No database, no settings.
 */

import { parentResolvedDuration } from "#booking/model.ts";
import { capacityDateFor } from "#shared/capacity-rules.ts";
import { clampDurationDays, type ListingWithCount } from "#types";

/** The listing facts the row builder reads to derive a booking's date and
 *  duration. Narrower than the full listing so the helper stays pure over the
 *  fields it actually consumes. */
export type BookingDateSource = Pick<
  ListingWithCount,
  "listing_type" | "duration_days" | "customisable_days"
>;

/**
 * Span rules, one declaration:
 *  - A `customisable_days` listing spans the chosen `dayCount`.
 *  - A non-customisable `daily` listing spans its fixed `duration_days`.
 *  - A `standard` listing spans one dateless day, with no range column.
 *
 * A missing `dayCount` still means one day. A legacy signed session without
 * `day_count` flows through the default unchanged.
 *
 * `capacityDateFor` drops the date for a standard listing, whose own cap is a
 * running total and never a per-date count.
 */
export const bookingDateFields = (
  listing: BookingDateSource,
  date: string | null,
  dayCount = 1,
): { date: string | null; durationDays: number } => ({
  date: capacityDateFor(listing.listing_type, date),
  // A legacy signed session can carry any day count, so the row clamps it
  // even though the buyer's own path has already priced it.
  durationDays: clampDurationDays(parentResolvedDuration(listing, dayCount)),
});
