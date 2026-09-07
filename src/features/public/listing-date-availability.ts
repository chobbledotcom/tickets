/**
 * The `/listings` date filter's per-listing availability: ONE capacity
 * snapshot over the union of daily listing cards and package members,
 * whatever their booking spans. Each listing's result reads only its own
 * span's prefix of that snapshot, so the widest-span read answers the page
 * and adding packages adds no database round trips.
 */

import {
  loadCapacitySnapshot,
  remainingFromSnapshot,
} from "#db/attendees/capacity/snapshot.ts";
import { requiredMapValue, uniqueBy } from "#fp";
import { getBookableStartDates } from "#shared/dates.ts";
import { clampDurationDays, type Holiday, type ListingWithCount } from "#types";

/** The booked span a daily listing's card availability is judged over: a
 * customisable listing offers per-day starts (the span is chosen later), a
 * fixed daily listing books its whole duration. */
export const cardSpanDays = (listing: ListingWithCount): number =>
  listing.customisable_days ? 1 : clampDurationDays(listing.duration_days);

/** The daily listings NOT bookable on `date`: outside their bookable calendar,
 * or without capacity for their span starting that day. One snapshot per
 * request answers every span in play. */
export const loadDailyDateAvailability = async (
  daily: readonly ListingWithCount[],
  date: string,
  holidays: readonly Holiday[],
): Promise<ReadonlySet<number>> => {
  const rows = uniqueBy((listing: ListingWithCount) => listing.id)([...daily]);
  if (rows.length === 0) return new Set();
  const widestSpan = Math.max(...rows.map(cardSpanDays));
  const snapshot = await loadCapacitySnapshot([...rows], date, widestSpan);
  const remaining = remainingFromSnapshot(snapshot, rows, cardSpanDays);
  return new Set(
    rows
      .filter(
        (listing) =>
          !getBookableStartDates(listing, [...holidays]).includes(date) ||
          // The snapshot answers every row it was loaded for, so a missing
          // entry would be a capacity-reader bug, not a bookable listing.
          requiredMapValue(remaining, listing.id, "Missing date availability") <
            1,
      )
      .map((listing) => listing.id),
  );
};
